import { Router } from 'express';
import { pool, query } from '../db.js';
import { authRequired } from '../middleware/auth.js';
import { companyContext } from '../middleware/companyContext.js';
import { attachAuthorization, requirePermission } from '../middleware/authorization.js';
import { assertRoleAmountLimit } from '../middleware/authorization.js';
import { assertDateOpen } from '../utils/periodLocks.js';
import { assertFiscalYearOpen } from '../utils/fiscalSchema.js';
import { chequeSchemaHint, chequeTablesExist } from '../utils/chequeSchema.js';
import { writeAuditEvent } from '../utils/auditLog.js';
import { workflowTablesExist } from '../utils/workflowSchema.js';

const router = Router();
router.use(authRequired, companyContext);
router.use(attachAuthorization);

const STATUSES = new Set([
  'received',
  'issued',
  'under_collection',
  'cleared',
  'bounced',
  'cancelled',
  'replaced',
]);

function r2(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}

async function postChequeTransitionTx(client, { companyId, cheque, toStatus, eventDate }) {
  const lines = [];
  const amount = r2(cheque.amount);
  const src = cheque.source_account_id;
  const clr = cheque.clearing_account_id;
  const cash = cheque.cash_account_id;
  const incoming = cheque.direction === 'incoming';

  if ((toStatus === 'received' && incoming) || (toStatus === 'issued' && !incoming)) {
    // Initial recognition to clearing.
    if (!src || !clr) return null;
    if (incoming) {
      lines.push({ account_id: clr, debit: amount, credit: 0 });
      lines.push({ account_id: src, debit: 0, credit: amount });
    } else {
      lines.push({ account_id: src, debit: amount, credit: 0 });
      lines.push({ account_id: clr, debit: 0, credit: amount });
    }
  } else if (toStatus === 'cleared') {
    // Move between clearing and cash.
    if (!clr || !cash) return null;
    if (incoming) {
      lines.push({ account_id: cash, debit: amount, credit: 0 });
      lines.push({ account_id: clr, debit: 0, credit: amount });
    } else {
      lines.push({ account_id: clr, debit: amount, credit: 0 });
      lines.push({ account_id: cash, debit: 0, credit: amount });
    }
  } else if (toStatus === 'bounced') {
    // Reverse clearing effect back to source/cash.
    if (incoming) {
      if (!src || !clr) return null;
      lines.push({ account_id: src, debit: amount, credit: 0 });
      lines.push({ account_id: clr, debit: 0, credit: amount });
    } else {
      if (!src || !cash) return null;
      lines.push({ account_id: cash, debit: amount, credit: 0 });
      lines.push({ account_id: src, debit: 0, credit: amount });
    }
  }

  if (!lines.length) return null;
  const tx = await client.query(
    `INSERT INTO transactions (company_id, entry_date, description, reference, status, posted_by, posted_at)
     VALUES ($1,$2,$3,$4,'posted',$5,NOW())
     RETURNING *`,
    [
      companyId,
      eventDate,
      `Cheque ${toStatus}: ${cheque.cheque_number}`,
      `CHQ-${cheque.cheque_number}-${toStatus}`,
      cheque.created_by || null,
    ]
  );
  for (const ln of lines) {
    await client.query(
      `INSERT INTO transaction_lines (transaction_id, account_id, debit, credit)
       VALUES ($1,$2,$3,$4)`,
      [tx.rows[0].id, ln.account_id, r2(ln.debit), r2(ln.credit)]
    );
  }
  return tx.rows[0].id;
}

router.use(async (_req, res, next) => {
  if (await chequeTablesExist()) return next();
  return res.status(503).json({ error: 'Cheque schema not installed.', hint: chequeSchemaHint() });
});

