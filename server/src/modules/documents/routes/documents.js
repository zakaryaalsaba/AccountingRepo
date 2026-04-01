import { Router } from 'express';
import multer, { MulterError } from 'multer';
import { pool, query } from '../../../db.js';
import { authRequired } from '../../../middleware/auth.js';
import { companyContext } from '../../../middleware/companyContext.js';
import { attachAuthorization, requirePermission } from '../../../middleware/authorization.js';
import { documentsModuleEnabled } from '../middleware/documentsModuleEnabled.js';
import { canReadDocument, canManageDocument } from '../permissions.js';
import { getEsignStorage, getEsignStorageConfig } from '../storage/index.js';
import { generateSignToken, signTokenExpiresAt } from '../security/signToken.js';
import { insertEsignAudit } from '../audit.js';
import { ESIGN_AUDIT } from '../auditActions.js';
import {
  assertDocumentEditable,
  assertDocumentStatusTransition,
  DOCUMENT_STATUS,
  DOCUMENT_STATUS_SET,
} from '../statusMachine.js';

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(s) {
  return typeof s === 'string' && UUID_RE.test(s);
}

function normalizeEmail(s) {
  return String(s || '')
    .trim()
    .toLowerCase();
}

function isValidEmail(s) {
  const e = normalizeEmail(s);
  if (!e || e.length > 255) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

function normalizePlacements(raw) {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw new Error('placements_json must be an array');
  for (const p of raw) {
    if (!p || typeof p !== 'object') throw new Error('Invalid placement entry');
    const page = Number(p.page);
    const x = Number(p.x);
    const y = Number(p.y);
    if (!Number.isInteger(page) || page < 1) throw new Error('Each placement needs page >= 1');
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Each placement needs numeric x and y');
  }
  return raw;
}

function parseRecipients(raw) {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('recipients must be a non-empty array');
  const seen = new Set();
  const out = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') throw new Error('Invalid recipient');
    const name = String(r.name || '').trim();
    const email = normalizeEmail(r.email);
    const order = Number(r.signing_order);
    if (!name || name.length > 255) throw new Error('Recipient name required');
    if (!isValidEmail(email)) throw new Error(`Invalid email: ${r.email}`);
    if (seen.has(email)) throw new Error(`Duplicate recipient email: ${email}`);
    seen.add(email);
    if (!Number.isInteger(order) || order < 1) throw new Error('signing_order must be integer >= 1');
    out.push({ name, email, signing_order: order });
  }
  out.sort((a, b) => a.signing_order - b.signing_order);
  return out;
}

function stripRecipientRow(row) {
  const { sign_token_hash, ...rest } = row;
  return rest;
}

