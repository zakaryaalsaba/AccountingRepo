import { Router } from 'express';
import { pool, query } from '../db.js';
import { authRequired } from '../middleware/auth.js';
import { companyContext } from '../middleware/companyContext.js';
import { assertDateOpen } from '../utils/periodLocks.js';
import { recurringSchemaHint, recurringTablesExist } from '../utils/recurringSchema.js';

const router = Router();
router.use(authRequired, companyContext);

function addByFrequency(dateStr, frequency, intervalCount) {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  const n = Number(intervalCount || 1);
  if (frequency === 'daily') d.setUTCDate(d.getUTCDate() + n);
  else if (frequency === 'weekly') d.setUTCDate(d.getUTCDate() + 7 * n);
  else if (frequency === 'monthly') d.setUTCMonth(d.getUTCMonth() + n);
  else if (frequency === 'quarterly') d.setUTCMonth(d.getUTCMonth() + 3 * n);
  else d.setUTCFullYear(d.getUTCFullYear() + n);
  return d.toISOString().slice(0, 10);
}

function r2(v) {
  return Math.round(Number(v) * 100) / 100;
}

async function createJournal(client, companyId, runDate, payload, label) {
  const lines = Array.isArray(payload?.lines) ? payload.lines : [];
  if (lines.length < 2) {
    const err = new Error('payload.lines must include at least two lines');
    err.status = 400;
    throw err;
  }
  let d = 0;
  let c = 0;
  for (const ln of lines) {
    d += r2(ln.debit || 0);
    c += r2(ln.credit || 0);
  }
  if (r2(d) !== r2(c)) {
    const err = new Error('Recurring journal is not balanced');
    err.status = 400;
    throw err;
  }
  const tx = await client.query(
    `INSERT INTO transactions (company_id, entry_date, description, reference)
     VALUES ($1,$2::date,$3,$4) RETURNING *`,
    [companyId, runDate, payload.description || label, payload.reference || null]
  );
  for (const ln of lines) {
    await client.query(
      `INSERT INTO transaction_lines (transaction_id, account_id, debit, credit)
       VALUES ($1,$2,$3,$4)`,
      [tx.rows[0].id, ln.account_id, r2(ln.debit || 0), r2(ln.credit || 0)]
    );
  }
  return tx.rows[0];
}

router.use(async (_req, res, next) => {
  if (!(await recurringTablesExist())) {
    return res.status(503).json({ error: 'Recurring schema not installed.', hint: recurringSchemaHint() });
  }
  return next();
});