router.get('/', async (req, res) => {
  try {
    const { status, from, to, account_id, counterparty_type, counterparty_name } = req.query;
    const params = [req.company.id];
    let i = 2;
    let sql = `SELECT *
               FROM cheques
               WHERE company_id = $1`;
    if (status) {
      sql += ` AND status = $${i++}::cheque_status`;
      params.push(String(status));
    }
    if (from) {
      sql += ` AND issue_date >= $${i++}::date`;
      params.push(String(from));
    }
    if (to) {
      sql += ` AND issue_date <= $${i++}::date`;
      params.push(String(to));
    }
    if (account_id) {
      sql += ` AND (source_account_id = $${i}::uuid OR clearing_account_id = $${i}::uuid OR cash_account_id = $${i}::uuid)`;
      params.push(String(account_id));
      i += 1;
    }
    if (counterparty_type) {
      sql += ` AND counterparty_type = $${i++}`;
      params.push(String(counterparty_type));
    }
    if (counterparty_name) {
      sql += ` AND counterparty_name ILIKE $${i++}`;
      params.push(`%${String(counterparty_name)}%`);
    }
    sql += ` ORDER BY due_date ASC, issue_date DESC, created_at DESC`;
    const r = await query(sql, params);
    return res.json({ cheques: r.rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to list cheques' });
  }
});

router.post('/', async (req, res) => {
  return requirePermission('transactions.create')(req, res, async () => {
    const {
      cheque_number,
      direction,
      status,
      amount,
      currency_code = null,
      issue_date,
      due_date,
      counterparty_type = null,
      counterparty_id = null,
      counterparty_name = null,
      source_account_id = null,
      clearing_account_id = null,
      cash_account_id = null,
      notes = null,
      event_reason = null,
      attachment_reference = null,
    } = req.body || {};
    if (!cheque_number || !direction || !status || !issue_date || !due_date) {
      return res.status(400).json({ error: 'cheque_number, direction, status, issue_date, due_date are required' });
    }
    if (!['incoming', 'outgoing'].includes(String(direction))) {
      return res.status(400).json({ error: 'direction must be incoming or outgoing' });
    }
    if (!STATUSES.has(String(status))) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    const amt = r2(amount);
    if (amt <= 0) return res.status(400).json({ error: 'amount must be positive' });
    if ((status === 'bounced' || status === 'cancelled') && (!event_reason || !attachment_reference)) {
      return res.status(400).json({ error: 'reason and attachment_reference are required for bounced/cancelled cheques' });
    }
    const client = await pool.connect();
    try {
      await assertRoleAmountLimit({
        companyId: req.company.id,
        role: req.authorization?.role || 'viewer',
        actionKey: 'cheques.create',
        amount: amt,
      });
      if (await workflowTablesExist()) {
        const needs = await query(
          `SELECT id
           FROM workflow_approval_rules
           WHERE company_id = $1
             AND doc_type = 'cheque.create'
             AND is_active = TRUE
             AND min_amount <= $2
           ORDER BY min_amount DESC
           LIMIT 1`,
          [req.company.id, amt]
        );
        if (needs.rows.length && !req.body?.approval_request_id) {
          return res.status(403).json({ error: 'Approval required for this cheque amount', required_doc_type: 'cheque.create' });
        }
      }
      await assertDateOpen(req.company.id, issue_date, client);
      await assertFiscalYearOpen(req.company.id, issue_date, client);
      await client.query('BEGIN');
      const ins = await client.query(
        `INSERT INTO cheques (
           company_id, cheque_number, direction, status, amount, currency_code, issue_date, due_date,
           counterparty_type, counterparty_id, counterparty_name, source_account_id, clearing_account_id,
           cash_account_id, notes, created_by
         )
         VALUES ($1,$2,$3::cheque_direction,$4::cheque_status,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         RETURNING *`,
        [
          req.company.id,
          String(cheque_number),
          String(direction),
          String(status),
          amt,
          currency_code ? String(currency_code).toUpperCase() : null,
          issue_date,
          due_date,
          counterparty_type ? String(counterparty_type) : null,
          counterparty_id ? String(counterparty_id) : null,
          counterparty_name ? String(counterparty_name) : null,
          source_account_id ? String(source_account_id) : null,
          clearing_account_id ? String(clearing_account_id) : null,
          cash_account_id ? String(cash_account_id) : null,
          notes ? String(notes) : null,
          req.user.id,
        ]
      );
      const cheque = ins.rows[0];
      const txId = await postChequeTransitionTx(client, {
        companyId: req.company.id,
        cheque,
        toStatus: cheque.status,
        eventDate: cheque.issue_date,
      });
      if (txId) {
        await client.query(
          `UPDATE cheques SET latest_transaction_id = $1 WHERE id = $2 AND company_id = $3`,
          [txId, cheque.id, req.company.id]
        );
      }
      await client.query(
        `INSERT INTO cheque_status_events (
           company_id, cheque_id, from_status, to_status, event_date, reason, attachment_reference, transaction_id, created_by
         )
         VALUES ($1,$2,NULL,$3::cheque_status,$4,$5,$6,$7,$8)`,
        [
          req.company.id,
          cheque.id,
          cheque.status,
          cheque.issue_date,
          event_reason ? String(event_reason) : null,
          attachment_reference ? String(attachment_reference) : null,
          txId,
          req.user.id,
        ]
      );
      await client.query('COMMIT');
      await writeAuditEvent({
        companyId: req.company.id,
        actorUserId: req.user.id,
        eventType: 'cheque.created',
        entityType: 'cheque',
        entityId: cheque.id,
        details: { status: cheque.status, direction: cheque.direction, cheque_number: cheque.cheque_number },
      });
      return res.status(201).json({ cheque: { ...cheque, latest_transaction_id: txId || null } });
    } catch (e) {
      await client.query('ROLLBACK');
      if (e.code === '23505') return res.status(409).json({ error: 'Cheque number already exists' });
      if (e.status === 400) return res.status(400).json({ error: e.message });
      console.error(e);
      return res.status(500).json({ error: 'Failed to create cheque' });
    } finally {
      client.release();
    }
  });
});

router.post('/:id/transition', async (req, res) => {
  return requirePermission('transactions.create')(req, res, async () => {
    const { to_status, event_date, reason = null, attachment_reference = null, replacement_cheque_payload = null, endorsement_to = null } = req.body || {};
    if (!to_status || !event_date) return res.status(400).json({ error: 'to_status and event_date are required' });
    if (!STATUSES.has(String(to_status))) return res.status(400).json({ error: 'Invalid to_status' });
    if ((to_status === 'bounced' || to_status === 'cancelled') && (!reason || !attachment_reference)) {
      return res.status(400).json({ error: 'reason and attachment_reference are required for bounced/cancelled' });
    }
    const client = await pool.connect();
    try {
      await assertDateOpen(req.company.id, event_date, client);
      await assertFiscalYearOpen(req.company.id, event_date, client);
      await client.query('BEGIN');
      if (await workflowTablesExist()) {
        const lock = await client.query(
          `SELECT id
           FROM workflow_entity_locks
           WHERE company_id = $1 AND doc_type = 'cheque' AND entity_id = $2
           LIMIT 1`,
          [req.company.id, req.params.id]
        );
        if (lock.rows.length) {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: 'Cheque is locked after approval and cannot be edited silently' });
        }
      }
      const cur = await client.query(
        `SELECT * FROM cheques WHERE id = $1 AND company_id = $2 FOR UPDATE`,
        [req.params.id, req.company.id]
      );
      if (!cur.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Cheque not found' });
      }
      const cheque = cur.rows[0];
      await assertRoleAmountLimit({
        companyId: req.company.id,
        role: req.authorization?.role || 'viewer',
        actionKey: 'cheques.transition',
        amount: cheque.amount,
      });
      let replacementChequeId = null;
      if (to_status === 'replaced') {
        if (!replacement_cheque_payload?.cheque_number || !replacement_cheque_payload?.due_date) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'replacement_cheque_payload with cheque_number and due_date is required' });
        }
        const rep = await client.query(
          `INSERT INTO cheques (
             company_id, cheque_number, direction, status, amount, currency_code, issue_date, due_date,
             counterparty_type, counterparty_id, counterparty_name, source_account_id, clearing_account_id,
             cash_account_id, notes, created_by
           )
           VALUES ($1,$2,$3::cheque_direction,'issued'::cheque_status,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
           RETURNING id`,
          [
            req.company.id,
            String(replacement_cheque_payload.cheque_number),
            cheque.direction,
            cheque.amount,
            cheque.currency_code,
            event_date,
            replacement_cheque_payload.due_date,
            cheque.counterparty_type,
            cheque.counterparty_id,
            cheque.counterparty_name,
            cheque.source_account_id,
            cheque.clearing_account_id,
            cheque.cash_account_id,
            replacement_cheque_payload.notes || null,
            req.user.id,
          ]
        );
        replacementChequeId = rep.rows[0].id;
      }
      const txId = await postChequeTransitionTx(client, {
        companyId: req.company.id,
        cheque,
        toStatus: String(to_status),
        eventDate: String(event_date),
      });
      const up = await client.query(
        `UPDATE cheques
         SET status = $3::cheque_status,
             replacement_cheque_id = COALESCE($4, replacement_cheque_id),
             endorsement_to = COALESCE($5, endorsement_to),
             latest_transaction_id = COALESCE($6, latest_transaction_id),
             updated_at = NOW()
         WHERE id = $1 AND company_id = $2
         RETURNING *`,
        [req.params.id, req.company.id, String(to_status), replacementChequeId, endorsement_to || null, txId]
      );
      await client.query(
        `INSERT INTO cheque_status_events (
           company_id, cheque_id, from_status, to_status, event_date, reason, attachment_reference, transaction_id, created_by
         )
         VALUES ($1,$2,$3::cheque_status,$4::cheque_status,$5,$6,$7,$8,$9)`,
        [
          req.company.id,
          req.params.id,
          cheque.status,
          String(to_status),
          String(event_date),
          reason ? String(reason) : null,
          attachment_reference ? String(attachment_reference) : null,
          txId,
          req.user.id,
        ]
      );
      await client.query('COMMIT');
      await writeAuditEvent({
        companyId: req.company.id,
        actorUserId: req.user.id,
        eventType: 'cheque.transition',
        entityType: 'cheque',
        entityId: req.params.id,
        details: { from_status: cheque.status, to_status: to_status, replacement_cheque_id: replacementChequeId },
      });
      return res.json({ cheque: up.rows[0] });
    } catch (e) {
      await client.query('ROLLBACK');
      if (e.status === 400) return res.status(400).json({ error: e.message });
      console.error(e);
      return res.status(500).json({ error: 'Failed to transition cheque status' });
    } finally {
      client.release();
    }
  });
});

