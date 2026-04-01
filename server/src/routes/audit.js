import { Router } from 'express';
import { query } from '../db.js';
import { authRequired } from '../middleware/auth.js';
import { companyContext } from '../middleware/companyContext.js';
import { auditComplianceSchemaHint, auditComplianceTablesExist, auditSchemaHint, auditTablesExist } from '../utils/auditSchema.js';
import { writeAuditEvent, writeSnapshotAuditEvent } from '../utils/auditLog.js';
import { attachAuthorization, requirePermission, requireRole } from '../middleware/authorization.js';
import { workflowSchemaHint, workflowTablesExist } from '../utils/workflowSchema.js';

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

router.post('/snapshot-event', async (req, res) => {
  try {
    const { event_type, entity_type, entity_id = null, before = null, after = null, metadata = {} } = req.body || {};
    if (!event_type || !entity_type) {
      return res.status(400).json({ error: 'event_type and entity_type are required' });
    }
    await writeSnapshotAuditEvent({
      companyId: req.company.id,
      actorUserId: req.user.id,
      eventType: String(event_type),
      entityType: String(entity_type),
      entityId: entity_id ? String(entity_id) : null,
      before,
      after,
      metadata,
    });
    return res.status(201).json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to create snapshot audit event' });
  }
});

router.get('/timeline/:entityType/:entityId', async (req, res) => {
  try {
    const { entityType, entityId } = req.params;
    const r = await query(
      `SELECT *
       FROM audit_events
       WHERE company_id = $1
         AND entity_type = $2
         AND entity_id = $3
       ORDER BY created_at ASC, id ASC`,
      [req.company.id, String(entityType), String(entityId)]
    );
    return res.json({ timeline: r.rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to load entity timeline' });
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

router.get('/sequence-monitor', async (req, res) => {
  try {
    const invoices = await query(
      `SELECT invoice_number
       FROM invoices
       WHERE company_id = $1 AND invoice_number IS NOT NULL
       ORDER BY invoice_number`,
      [req.company.id]
    );
    const bills = await query(
      `SELECT bill_number
       FROM bills
       WHERE company_id = $1 AND bill_number IS NOT NULL
       ORDER BY bill_number`,
      [req.company.id]
    );
    const txRefs = await query(
      `SELECT reference
       FROM transactions
       WHERE company_id = $1 AND reference IS NOT NULL
       ORDER BY reference`,
      [req.company.id]
    );
    const extractNum = (v) => {
      const m = String(v || '').match(/(\d+)(?!.*\d)/);
      return m ? Number(m[1]) : null;
    };
    const findGaps = (list) => {
      const nums = [...new Set(list.map(extractNum).filter((x) => Number.isFinite(x)).sort((a, b) => a - b))];
      const gaps = [];
      for (let i = 1; i < nums.length; i += 1) {
        if (nums[i] - nums[i - 1] > 1) gaps.push({ from: nums[i - 1], to: nums[i], missing_count: nums[i] - nums[i - 1] - 1 });
      }
      return gaps;
    };
    const result = {
      invoices: { gaps: findGaps(invoices.rows.map((x) => x.invoice_number)) },
      bills: { gaps: findGaps(bills.rows.map((x) => x.bill_number)) },
      transactions: { gaps: findGaps(txRefs.rows.map((x) => x.reference)) },
    };
    if (await auditComplianceTablesExist()) {
      await query(
        `INSERT INTO audit_monitor_jobs (company_id, job_type, status, result_json, finished_at)
         VALUES ($1,'sequence_gap_monitor','completed',$2::jsonb,NOW())`,
        [req.company.id, JSON.stringify(result)]
      );
    }
    return res.json(result);
  } catch (e) {
    if (String(e.code) === '42P01') {
      return res.status(503).json({ error: 'Audit compliance schema not installed.', hint: auditComplianceSchemaHint() });
    }
    console.error(e);
    return res.status(500).json({ error: 'Failed to run sequence monitor' });
  }
});

router.get('/suspicious-activity', async (req, res) => {
  try {
    const { from, to, mass_edit_threshold = '20' } = req.query;
    const start = from || '1970-01-01';
    const end = to || '2999-12-31';
    const threshold = Math.max(1, Number(mass_edit_threshold) || 20);
    const mass = await query(
      `SELECT actor_user_id, date_trunc('day', created_at) AS day_bucket, COUNT(*)::int AS edits_count
       FROM audit_events
       WHERE company_id = $1
         AND created_at >= $2::date
         AND created_at <= ($3::date + INTERVAL '1 day')
         AND event_type IN ('transaction.updated','transaction.deleted','voucher.updated','voucher.deleted')
       GROUP BY actor_user_id, date_trunc('day', created_at)
       HAVING COUNT(*) >= $4
       ORDER BY edits_count DESC, day_bucket DESC`,
      [req.company.id, start, end, threshold]
    );
    const backdated = await query(
      `SELECT id, entry_date, created_at, posted_by
       FROM transactions
       WHERE company_id = $1
         AND created_at >= $2::date
         AND created_at <= ($3::date + INTERVAL '1 day')
         AND entry_date < (created_at::date - 7)
       ORDER BY created_at DESC`,
      [req.company.id, start, end]
    );
    const weekend = await query(
      `SELECT id, entry_date, created_at, posted_by
       FROM transactions
       WHERE company_id = $1
         AND created_at >= $2::date
         AND created_at <= ($3::date + INTERVAL '1 day')
         AND EXTRACT(ISODOW FROM entry_date) IN (6,7)
       ORDER BY entry_date DESC`,
      [req.company.id, start, end]
    );
    const result = {
      period: { from: start, to: end },
      mass_edits: mass.rows,
      backdated_posts: backdated.rows,
      weekend_posts: weekend.rows,
    };
    if (await auditComplianceTablesExist()) {
      await query(
        `INSERT INTO audit_monitor_jobs (company_id, job_type, status, result_json, finished_at)
         VALUES ($1,'suspicious_activity_scan','completed',$2::jsonb,NOW())`,
        [req.company.id, JSON.stringify(result)]
      );
    }
    return res.json(result);
  } catch (e) {
    if (String(e.code) === '42P01') {
      return res.status(503).json({ error: 'Audit compliance schema not installed.', hint: auditComplianceSchemaHint() });
    }
    console.error(e);
    return res.status(500).json({ error: 'Failed to run suspicious activity checks' });
  }
});

router.get('/workflow/rules', async (req, res) => {
  try {
    if (!(await workflowTablesExist())) {
      return res.status(503).json({ error: 'Workflow schema not installed.', hint: workflowSchemaHint() });
    }
    const { doc_type } = req.query;
    const params = [req.company.id];
    let sql = `SELECT * FROM workflow_approval_rules WHERE company_id = $1`;
    if (doc_type) {
      params.push(String(doc_type));
      sql += ` AND doc_type = $2`;
    }
    sql += ` ORDER BY doc_type, min_amount DESC`;
    const r = await query(sql, params);
    return res.json({ rules: r.rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to list workflow rules' });
  }
});

router.post('/workflow/rules/upsert', async (req, res) => {
  return requireRole(['owner', 'admin'])(req, res, async () => {
    try {
      if (!(await workflowTablesExist())) {
        return res.status(503).json({ error: 'Workflow schema not installed.', hint: workflowSchemaHint() });
      }
      const { doc_type, min_amount = 0, approver_roles = ['owner', 'admin'], is_active = true } = req.body || {};
      if (!doc_type) return res.status(400).json({ error: 'doc_type is required' });
      const ins = await query(
        `INSERT INTO workflow_approval_rules (company_id, doc_type, min_amount, approver_roles, is_active, created_by)
         VALUES ($1,$2,$3,$4::jsonb,$5,$6)
         RETURNING *`,
        [req.company.id, String(doc_type), Number(min_amount || 0), JSON.stringify(approver_roles || []), Boolean(is_active), req.user.id]
      );
      return res.status(201).json({ rule: ins.rows[0] });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Failed to upsert workflow rule' });
    }
  });
});

router.post('/workflow/role-limits/upsert', async (req, res) => {
  return requireRole(['owner', 'admin'])(req, res, async () => {
    try {
      if (!(await workflowTablesExist())) {
        return res.status(503).json({ error: 'Workflow schema not installed.', hint: workflowSchemaHint() });
      }
      const { role, action_key, max_amount } = req.body || {};
      if (!role || !action_key || max_amount === undefined) {
        return res.status(400).json({ error: 'role, action_key, max_amount are required' });
      }
      const up = await query(
        `INSERT INTO role_action_limits (company_id, role, action_key, max_amount, created_by)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (company_id, role, action_key)
         DO UPDATE SET max_amount = EXCLUDED.max_amount, updated_at = NOW()
         RETURNING *`,
        [req.company.id, String(role), String(action_key), Number(max_amount), req.user.id]
      );
      return res.status(201).json({ role_limit: up.rows[0] });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Failed to upsert role action limit' });
    }
  });
});

router.get('/workflow/role-limits', async (req, res) => {
  try {
    if (!(await workflowTablesExist())) {
      return res.status(503).json({ error: 'Workflow schema not installed.', hint: workflowSchemaHint() });
    }
    const r = await query(
      `SELECT *
       FROM role_action_limits
       WHERE company_id = $1
       ORDER BY role, action_key`,
      [req.company.id]
    );
    return res.json({ role_limits: r.rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to list role limits' });
  }
});

router.post('/workflow/requests', async (req, res) => {
  try {
    if (!(await workflowTablesExist())) {
      return res.status(503).json({ error: 'Workflow schema not installed.', hint: workflowSchemaHint() });
    }
    const { doc_type, entity_id, amount = 0, note = null, attachment_reference = null } = req.body || {};
    if (!doc_type || !entity_id) return res.status(400).json({ error: 'doc_type and entity_id are required' });
    const ins = await query(
      `INSERT INTO workflow_approval_requests (
         company_id, doc_type, entity_id, amount, status, requested_by, note, attachment_reference
       )
       VALUES ($1,$2,$3,$4,'pending',$5,$6,$7)
       RETURNING *`,
      [req.company.id, String(doc_type), String(entity_id), Number(amount || 0), req.user.id, note ? String(note) : null, attachment_reference || null]
    );
    await query(
      `INSERT INTO approval_notifications (company_id, recipient_role, notification_type, title, body, payload)
       VALUES ($1,'admin','approval.requested',$2,$3,$4::jsonb)`,
      [
        req.company.id,
        `Approval requested: ${String(doc_type)}`,
        `A new ${String(doc_type)} approval request is pending`,
        JSON.stringify({ request_id: ins.rows[0].id, doc_type: String(doc_type), entity_id: String(entity_id) }),
      ]
    );
    return res.status(201).json({ request: ins.rows[0] });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to create approval request' });
  }
});

router.post('/workflow/requests/:id/decide', async (req, res) => {
  return requireRole(['owner', 'admin'])(req, res, async () => {
    try {
      if (!(await workflowTablesExist())) {
        return res.status(503).json({ error: 'Workflow schema not installed.', hint: workflowSchemaHint() });
      }
      const { decision, note = null } = req.body || {};
      if (!['approved', 'rejected'].includes(String(decision))) {
        return res.status(400).json({ error: 'decision must be approved|rejected' });
      }
      const cur = await query(
        `SELECT *
         FROM workflow_approval_requests
         WHERE id = $1 AND company_id = $2`,
        [req.params.id, req.company.id]
      );
      if (!cur.rows.length) return res.status(404).json({ error: 'Approval request not found' });
      if (cur.rows[0].requested_by && cur.rows[0].requested_by === req.user.id) {
        return res.status(400).json({ error: 'Maker-checker violation: requester cannot decide own request' });
      }
      const up = await query(
        `UPDATE workflow_approval_requests
         SET status = $3::workflow_approval_status,
             approved_by = $4,
             note = COALESCE($5, note),
             decided_at = NOW(),
             updated_at = NOW()
         WHERE id = $1 AND company_id = $2
         RETURNING *`,
        [req.params.id, req.company.id, String(decision), req.user.id, note ? String(note) : null]
      );
      if (decision === 'approved') {
        await query(
          `INSERT INTO workflow_entity_locks (company_id, doc_type, entity_id, approval_request_id, locked_by)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (company_id, doc_type, entity_id)
           DO UPDATE SET approval_request_id = EXCLUDED.approval_request_id, locked_by = EXCLUDED.locked_by, locked_at = NOW()`,
          [req.company.id, up.rows[0].doc_type, up.rows[0].entity_id, up.rows[0].id, req.user.id]
        );
      }
      await query(
        `INSERT INTO approval_notifications (company_id, recipient_user_id, notification_type, title, body, payload)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
        [
          req.company.id,
          up.rows[0].requested_by || null,
          `approval.${String(decision)}`,
          `Approval ${String(decision)}`,
          `Your request for ${up.rows[0].doc_type} (${up.rows[0].entity_id}) was ${String(decision)}`,
          JSON.stringify({ request_id: up.rows[0].id, decision: String(decision) }),
        ]
      );
      return res.json({ request: up.rows[0] });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Failed to decide approval request' });
    }
  });
});

router.get('/workflow/requests', async (req, res) => {
  try {
    if (!(await workflowTablesExist())) {
      return res.status(503).json({ error: 'Workflow schema not installed.', hint: workflowSchemaHint() });
    }
    const { status, doc_type, limit = '200', offset = '0' } = req.query;
    const lim = Math.min(500, Math.max(1, Number(limit) || 200));
    const off = Math.max(0, Number(offset) || 0);
    const params = [req.company.id];
    let i = 2;
    let where = `company_id = $1`;
    if (status) {
      where += ` AND status = $${i++}::workflow_approval_status`;
      params.push(String(status));
    }
    if (doc_type) {
      where += ` AND doc_type = $${i++}`;
      params.push(String(doc_type));
    }
    params.push(lim, off);
    const r = await query(
      `SELECT *
       FROM workflow_approval_requests
       WHERE ${where}
       ORDER BY requested_at DESC
       LIMIT $${i} OFFSET $${i + 1}`,
      params
    );
    return res.json({ requests: r.rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to list approval requests' });
  }
});

router.get('/notifications', async (req, res) => {
  try {
    if (!(await workflowTablesExist())) {
      return res.status(503).json({ error: 'Workflow schema not installed.', hint: workflowSchemaHint() });
    }
    const { unread_only = 'false', limit = '100', offset = '0' } = req.query;
    const lim = Math.min(500, Math.max(1, Number(limit) || 100));
    const off = Math.max(0, Number(offset) || 0);
    const params = [req.company.id, unread_only === 'true', req.user.id, req.authorization?.role || null, lim, off];
    const r = await query(
      `SELECT *
       FROM approval_notifications
       WHERE company_id = $1
         AND ($2::boolean = FALSE OR is_read = FALSE)
         AND (recipient_user_id IS NULL OR recipient_user_id = $3)
         AND (recipient_role IS NULL OR recipient_role = $4)
       ORDER BY created_at DESC
       LIMIT $5 OFFSET $6`,
      params
    );
    return res.json({ notifications: r.rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to list notifications' });
  }
});

router.post('/notifications/:id/read', async (req, res) => {
  try {
    if (!(await workflowTablesExist())) {
      return res.status(503).json({ error: 'Workflow schema not installed.', hint: workflowSchemaHint() });
    }
    const up = await query(
      `UPDATE approval_notifications
       SET is_read = TRUE, read_at = NOW()
       WHERE id = $1 AND company_id = $2
       RETURNING *`,
      [req.params.id, req.company.id]
    );
    if (!up.rows.length) return res.status(404).json({ error: 'Notification not found' });
    return res.json({ notification: up.rows[0] });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to mark notification read' });
  }
});

export default router;