function signingLinkBaseUrl() {
  const explicit = process.env.ESIGN_SIGNING_BASE_URL;
  if (explicit) return String(explicit).replace(/\/$/, '');
  const pub = (process.env.ESIGN_PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 4000}`).replace(/\/$/, '');
  return `${pub}/api/sign`;
}

const maxUploadBytes = getEsignStorageConfig().maxBytes;
const uploadMw = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxUploadBytes, files: 1 },
});

router.use(authRequired, companyContext, documentsModuleEnabled, attachAuthorization);

router.get('/', requirePermission('documents.read'), async (req, res) => {
  try {
    const companyId = req.company.id;
    const clauses = [`d.company_id = $1`];
    const params = [companyId];
    let i = 2;

    const st = req.query.status;
    if (st) {
      if (!DOCUMENT_STATUS_SET.has(String(st))) {
        return res.status(400).json({ error: 'Invalid status filter' });
      }
      clauses.push(`d.status = $${i}`);
      params.push(String(st));
      i += 1;
    }

    if (req.query.owner_id) {
      if (!isUuid(req.query.owner_id)) {
        return res.status(400).json({ error: 'Invalid owner_id' });
      }
      clauses.push(`d.owner_id = $${i}`);
      params.push(req.query.owner_id);
      i += 1;
    }

    if (req.query.created_from) {
      clauses.push(`d.created_at >= $${i}::timestamptz`);
      params.push(String(req.query.created_from));
      i += 1;
    }
    if (req.query.created_to) {
      clauses.push(`d.created_at <= $${i}::timestamptz`);
      params.push(String(req.query.created_to));
      i += 1;
    }

    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    const sql = `
      SELECT d.*, u.email AS owner_email
      FROM esign_documents d
      LEFT JOIN users u ON u.id = d.owner_id
      WHERE ${clauses.join(' AND ')}
      ORDER BY d.created_at DESC
      LIMIT ${limit} OFFSET ${offset}`;
    const r = await query(sql, params);
    return res.json({ documents: r.rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to list documents' });
  }
});

router.post('/upload', requirePermission('documents.manage'), (req, res, next) => {
  uploadMw.single('file')(req, res, (err) => {
    if (err instanceof MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: `File too large (max ${maxUploadBytes} bytes)` });
      }
      return res.status(400).json({ error: err.message || 'Upload failed' });
    }
    if (err) return next(err);
    next();
  });
}, async (req, res) => {
  try {
    if (!req.file?.buffer) {
      return res.status(400).json({ error: 'file is required (multipart field "file")' });
    }
    const title = String(req.body?.title || '').trim() || 'Untitled document';
    if (title.length > 500) {
      return res.status(400).json({ error: 'title too long' });
    }

    const storage = getEsignStorage();
    let saved;
    try {
      saved = await storage.saveFile(req.file.buffer, {
        companyId: req.company.id,
        originalName: req.file.originalname || 'document.pdf',
        mimeType: req.file.mimetype,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Storage failed';
      return res.status(400).json({ error: msg });
    }

    const ins = await query(
      `INSERT INTO esign_documents (company_id, title, file_url, owner_id, status, placements_json)
       VALUES ($1, $2, $3, $4, 'DRAFT', '[]'::jsonb)
       RETURNING *`,
      [req.company.id, title, saved.file_url, req.user.id]
    );
    const doc = ins.rows[0];
    await insertEsignAudit(query, {
      companyId: req.company.id,
      documentId: doc.id,
      action: ESIGN_AUDIT.created,
      actor: req.user.id,
      metadata: { title, owner_id: req.user.id, status: DOCUMENT_STATUS.DRAFT },
    });
    await insertEsignAudit(query, {
      companyId: req.company.id,
      documentId: doc.id,
      action: ESIGN_AUDIT.uploaded,
      actor: req.user.id,
      metadata: { file_url: saved.file_url, storage_key: saved.storage_key, bytes: saved.bytes_written },
    });

    return res.status(201).json({
      document: doc,
      storage: { file_url: saved.file_url, storage_key: saved.storage_key, bytes_written: saved.bytes_written },
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to upload document' });
  }
});

async function loadDocument(req, res, next) {
  try {
    const id = req.params.id;
    if (!isUuid(id)) {
      return res.status(400).json({ error: 'Invalid document id' });
    }
    const r = await query(`SELECT * FROM esign_documents WHERE id = $1 AND company_id = $2`, [id, req.company.id]);
    if (!r.rows.length) {
      return res.status(404).json({ error: 'Not found' });
    }
    req.esignDocument = r.rows[0];
    next();
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to load document' });
  }
}

function requireReadThisDocument(req, res, next) {
  if (!canReadDocument(req, req.esignDocument)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

function requireManageThisDocument(req, res, next) {
  if (!canManageDocument(req, req.esignDocument)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

router.get('/:id', requirePermission('documents.read'), loadDocument, requireReadThisDocument, async (req, res) => {
  try {
    const docId = req.esignDocument.id;
    const companyId = req.company.id;

    const [recipients, audits] = await Promise.all([
      query(
        `SELECT id, company_id, document_id, name, email, signing_order, status,
                sign_token_expires_at, signed_at, created_at
         FROM esign_recipients
         WHERE document_id = $1 AND company_id = $2
         ORDER BY signing_order ASC, created_at ASC`,
        [docId, companyId]
      ),
      query(
        `SELECT id, action, actor, metadata, created_at
         FROM esign_audit_logs
         WHERE document_id = $1 AND company_id = $2
         ORDER BY created_at DESC
         LIMIT 50`,
        [docId, companyId]
      ),
    ]);

    return res.json({
      document: req.esignDocument,
      recipients: recipients.rows.map(stripRecipientRow),
      audit_log: audits.rows,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to load document detail' });
  }
});

router.patch('/:id', loadDocument, requireManageThisDocument, async (req, res) => {
  try {
    const doc = req.esignDocument;
    if (!assertDocumentEditable(doc.status)) {
      return res.status(409).json({ error: 'Only DRAFT documents can be edited' });
    }

    const body = req.body || {};
    let placements;
    try {
      placements = body.placements_json !== undefined ? normalizePlacements(body.placements_json) : undefined;
    } catch (e) {
      return res.status(400).json({ error: e instanceof Error ? e.message : 'Invalid placements' });
    }

    let recipientsParsed;
    if (body.recipients !== undefined) {
      try {
        recipientsParsed = parseRecipients(body.recipients);
      } catch (e) {
        return res.status(400).json({ error: e instanceof Error ? e.message : 'Invalid recipients' });
      }
    }

    const title =
      body.title !== undefined ? String(body.title).trim() : undefined;
    if (title !== undefined && (!title || title.length > 500)) {
      return res.status(400).json({ error: 'title invalid' });
    }

    if (title === undefined && placements === undefined && recipientsParsed === undefined) {
      return res.status(400).json({ error: 'No updates: provide title, placements_json, and/or recipients' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      if (title !== undefined || placements !== undefined) {
        const sets = [];
        const params = [];
        let idx = 1;
        if (title !== undefined) {
          sets.push(`title = $${idx++}`);
          params.push(title);
        }
        if (placements !== undefined) {
          sets.push(`placements_json = $${idx++}::jsonb`);
          params.push(JSON.stringify(placements));
        }
        sets.push('updated_at = NOW()');
        params.push(doc.id, req.company.id);
        await client.query(
          `UPDATE esign_documents SET ${sets.join(', ')} WHERE id = $${idx} AND company_id = $${idx + 1}`,
          params
        );
      }

      if (recipientsParsed) {
        await client.query(`DELETE FROM esign_recipients WHERE document_id = $1 AND company_id = $2`, [
          doc.id,
          req.company.id,
        ]);
        for (const rec of recipientsParsed) {
          await client.query(
            `INSERT INTO esign_recipients (company_id, document_id, name, email, signing_order, status)
             VALUES ($1, $2, $3, $4, $5, 'PENDING')`,
            [req.company.id, doc.id, rec.name, rec.email, rec.signing_order]
          );
        }
        await client.query(
          `UPDATE esign_documents SET updated_at = NOW() WHERE id = $1 AND company_id = $2`,
          [doc.id, req.company.id]
        );
        await insertEsignAudit(client.query.bind(client), {
          companyId: req.company.id,
          documentId: doc.id,
          action: ESIGN_AUDIT.recipients_updated,
          actor: req.user.id,
          metadata: { count: recipientsParsed.length },
        });
      } else if (title !== undefined || placements !== undefined) {
        await insertEsignAudit(client.query.bind(client), {
          companyId: req.company.id,
          documentId: doc.id,
          action: ESIGN_AUDIT.updated,
          actor: req.user.id,
          metadata: { fields: [...(title !== undefined ? ['title'] : []), ...(placements !== undefined ? ['placements_json'] : [])] },
        });
      }

      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }

    const fresh = await query(`SELECT * FROM esign_documents WHERE id = $1 AND company_id = $2`, [doc.id, req.company.id]);
    const recs = await query(
      `SELECT id, company_id, document_id, name, email, signing_order, status, sign_token_expires_at, signed_at, created_at
       FROM esign_recipients WHERE document_id = $1 AND company_id = $2 ORDER BY signing_order`,
      [doc.id, req.company.id]
    );

    return res.json({ document: fresh.rows[0], recipients: recs.rows.map(stripRecipientRow) });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to update document' });
  }
});

router.post('/:id/send', loadDocument, requireManageThisDocument, async (req, res) => {
  const doc = req.esignDocument;
  try {
    if (!assertDocumentEditable(doc.status)) {
      return res.status(409).json({ error: 'Only DRAFT documents can be sent' });
    }

    const recs = await query(
      `SELECT * FROM esign_recipients WHERE document_id = $1 AND company_id = $2 ORDER BY signing_order ASC`,
      [doc.id, req.company.id]
    );
    if (!recs.rows.length) {
      return res.status(400).json({ error: 'Add at least one recipient before sending' });
    }

    let placements = doc.placements_json;
    if (typeof placements === 'string') {
      try {
        placements = JSON.parse(placements);
      } catch {
        placements = [];
      }
    }
    if (!Array.isArray(placements)) placements = [];

    const client = await pool.connect();
    const signingLinks = [];
    const expiresAt = signTokenExpiresAt();
    try {
      await client.query('BEGIN');

      const docLock = await client.query(
        `SELECT status FROM esign_documents WHERE id = $1 AND company_id = $2 FOR UPDATE`,
        [doc.id, req.company.id]
      );
      if (!docLock.rows[0]) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Not found' });
      }
      const liveStatus = docLock.rows[0].status;
      const sendTransition = assertDocumentStatusTransition(liveStatus, DOCUMENT_STATUS.SENT);
      if (!sendTransition.ok) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'Document cannot be sent in its current state',
          code: sendTransition.code,
        });
      }

      for (const row of recs.rows) {
        const { plainToken, tokenHash } = generateSignToken();
        await client.query(
          `UPDATE esign_recipients
           SET sign_token_hash = $1, sign_token_expires_at = $2
           WHERE id = $3 AND company_id = $4 AND document_id = $5`,
          [tokenHash, expiresAt, row.id, req.company.id, doc.id]
        );
        const link = `${signingLinkBaseUrl()}/${encodeURIComponent(plainToken)}`;
        signingLinks.push({ email: row.email, name: row.name, link });
        console.info(`[esign] signing link for ${row.email} document=${doc.id}: ${link}`);
      }

      await client.query(
        `UPDATE esign_documents SET status = 'SENT', updated_at = NOW() WHERE id = $1 AND company_id = $2`,
        [doc.id, req.company.id]
      );

      await insertEsignAudit(client.query.bind(client), {
        companyId: req.company.id,
        documentId: doc.id,
        action: ESIGN_AUDIT.sent,
        actor: req.user.id,
        metadata: { recipient_count: recs.rows.length, placements_count: placements.length },
      });

      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }

    const outDoc = await query(`SELECT * FROM esign_documents WHERE id = $1 AND company_id = $2`, [doc.id, req.company.id]);
    const outRecs = await query(
      `SELECT id, company_id, document_id, name, email, signing_order, status, sign_token_expires_at, signed_at, created_at
       FROM esign_recipients WHERE document_id = $1 AND company_id = $2 ORDER BY signing_order`,
      [doc.id, req.company.id]
    );

    return res.json({
      document: outDoc.rows[0],
      recipients: outRecs.rows.map(stripRecipientRow),
      signing_links: signingLinks,
      sign_token_expires_at: expiresAt.toISOString(),
    });
  } catch (e) {
    console.error(e);
    try {
      await insertEsignAudit(query, {
        companyId: req.company.id,
        documentId: doc.id,
        action: ESIGN_AUDIT.failed,
        actor: req.user.id,
        metadata: { phase: 'send', message: e instanceof Error ? e.message : String(e) },
      });
    } catch (_) {
      /* ignore audit failure */
    }
    return res.status(500).json({ error: 'Failed to send document' });
  }
});

export default router;