router.get('/:id/events', async (req, res) => {
  try {
    const r = await query(
      `SELECT *
       FROM cheque_status_events
       WHERE company_id = $1 AND cheque_id = $2
       ORDER BY event_date DESC, created_at DESC`,
      [req.company.id, req.params.id]
    );
    return res.json({ events: r.rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to list cheque events' });
  }
});

router.get('/reports/portfolio', async (req, res) => {
  try {
    const { from, to, status } = req.query;
    const params = [req.company.id];
    let i = 2;
    let where = `WHERE company_id = $1`;
    if (from) {
      where += ` AND due_date >= $${i++}::date`;
      params.push(String(from));
    }
    if (to) {
      where += ` AND due_date <= $${i++}::date`;
      params.push(String(to));
    }
    if (status) {
      where += ` AND status = $${i++}::cheque_status`;
      params.push(String(status));
    }
    const byStatus = await query(
      `SELECT status, COUNT(*)::int AS count, COALESCE(SUM(amount),0)::numeric(18,2) AS amount
       FROM cheques
       ${where}
       GROUP BY status
       ORDER BY status`,
      params
    );
    const byCounterparty = await query(
      `SELECT COALESCE(counterparty_name,'-') AS counterparty_name,
              COUNT(*)::int AS count,
              COALESCE(SUM(amount),0)::numeric(18,2) AS amount
       FROM cheques
       ${where}
       GROUP BY counterparty_name
       ORDER BY amount DESC, counterparty_name ASC
       LIMIT 50`,
      params
    );
    const byAccount = await query(
      `SELECT COALESCE(a.name,'-') AS account_name,
              COUNT(*)::int AS count,
              COALESCE(SUM(c.amount),0)::numeric(18,2) AS amount
       FROM cheques c
       LEFT JOIN accounts a ON a.id = c.source_account_id
       ${where.replace('company_id = $1', 'c.company_id = $1')}
       GROUP BY a.name
       ORDER BY amount DESC, account_name ASC`,
      params
    );
    return res.json({
      summary_by_status: byStatus.rows,
      summary_by_counterparty: byCounterparty.rows,
      summary_by_account: byAccount.rows,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to build cheque portfolio report' });
  }
});

router.get('/reports/reminders', async (req, res) => {
  try {
    const days = Math.min(60, Math.max(1, Number(req.query.days || 7)));
    const r = await query(
      `SELECT id, cheque_number, direction, status, amount, due_date, counterparty_name
       FROM cheques
       WHERE company_id = $1
         AND status IN ('received','issued','under_collection')
         AND due_date BETWEEN CURRENT_DATE AND (CURRENT_DATE + ($2 || ' days')::interval)::date
       ORDER BY due_date ASC, amount DESC`,
      [req.company.id, String(days)]
    );
    return res.json({ days, reminders: r.rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to load cheque reminders' });
  }
});

export default router;
