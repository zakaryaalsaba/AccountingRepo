import { Router } from 'express';
import { query } from '../db.js';
import { authRequired } from '../middleware/auth.js';
import { companyContext } from '../middleware/companyContext.js';
import { enterpriseSchemaHint, enterpriseTablesExist } from '../utils/enterpriseSchema.js';

const router = Router();
router.use(authRequired, companyContext);

router.use(async (_req, res, next) => {
  if (!(await enterpriseTablesExist())) {
    return res.status(503).json({ error: 'Enterprise schema not installed.', hint: enterpriseSchemaHint() });
  }
  return next();
});

// Background jobs
router.post('/jobs/enqueue', async (req, res) => {
  try {
    const { queue_name, payload = {}, run_after = null, max_attempts = 3 } = req.body || {};
    if (!queue_name) return res.status(400).json({ error: 'queue_name is required' });
    const ins = await query(
      `INSERT INTO background_jobs (company_id, queue_name, payload, run_after, max_attempts)
       VALUES ($1,$2,$3::jsonb,COALESCE($4::timestamptz, NOW()),$5)
       RETURNING *`,
      [req.company.id, String(queue_name), JSON.stringify(payload || {}), run_after, Number(max_attempts || 3)]
    );
    return res.status(201).json({ job: ins.rows[0] });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to enqueue job' });
  }
});

router.get('/jobs', async (req, res) => {
  try {
    const { queue_name, status } = req.query;
    const params = [req.company.id];
    let sql = `SELECT * FROM background_jobs WHERE company_id = $1`;
    let i = 2;
    if (queue_name) {
      sql += ` AND queue_name = $${i++}`;
      params.push(String(queue_name));
    }
    if (status) {
      sql += ` AND status = $${i++}::job_status`;
      params.push(String(status));
    }
    sql += ` ORDER BY created_at DESC LIMIT 200`;
    const r = await query(sql, params);
    return res.json({ jobs: r.rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to list jobs' });
  }
});

// Webhook subscriptions and outbox
router.get('/webhooks/subscriptions', async (req, res) => {
  try {
    const r = await query(
      `SELECT * FROM webhook_subscriptions WHERE company_id = $1 ORDER BY created_at DESC`,
      [req.company.id]
    );
    return res.json({ subscriptions: r.rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to list webhook subscriptions' });
  }
});

router.post('/webhooks/subscriptions', async (req, res) => {
  try {
    const { name, target_url, secret = null, event_filter = [], is_active = true } = req.body || {};
    if (!name || !target_url) return res.status(400).json({ error: 'name and target_url are required' });
    const ins = await query(
      `INSERT INTO webhook_subscriptions (company_id, name, target_url, secret, event_filter, is_active)
       VALUES ($1,$2,$3,$4,$5::text[],$6)
       RETURNING *`,
      [req.company.id, String(name), String(target_url), secret ? String(secret) : null, event_filter, Boolean(is_active)]
    );
    return res.status(201).json({ subscription: ins.rows[0] });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to create webhook subscription' });
  }
});

router.post('/webhooks/emit', async (req, res) => {
  try {
    const { event_type, payload = {} } = req.body || {};
    if (!event_type) return res.status(400).json({ error: 'event_type is required' });
    const subs = await query(
      `SELECT *
       FROM webhook_subscriptions
       WHERE company_id = $1
         AND is_active = TRUE
         AND (cardinality(event_filter) = 0 OR $2 = ANY(event_filter))`,
      [req.company.id, String(event_type)]
    );
    const out = [];
    for (const s of subs.rows) {
      const ins = await query(
        `INSERT INTO webhook_deliveries (company_id, subscription_id, event_type, event_payload, status, attempts, next_attempt_at)
         VALUES ($1,$2,$3,$4::jsonb,'queued',0,NOW())
         RETURNING *`,
        [req.company.id, s.id, String(event_type), JSON.stringify(payload || {})]
      );
      out.push(ins.rows[0]);
    }
    return res.status(201).json({ queued_deliveries: out.length, deliveries: out });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to enqueue webhook deliveries' });
  }
});

router.get('/webhooks/deliveries', async (req, res) => {
  try {
    const r = await query(
      `SELECT wd.*, ws.name AS subscription_name, ws.target_url
       FROM webhook_deliveries wd
       JOIN webhook_subscriptions ws ON ws.id = wd.subscription_id
       WHERE wd.company_id = $1
       ORDER BY wd.created_at DESC
       LIMIT 300`,
      [req.company.id]
    );
    return res.json({ deliveries: r.rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to list webhook deliveries' });
  }
});

// Backup & restore procedures metadata
router.post('/backups', async (req, res) => {
  try {
    const { storage_uri, checksum_sha256 = null, snapshot_metadata = {} } = req.body || {};
    if (!storage_uri) return res.status(400).json({ error: 'storage_uri is required' });
    const ins = await query(
      `INSERT INTO backup_records (company_id, storage_uri, checksum_sha256, snapshot_metadata, status, created_by)
       VALUES ($1,$2,$3,$4::jsonb,'created',$5)
       RETURNING *`,
      [req.company.id, String(storage_uri), checksum_sha256 ? String(checksum_sha256) : null, JSON.stringify(snapshot_metadata || {}), req.user.id]
    );
    return res.status(201).json({ backup: ins.rows[0] });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to record backup' });
  }
});

router.get('/backups', async (req, res) => {
  try {
    const r = await query(
      `SELECT * FROM backup_records WHERE company_id = $1 ORDER BY created_at DESC LIMIT 200`,
      [req.company.id]
    );
    return res.json({ backups: r.rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to list backups' });
  }
});

router.post('/restores', async (req, res) => {
  try {
    const { backup_id, note = null } = req.body || {};
    if (!backup_id) return res.status(400).json({ error: 'backup_id is required' });
    const b = await query(`SELECT id FROM backup_records WHERE id = $1 AND company_id = $2`, [backup_id, req.company.id]);
    if (!b.rows.length) return res.status(404).json({ error: 'Backup not found' });
    const ins = await query(
      `INSERT INTO restore_requests (company_id, backup_id, status, requested_by, note)
       VALUES ($1,$2,'requested',$3,$4)
       RETURNING *`,
      [req.company.id, backup_id, req.user.id, note ? String(note) : null]
    );
    return res.status(201).json({ restore_request: ins.rows[0] });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to create restore request' });
  }
});

router.post('/restores/:id/approve', async (req, res) => {
  try {
    const upd = await query(
      `UPDATE restore_requests
       SET status = 'approved', approved_by = $1
       WHERE id = $2 AND company_id = $3
       RETURNING *`,
      [req.user.id, req.params.id, req.company.id]
    );
    if (!upd.rows.length) return res.status(404).json({ error: 'Restore request not found' });
    return res.json({ restore_request: upd.rows[0] });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to approve restore request' });
  }
});

router.post('/restores/:id/complete', async (req, res) => {
  try {
    const upd = await query(
      `UPDATE restore_requests
       SET status = 'completed', completed_at = NOW()
       WHERE id = $1 AND company_id = $2
       RETURNING *`,
      [req.params.id, req.company.id]
    );
    if (!upd.rows.length) return res.status(404).json({ error: 'Restore request not found' });
    return res.json({ restore_request: upd.rows[0] });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to complete restore request' });
  }
});

export default router;

