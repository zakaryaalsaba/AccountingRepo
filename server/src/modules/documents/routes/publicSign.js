import { Router } from 'express';
import cors from 'cors';
import { pool, query } from '../../../db.js';
import { resolveSigningContext } from '../security/resolveSigningContext.js';
import { assertRecipientSigningTurn } from '../signingOrder.js';
import { insertEsignAudit } from '../audit.js';
import { ESIGN_AUDIT } from '../auditActions.js';
import { signSubmitRateLimit } from '../middleware/signSubmitRateLimit.js';
import { assertDocumentStatusTransition, DOCUMENT_STATUS } from '../statusMachine.js';

const router = Router();

function publicSignCors() {
  const raw = process.env.ESIGN_PUBLIC_SIGNING_ORIGINS;
  if (!raw || !String(raw).trim()) {
    return cors({ origin: true, credentials: false });
  }
  const allowed = new Set(
    String(raw)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  );
  return cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      return cb(null, allowed.has(origin));
    },
    credentials: false,
  });
}

router.use(publicSignCors());

function decodeTokenParam(raw) {
  if (raw == null) return '';
  try {
    return decodeURIComponent(String(raw));
  } catch {
    return String(raw);
  }
}

function parsePlacements(raw) {
  if (raw == null) return [];
  if (typeof raw === 'string') {
    try {
      const p = JSON.parse(raw);
      return Array.isArray(p) ? p : [];
    } catch {
      return [];
    }
  }
  return Array.isArray(raw) ? raw : [];
}

const MAX_SIGNATURES = 30;
const MAX_SIGNATURE_DATA_CHARS = 1_500_000;

function parseSignaturesBody(body) {
  const sigs = body?.signatures;
  if (!Array.isArray(sigs) || sigs.length === 0) {
    throw new Error('signatures must be a non-empty array');
  }
  if (sigs.length > MAX_SIGNATURES) {
    throw new Error(`At most ${MAX_SIGNATURES} signature fields per request`);
  }
  const out = [];
  for (const s of sigs) {
    if (!s || typeof s !== 'object') throw new Error('Invalid signature entry');
    const page = Number(s.page);
    const x = Number(s.x);
    const y = Number(s.y);
    const signature_data = s.signature_data;
    if (!Number.isInteger(page) || page < 1) throw new Error('Each signature needs page >= 1');
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Each signature needs numeric x and y');
    if (typeof signature_data !== 'string' || !signature_data.trim()) {
      throw new Error('Each signature needs non-empty signature_data');
    }
    if (signature_data.length > MAX_SIGNATURE_DATA_CHARS) {
      throw new Error('signature_data too large');
    }
    out.push({ page, x, y, signature_data });
  }
  return out;
}

function actorRecipient(recipientId) {
  return `esign:recipient:${recipientId}`;
}

