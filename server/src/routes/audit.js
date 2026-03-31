import { Router } from 'express';
import { query } from '../db.js';
import { authRequired } from '../middleware/auth.js';
import { companyContext } from '../middleware/companyContext.js';
import { auditSchemaHint, auditTablesExist } from '../utils/auditSchema.js';
import { writeAuditEvent } from '../utils/auditLog.js';
import { attachAuthorization, requirePermission, requireRole } from '../middleware/authorization.js';

const router = Router();
router.use(authRequired, companyContext);
router.use(attachAuthorization);

router.use(async (_req, res, next) => {
  if (!(await auditTablesExist())) {
    return res.status(503).json({ error: 'Audit schema not installed.', hint: auditSchemaHint() });
  }
  return next();
});

router.get('/attachments', async (req, res) => {
  try {
    const { entity_type, entity_id } = req.query;
    if (!entity_type || !entity_id) {
      return res.status(400).json({ error: 'entity_type and entity_id are required' });
    }
    const r = await query(
      `SELECT *
       FROM document_attachments
       WHERE company_id = $1 AND entity_type = $2 AND entity_id = $3::uuid
       ORDER BY created_at DESC`,
      [req.company.id, String(entity_type), String(entity_id)]
    );
    return res.json({ attachments: r.rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to list attachments' });
  }
});

router.post('/attachments', async (req, res) => {
  try {
    const { entity_type, entity_id, file_name, file_url, mime_type, file_size_bytes } = req.body || {};
    if (!entity_type || !entity_id || !file_name || !file_url) {
      return res.status(400).json({ error: 'entity_type, entity_id, file_name, file_url are required' });
    }
    const ins = await query(
      `INSERT INTO document_attachments (
         company_id, entity_type, entity_id, file_name, file_url, mime_type, file_size_bytes, uploaded_by
       )
       VALUES ($1,$2,$3::uuid,$4,$5,$6,$7,$8)
       RETURNING *`,
      [
        req.company.id,
        String(entity_type),
        String(entity_id),
        String(file_name),
        String(file_url),
        mime_type ? String(mime_type) : null,
        file_size_bytes ? Number(file_size_bytes) : null,
        req.user.id,
      ]
    );
    await writeAuditEvent({
      companyId: req.company.id,
      actorUserId: req.user.id,
      eventType: 'attachment.created',
      entityType: String(entity_type),
      entityId: String(entity_id),
      details: { attachment_id: ins.rows[0].id, file_name: file_name },
    });
    return res.status(201).json({ attachment: ins.rows[0] });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to create attachment' });
  }
});

router.delete('/attachments/:id', async (req, res) => {
  try {
    const del = await query(
      `DELETE FROM document_attachments
       WHERE id = $1 AND company_id = $2
       RETURNING *`,
      [req.params.id, req.company.id]
    );
    if (!del.rows.length) return res.status(404).json({ error: 'Attachment not found' });
    await writeAuditEvent({
      companyId: req.company.id,
      actorUserId: req.user.id,
      eventType: 'attachment.deleted',
      entityType: del.rows[0].entity_type,
      entityId: del.rows[0].entity_id,
      details: { attachment_id: del.rows[0].id, file_name: del.rows[0].file_name },
    });
    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to delete attachment' });
  }
});

router.get('/events', async (req, res) => {
  try {
    const { limit = '100', offset = '0' } = req.query;
    const lim = Math.min(500, Math.max(1, Number(limit) || 100));
    const off = Math.max(0, Number(offset) || 0);
    const r = await query(
      `SELECT *
       FROM audit_events
       WHERE company_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [req.company.id, lim, off]
    );
    return res.json({ events: r.rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to list audit events' });
  }
});

router.post('/journal-approvals/request/:transactionId', async (req, res) => {
  try {
    const { note } = req.body || {};
    const tx = await query(`SELECT id FROM transactions WHERE id = $1 AND company_id = $2`, [
      req.params.transactionId,
      req.company.id,
    ]);
    if (!tx.rows.length) return res.status(404).json({ error: 'Transaction not found' });
    const up = await query(
      `INSERT INTO journal_approvals (company_id, transaction_id, requested_by, note)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (transaction_id)
       DO UPDATE SET status = 'pending', approved_by = NULL, decided_at = NULL, note = EXCLUDED.note, requested_at = NOW()
       RETURNING *`,
      [req.company.id, req.params.transactionId, req.user.id, note ? String(note) : null]
    );
    await writeAuditEvent({
      companyId: req.company.id,
      actorUserId: req.user.id,
      eventType: 'journal.approval.requested',
      entityType: 'transaction',
      entityId: req.params.transactionId,
      details: { approval_id: up.rows[0].id },
    });
    return res.status(201).json({ approval: up.rows[0] });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to request journal approval' });
  }
});

router.post('/journal-approvals/:id/decide', async (req, res) => {
  return requirePermission('audit.approval.decide')(req, res, async () => {
  try {
    const { decision, note } = req.body || {};
    if (!['approved', 'rejected'].includes(String(decision))) {
      return res.status(400).json({ error: 'decision must be approved or rejected' });
    }
    const upd = await query(
      `UPDATE journal_approvals
       SET status = $1::approval_status,
           approved_by = $2,
           note = COALESCE($3, note),
           decided_at = NOW()
       WHERE id = $4 AND company_id = $5
       RETURNING *`,
      [decision, req.user.id, note ? String(note) : null, req.params.id, req.company.id]
    );
    if (!upd.rows.length) return res.status(404).json({ error: 'Approval request not found' });
    if (upd.rows[0].requested_by && upd.rows[0].requested_by === req.user.id) {
      return res.status(400).json({ error: 'Maker-checker violation: requester cannot approve/reject own request' });
    }
    await writeAuditEvent({
      companyId: req.company.id,
      actorUserId: req.user.id,
      eventType: `journal.approval.${decision}`,
      entityType: 'transaction',
      entityId: upd.rows[0].transaction_id,
      details: { approval_id: upd.rows[0].id },
    });
    return res.json({ approval: upd.rows[0] });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to decide journal approval' });
  }
  });
});

router.get('/journal-approvals', async (req, res) => {
  return requireRole(['owner', 'admin', 'accountant'])(req, res, async () => {
  try {
    const { status } = req.query;
    const params = [req.company.id];
    let sql = `SELECT ja.*, t.entry_date, t.description, t.reference
               FROM journal_approvals ja
               JOIN transactions t ON t.id = ja.transaction_id
               WHERE ja.company_id = $1`;
    if (status) {
      params.push(String(status));
      sql += ` AND ja.status = $2::approval_status`;
    }
    sql += ` ORDER BY ja.requested_at DESC`;
    const r = await query(sql, params);
    return res.json({ approvals: r.rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to list journal approvals' });
  }
  });
});

router.get('/numbering-integrity', async (req, res) => {
  try {
    const invoices = await query(
      `SELECT invoice_number
       FROM invoices
       WHERE company_id = $1
         AND invoice_number IS NOT NULL
       ORDER BY invoice_number`,
      [req.company.id]
    );
    const bills = await query(
      `SELECT bill_number
       FROM bills
       WHERE company_id = $1
         AND bill_number IS NOT NULL
       ORDER BY bill_number`,
      [req.company.id]
    );

    const invoiceDup = await query(
      `SELECT invoice_number, COUNT(*)::int AS cnt
       FROM invoices
       WHERE company_id = $1
         AND invoice_number IS NOT NULL
       GROUP BY invoice_number
       HAVING COUNT(*) > 1`,
      [req.company.id]
    );
    const billDup = await query(
      `SELECT bill_number, COUNT(*)::int AS cnt
       FROM bills
       WHERE company_id = $1
         AND bill_number IS NOT NULL
       GROUP BY bill_number
       HAVING COUNT(*) > 1`,
      [req.company.id]
    );

    return res.json({
      invoice_numbers: { count: invoices.rows.length, duplicates: invoiceDup.rows },
      bill_numbers: { count: bills.rows.length, duplicates: billDup.rows },
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to run numbering integrity checks' });
  }
});

export default router;