router.get('/templates', async (req, res) => {
  try {
    const r = await query(
      `SELECT * FROM recurring_templates WHERE company_id = $1 ORDER BY created_at DESC`,
      [req.company.id]
    );
    return res.json({ templates: r.rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to list recurring templates' });
  }
});

router.post('/templates', async (req, res) => {
  try {
    const {
      type,
      name,
      frequency = 'monthly',
      interval_count = 1,
      start_date,
      end_date = null,
      next_run_date,
      auto_post = false,
      auto_reverse = false,
      reverse_after_days = 1,
      payload = {},
      is_active = true,
    } = req.body || {};
    if (!type || !name || !start_date) {
      return res.status(400).json({ error: 'type, name, start_date are required' });
    }
    const ins = await query(
      `INSERT INTO recurring_templates (
         company_id, type, name, frequency, interval_count, start_date, end_date, next_run_date,
         auto_post, auto_reverse, reverse_after_days, payload, is_active
       )
       VALUES ($1,$2::recurring_template_type,$3,$4::recurrence_frequency,$5,$6::date,$7::date,$8::date,$9,$10,$11,$12::jsonb,$13)
       RETURNING *`,
      [
        req.company.id,
        type,
        String(name).trim(),
        frequency,
        Number(interval_count || 1),
        start_date,
        end_date,
        next_run_date || start_date,
        Boolean(auto_post),
        Boolean(auto_reverse),
        Number(reverse_after_days || 1),
        JSON.stringify(payload || {}),
        Boolean(is_active),
      ]
    );
    return res.status(201).json({ template: ins.rows[0] });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to create recurring template' });
  }
});

router.post('/run', async (req, res) => {
  const { as_of } = req.body || {};
  const asOf = as_of || new Date().toISOString().slice(0, 10);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const templates = await client.query(
      `SELECT *
       FROM recurring_templates
       WHERE company_id = $1
         AND is_active = TRUE
         AND next_run_date <= $2::date
       ORDER BY next_run_date ASC`,
      [req.company.id, asOf]
    );
    let posted = 0;
    for (const t of templates.rows) {
      const runDate = t.next_run_date;
      try {
        await assertDateOpen(req.company.id, runDate, client);
        let tx = null;
        if (t.type === 'journal' || t.type === 'accrual' || t.type === 'prepayment') {
          tx = await createJournal(client, req.company.id, runDate, t.payload, `Recurring ${t.type}`);
          if (t.auto_reverse) {
            const reverseDate = new Date(`${runDate}T00:00:00.000Z`);
            reverseDate.setUTCDate(reverseDate.getUTCDate() + Number(t.reverse_after_days || 1));
            await client.query(
              `INSERT INTO journal_auto_reversals (company_id, source_transaction_id, reverse_on_date)
               VALUES ($1,$2,$3::date)
               ON CONFLICT (source_transaction_id) DO NOTHING`,
              [req.company.id, tx.id, reverseDate.toISOString().slice(0, 10)]
            );
          }
        }
        await client.query(
          `INSERT INTO recurring_runs (company_id, template_id, run_date, status, result_transaction_id, message)
           VALUES ($1,$2,$3::date,'posted',$4,$5)`,
          [req.company.id, t.id, runDate, tx?.id || null, 'Posted']
        );
        const nextRun = addByFrequency(runDate, t.frequency, t.interval_count);
        const stillActive = t.end_date ? nextRun <= String(t.end_date).slice(0, 10) : true;
        await client.query(
          `UPDATE recurring_templates
           SET next_run_date = $1::date,
               last_run_at = NOW(),
               is_active = $2,
               updated_at = NOW()
           WHERE id = $3 AND company_id = $4`,
          [nextRun, stillActive, t.id, req.company.id]
        );
        posted += 1;
      } catch (err) {
        await client.query(
          `INSERT INTO recurring_runs (company_id, template_id, run_date, status, message)
           VALUES ($1,$2,$3::date,'failed',$4)`,
          [req.company.id, t.id, runDate, err.message]
        );
      }
    }
    await client.query('COMMIT');
    return res.json({ ok: true, posted_templates: posted });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    return res.status(500).json({ error: 'Failed to run recurring templates' });
  } finally {
    client.release();
  }
});

router.post('/reverse-due', async (req, res) => {
  const { as_of } = req.body || {};
  const asOf = as_of || new Date().toISOString().slice(0, 10);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const due = await client.query(
      `SELECT * FROM journal_auto_reversals
       WHERE company_id = $1
         AND reversed_transaction_id IS NULL
         AND reverse_on_date <= $2::date
       ORDER BY reverse_on_date ASC`,
      [req.company.id, asOf]
    );
    let reversed = 0;
    for (const row of due.rows) {
      const src = await client.query(
        `SELECT * FROM transactions WHERE id = $1 AND company_id = $2`,
        [row.source_transaction_id, req.company.id]
      );
      if (!src.rows.length) continue;
      await assertDateOpen(req.company.id, row.reverse_on_date, client);
      const lines = await client.query(
        `SELECT * FROM transaction_lines WHERE transaction_id = $1 ORDER BY id`,
        [row.source_transaction_id]
      );
      const tx = await client.query(
        `INSERT INTO transactions (company_id, entry_date, description, reference)
         VALUES ($1,$2::date,$3,$4)
         RETURNING id`,
        [
          req.company.id,
          row.reverse_on_date,
          `Auto reversal for ${row.source_transaction_id}`,
          `REV-${row.source_transaction_id.slice(0, 8)}`,
        ]
      );
      const rid = tx.rows[0].id;
      for (const ln of lines.rows) {
        await client.query(
          `INSERT INTO transaction_lines (transaction_id, account_id, debit, credit)
           VALUES ($1,$2,$3,$4)`,
          [rid, ln.account_id, ln.credit, ln.debit]
        );
      }
      await client.query(
        `UPDATE journal_auto_reversals
         SET reversed_transaction_id = $1
         WHERE id = $2 AND company_id = $3`,
        [rid, row.id, req.company.id]
      );
      reversed += 1;
    }
    await client.query('COMMIT');
    return res.json({ ok: true, reversed_entries: reversed });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    return res.status(500).json({ error: 'Failed to reverse due journals' });
  } finally {
    client.release();
  }
});

export default router;