router.get('/:token', async (req, res) => {
  try {
    const token = decodeTokenParam(req.params.token);
    const ctx = await resolveSigningContext(token);
    if (!ctx.ok) {
      return res.status(ctx.status).json({ error: ctx.code });
    }
    const { recipient, document } = ctx;

    const turn = await assertRecipientSigningTurn(query, {
      documentId: document.id,
      companyId: document.company_id,
      recipientId: recipient.id,
    });
    if (!turn.ok) {
      return res.status(turn.status).json({
        error: turn.code,
        your_signing_order: recipient.signing_order,
        current_signing_order: turn.current_signing_order,
      });
    }

    await insertEsignAudit(query, {
      companyId: document.company_id,
      documentId: document.id,
      action: ESIGN_AUDIT.viewed,
      actor: actorRecipient(recipient.id),
      metadata: { email: recipient.email },
    });

    const fields = parsePlacements(document.placements_json);

    return res.json({
      document: {
        title: document.title,
        file_url: document.file_url,
      },
      recipient: {
        name: recipient.name,
      },
      fields,
      signing_order: recipient.signing_order,
      expires_at: recipient.sign_token_expires_at,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to load signing session' });
  }
});

router.post('/:token', signSubmitRateLimit(), async (req, res) => {
  let signAuditCtx = null;
  try {
    const token = decodeTokenParam(req.params.token);
    const ctx = await resolveSigningContext(token);
    if (!ctx.ok) {
      return res.status(ctx.status).json({ error: ctx.code });
    }
    const { recipient, document } = ctx;
    signAuditCtx = ctx;

    let signatures;
    try {
      signatures = parseSignaturesBody(req.body || {});
    } catch (e) {
      return res.status(400).json({ error: e instanceof Error ? e.message : 'Invalid body' });
    }

    let remainingPending = 1;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const docLock = await client.query(
        `SELECT id, status FROM esign_documents WHERE id = $1 AND company_id = $2 FOR UPDATE`,
        [document.id, document.company_id]
      );
      if (!docLock.rows[0]) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'not_found' });
      }
      const liveDocStatus = docLock.rows[0].status;
      if (liveDocStatus !== DOCUMENT_STATUS.SENT) {
        await client.query('ROLLBACK');
        await insertEsignAudit(query, {
          companyId: document.company_id,
          documentId: document.id,
          action: ESIGN_AUDIT.failed,
          actor: actorRecipient(recipient.id),
          metadata: { reason: 'document_not_sent', status: liveDocStatus, phase: 'submit_signature' },
        }).catch(() => {});
        return res.status(409).json({ error: 'document_not_ready' });
      }

      const turn = await assertRecipientSigningTurn(client.query.bind(client), {
        documentId: document.id,
        companyId: document.company_id,
        recipientId: recipient.id,
      });
      if (!turn.ok) {
        await client.query('ROLLBACK');
        await insertEsignAudit(query, {
          companyId: document.company_id,
          documentId: document.id,
          action: ESIGN_AUDIT.failed,
          actor: actorRecipient(recipient.id),
          metadata: { reason: turn.code, phase: 'submit_signature' },
        }).catch(() => {});
        return res.status(turn.status).json({
          error: turn.code,
          your_signing_order: recipient.signing_order,
          current_signing_order: turn.current_signing_order,
        });
      }

      for (const s of signatures) {
        await client.query(
          `INSERT INTO esign_signatures (company_id, document_id, recipient_id, page, x, y, signature_data)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [document.company_id, document.id, recipient.id, s.page, s.x, s.y, s.signature_data]
        );
      }

      const updRec = await client.query(
        `UPDATE esign_recipients
         SET status = 'SIGNED', signed_at = NOW()
         WHERE id = $1 AND company_id = $2 AND document_id = $3 AND status = 'PENDING'`,
        [recipient.id, document.company_id, document.id]
      );
      if (updRec.rowCount !== 1) {
        await client.query('ROLLBACK');
        await insertEsignAudit(query, {
          companyId: document.company_id,
          documentId: document.id,
          action: ESIGN_AUDIT.failed,
          actor: actorRecipient(recipient.id),
          metadata: { reason: 'already_signed', phase: 'submit_signature' },
        }).catch(() => {});
        return res.status(409).json({ error: 'already_signed' });
      }

      const pending = await client.query(
        `SELECT COUNT(*)::int AS c FROM esign_recipients
         WHERE document_id = $1 AND company_id = $2 AND status = 'PENDING'`,
        [document.id, document.company_id]
      );
      remainingPending = pending.rows[0]?.c ?? 0;

      if (remainingPending === 0) {
        const completeTr = assertDocumentStatusTransition(liveDocStatus, DOCUMENT_STATUS.SIGNED);
        if (!completeTr.ok) {
          await client.query('ROLLBACK');
          await insertEsignAudit(query, {
            companyId: document.company_id,
            documentId: document.id,
            action: ESIGN_AUDIT.failed,
            actor: actorRecipient(recipient.id),
            metadata: { reason: completeTr.code, phase: 'complete_document' },
          }).catch(() => {});
          return res.status(500).json({ error: 'Invalid document completion' });
        }
        await client.query(
          `UPDATE esign_documents SET status = 'SIGNED', updated_at = NOW()
           WHERE id = $1 AND company_id = $2`,
          [document.id, document.company_id]
        );
      }

      await insertEsignAudit(client.query.bind(client), {
        companyId: document.company_id,
        documentId: document.id,
        action: ESIGN_AUDIT.signed,
        actor: actorRecipient(recipient.id),
        metadata: { email: recipient.email, fields: signatures.length },
      });

      if (remainingPending === 0) {
        await insertEsignAudit(client.query.bind(client), {
          companyId: document.company_id,
          documentId: document.id,
          action: ESIGN_AUDIT.completed,
          actor: 'system',
          metadata: {},
        });
      }

      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }

    return res.json({
      ok: true,
      document_status: remainingPending === 0 ? DOCUMENT_STATUS.SIGNED : DOCUMENT_STATUS.SENT,
    });
  } catch (e) {
    console.error(e);
    if (signAuditCtx?.document && signAuditCtx?.recipient) {
      await insertEsignAudit(query, {
        companyId: signAuditCtx.document.company_id,
        documentId: signAuditCtx.document.id,
        action: ESIGN_AUDIT.failed,
        actor: actorRecipient(signAuditCtx.recipient.id),
        metadata: { phase: 'submit_signature', message: e instanceof Error ? e.message : String(e) },
      }).catch(() => {});
    }
    return res.status(500).json({ error: 'Failed to submit signature' });
  }
});

export default router;
