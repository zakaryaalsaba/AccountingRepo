import { Router } from 'express';
import { pool, query } from '../db.js';
import { authRequired } from '../middleware/auth.js';
import { companyContext } from '../middleware/companyContext.js';
import { attachAuthorization, requireRole } from '../middleware/authorization.js';
import { bankSettlementSchemaHint, bankSettlementTablesExist } from '../utils/bankSettlementSchema.js';

const router = Router();
router.use(authRequired, companyContext);
router.use(attachAuthorization);

router.get('/', async (req, res) => {
  try {
    const r = await query(
      `SELECT *
       FROM bank_accounts
       WHERE company_id = $1
       ORDER BY created_at DESC`,
      [req.company.id]
    );
    return res.json({ bank_accounts: r.rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to list bank accounts' });
  }
});

router.post('/', async (req, res) => {
  try {
    const { name, bank_name, account_number_masked, currency_code, opening_balance } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'name is required' });
    }
    const ins = await query(
      `INSERT INTO bank_accounts (
         company_id, name, bank_name, account_number_masked, currency_code, opening_balance
       )
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        req.company.id,
        String(name).trim(),
        bank_name ? String(bank_name).trim() : null,
        account_number_masked ? String(account_number_masked).trim() : null,
        currency_code ? String(currency_code).trim().toUpperCase() : 'SAR',
        Number(opening_balance || 0),
      ]
    );
    return res.status(201).json({ bank_account: ins.rows[0] });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to create bank account' });
  }
});

router.patch('/:id', async (req, res) => {
  try {
    const cur = await query(
      `SELECT * FROM bank_accounts WHERE id = $1 AND company_id = $2`,
      [req.params.id, req.company.id]
    );
    if (!cur.rows.length) return res.status(404).json({ error: 'Not found' });
    const row = cur.rows[0];
    const body = req.body || {};
    const upd = await query(
      `UPDATE bank_accounts
       SET name = $1,
           bank_name = $2,
           account_number_masked = $3,
           currency_code = $4,
           opening_balance = $5,
           is_active = $6
       WHERE id = $7 AND company_id = $8
       RETURNING *`,
      [
        body.name !== undefined ? String(body.name).trim() : row.name,
        body.bank_name !== undefined ? (body.bank_name ? String(body.bank_name).trim() : null) : row.bank_name,
        body.account_number_masked !== undefined
          ? (body.account_number_masked ? String(body.account_number_masked).trim() : null)
          : row.account_number_masked,
        body.currency_code !== undefined
          ? String(body.currency_code).trim().toUpperCase()
          : row.currency_code,
        body.opening_balance !== undefined ? Number(body.opening_balance) : row.opening_balance,
        body.is_active !== undefined ? Boolean(body.is_active) : row.is_active,
        req.params.id,
        req.company.id,
      ]
    );
    return res.json({ bank_account: upd.rows[0] });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to update bank account' });
  }
});

router.post('/statements/import-csv', async (req, res) => {
  const { bank_account_id, source_name, rows } = req.body || {};
  if (!bank_account_id || !Array.isArray(rows) || !rows.length) {
    return res.status(400).json({ error: 'bank_account_id and non-empty rows[] are required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ba = await client.query(
      `SELECT id FROM bank_accounts WHERE id = $1 AND company_id = $2`,
      [bank_account_id, req.company.id]
    );
    if (!ba.rows.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Invalid bank_account_id' });
    }

    const imp = await client.query(
      `INSERT INTO bank_statement_imports (company_id, bank_account_id, source_name, rows_count, imported_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [req.company.id, bank_account_id, source_name || 'csv_import', rows.length, req.user.id]
    );
    const importId = imp.rows[0].id;

    const inserted = [];
    for (const raw of rows) {
      const statementDate = raw.date || raw.statement_date;
      const amount = Number(raw.amount);
      if (!statementDate || Number.isNaN(amount)) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: 'Each row requires date/statement_date and numeric amount',
        });
      }
      const ins = await client.query(
        `INSERT INTO bank_statement_lines (
           company_id, bank_account_id, import_id, statement_date, description,
           reference, amount, running_balance
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [
          req.company.id,
          bank_account_id,
          importId,
          statementDate,
          raw.description ? String(raw.description) : null,
          raw.reference ? String(raw.reference) : null,
          amount,
          raw.balance !== undefined && raw.balance !== null ? Number(raw.balance) : null,
        ]
      );
      inserted.push(ins.rows[0]);
    }

    await client.query('COMMIT');
    return res.status(201).json({
      import: imp.rows[0],
      lines_inserted: inserted.length,
      lines: inserted,
    });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    return res.status(500).json({ error: 'Failed to import statement rows' });
  } finally {
    client.release();
  }
});

router.get('/statements/lines', async (req, res) => {
  try {
    const { bank_account_id, from, to, reconciled, limit = '200', offset = '0' } = req.query;
    if (!bank_account_id) {
      return res.status(400).json({ error: 'bank_account_id query param is required' });
    }
    const acc = await query(
      `SELECT id FROM bank_accounts WHERE id = $1 AND company_id = $2`,
      [bank_account_id, req.company.id]
    );
    if (!acc.rows.length) return res.status(400).json({ error: 'Invalid bank_account_id' });

    let sql = `
      SELECT *
      FROM bank_statement_lines
      WHERE company_id = $1
        AND bank_account_id = $2`;
    const params = [req.company.id, bank_account_id];
    let i = 3;
    if (from) {
      sql += ` AND statement_date >= $${i++}`;
      params.push(from);
    }
    if (to) {
      sql += ` AND statement_date <= $${i++}`;
      params.push(to);
    }
    if (reconciled === 'true' || reconciled === 'false') {
      sql += ` AND is_reconciled = $${i++}`;
      params.push(reconciled === 'true');
    }
    const lim = Math.min(1000, Math.max(1, parseInt(limit, 10) || 200));
    const off = Math.max(0, parseInt(offset, 10) || 0);
    sql += ` ORDER BY statement_date DESC, created_at DESC LIMIT $${i} OFFSET $${i + 1}`;
    params.push(lim, off);
    const r = await query(sql, params);
    return res.json({ lines: r.rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to list statement lines' });
  }
});

router.post('/statements/reconcile', async (req, res) => {
  try {
    const { line_id, transaction_id } = req.body || {};
    if (!line_id) return res.status(400).json({ error: 'line_id is required' });

    const line = await query(
      `SELECT *
       FROM bank_statement_lines
       WHERE id = $1 AND company_id = $2`,
      [line_id, req.company.id]
    );
    if (!line.rows.length) return res.status(404).json({ error: 'Statement line not found' });

    if (transaction_id) {
      const tx = await query(
        `SELECT id FROM transactions WHERE id = $1 AND company_id = $2`,
        [transaction_id, req.company.id]
      );
      if (!tx.rows.length) {
        return res.status(400).json({ error: 'Invalid transaction_id for this company' });
      }
    }

    const upd = await query(
      `UPDATE bank_statement_lines
       SET is_reconciled = $1,
           reconciled_transaction_id = $2,
           reconciled_by = $3,
           reconciled_at = CASE WHEN $1 = TRUE THEN NOW() ELSE NULL END
       WHERE id = $4 AND company_id = $5
       RETURNING *`,
      [Boolean(transaction_id), transaction_id || null, transaction_id ? req.user.id : null, line_id, req.company.id]
    );
    return res.json({ line: upd.rows[0] });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to reconcile line' });
  }
});

router.get('/statements/reconciliation-summary', async (req, res) => {
  try {
    const { bank_account_id, from, to } = req.query;
    if (!bank_account_id) {
      return res.status(400).json({ error: 'bank_account_id query param is required' });
    }
    const acc = await query(
      `SELECT id FROM bank_accounts WHERE id = $1 AND company_id = $2`,
      [bank_account_id, req.company.id]
    );
    if (!acc.rows.length) return res.status(400).json({ error: 'Invalid bank_account_id' });

    let where = `company_id = $1 AND bank_account_id = $2`;
    const params = [req.company.id, bank_account_id];
    let i = 3;
    if (from) {
      where += ` AND statement_date >= $${i++}`;
      params.push(from);
    }
    if (to) {
      where += ` AND statement_date <= $${i++}`;
      params.push(to);
    }

    const sums = await query(
      `SELECT
         COUNT(*)::int AS total_lines,
         COALESCE(SUM(amount), 0)::numeric(18,2) AS total_amount,
         COALESCE(SUM(CASE WHEN is_reconciled THEN amount ELSE 0 END), 0)::numeric(18,2) AS reconciled_amount,
         COALESCE(SUM(CASE WHEN NOT is_reconciled THEN amount ELSE 0 END), 0)::numeric(18,2) AS unreconciled_amount,
         COUNT(*) FILTER (WHERE is_reconciled)::int AS reconciled_lines,
         COUNT(*) FILTER (WHERE NOT is_reconciled)::int AS unreconciled_lines
       FROM bank_statement_lines
       WHERE ${where}`,
      params
    );
    const row = sums.rows[0];
    return res.json({
      summary: {
        total_lines: row.total_lines,
        reconciled_lines: row.reconciled_lines,
        unreconciled_lines: row.unreconciled_lines,
        total_amount: Number(row.total_amount),
        reconciled_amount: Number(row.reconciled_amount),
        unreconciled_amount: Number(row.unreconciled_amount),
      },
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to load reconciliation summary' });
  }
});

router.get('/statements/reconciliation-report', async (req, res) => {
  try {
    const { bank_account_id, from, to } = req.query;
    if (!bank_account_id || !from || !to) {
      return res.status(400).json({
        error: 'bank_account_id, from, and to query params are required',
      });
    }
    const acc = await query(
      `SELECT id FROM bank_accounts WHERE id = $1 AND company_id = $2`,
      [bank_account_id, req.company.id]
    );
    if (!acc.rows.length) return res.status(400).json({ error: 'Invalid bank_account_id' });

    const daily = await query(
      `SELECT statement_date,
              COUNT(*)::int AS total_lines,
              COUNT(*) FILTER (WHERE is_reconciled)::int AS reconciled_lines,
              COUNT(*) FILTER (WHERE NOT is_reconciled)::int AS unreconciled_lines,
              COALESCE(SUM(amount), 0)::numeric(18,2) AS total_amount,
              COALESCE(SUM(CASE WHEN is_reconciled THEN amount ELSE 0 END), 0)::numeric(18,2) AS reconciled_amount,
              COALESCE(SUM(CASE WHEN NOT is_reconciled THEN amount ELSE 0 END), 0)::numeric(18,2) AS unreconciled_amount
       FROM bank_statement_lines
       WHERE company_id = $1
         AND bank_account_id = $2
         AND statement_date >= $3::date
         AND statement_date <= $4::date
       GROUP BY statement_date
       ORDER BY statement_date ASC`,
      [req.company.id, bank_account_id, from, to]
    );

    const summary = await query(
      `SELECT
         COUNT(*)::int AS total_lines,
         COUNT(*) FILTER (WHERE is_reconciled)::int AS reconciled_lines,
         COUNT(*) FILTER (WHERE NOT is_reconciled)::int AS unreconciled_lines,
         COALESCE(SUM(amount), 0)::numeric(18,2) AS total_amount,
         COALESCE(SUM(CASE WHEN is_reconciled THEN amount ELSE 0 END), 0)::numeric(18,2) AS reconciled_amount,
         COALESCE(SUM(CASE WHEN NOT is_reconciled THEN amount ELSE 0 END), 0)::numeric(18,2) AS unreconciled_amount
       FROM bank_statement_lines
       WHERE company_id = $1
         AND bank_account_id = $2
         AND statement_date >= $3::date
         AND statement_date <= $4::date`,
      [req.company.id, bank_account_id, from, to]
    );

    const s = summary.rows[0];
    const rate =
      Number(s.total_lines) > 0
        ? Math.round((Number(s.reconciled_lines) / Number(s.total_lines)) * 10000) / 100
        : 0;

    return res.json({
      period: { from, to },
      summary: {
        total_lines: Number(s.total_lines),
        reconciled_lines: Number(s.reconciled_lines),
        unreconciled_lines: Number(s.unreconciled_lines),
        total_amount: Number(s.total_amount),
        reconciled_amount: Number(s.reconciled_amount),
        unreconciled_amount: Number(s.unreconciled_amount),
        reconciliation_rate_percent: rate,
      },
      daily: daily.rows.map((r) => ({
        statement_date: r.statement_date,
        total_lines: Number(r.total_lines),
        reconciled_lines: Number(r.reconciled_lines),
        unreconciled_lines: Number(r.unreconciled_lines),
        total_amount: Number(r.total_amount),
        reconciled_amount: Number(r.reconciled_amount),
        unreconciled_amount: Number(r.unreconciled_amount),
      })),
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to load reconciliation report' });
  }
});

router.get('/statements/reconciliation-drilldown', async (req, res) => {
  try {
    const { bank_account_id, from, to, status = 'all', limit = '200', offset = '0' } = req.query;
    if (!bank_account_id || !from || !to) {
      return res.status(400).json({
        error: 'bank_account_id, from, and to query params are required',
      });
    }
    const acc = await query(
      `SELECT id FROM bank_accounts WHERE id = $1 AND company_id = $2`,
      [bank_account_id, req.company.id]
    );
    if (!acc.rows.length) return res.status(400).json({ error: 'Invalid bank_account_id' });

    const lim = Math.min(1000, Math.max(1, parseInt(limit, 10) || 200));
    const off = Math.max(0, parseInt(offset, 10) || 0);
    const params = [req.company.id, bank_account_id, from, to];
    let where = `bsl.company_id = $1
                 AND bsl.bank_account_id = $2
                 AND bsl.statement_date >= $3::date
                 AND bsl.statement_date <= $4::date`;
    if (status === 'reconciled') where += ` AND bsl.is_reconciled = TRUE`;
    else if (status === 'unreconciled') where += ` AND bsl.is_reconciled = FALSE`;

    const r = await query(
      `SELECT bsl.*,
              t.id AS transaction_id,
              t.entry_date AS transaction_date,
              t.description AS transaction_description,
              t.reference AS transaction_reference
       FROM bank_statement_lines bsl
       LEFT JOIN transactions t
         ON t.id = bsl.reconciled_transaction_id
         AND t.company_id = bsl.company_id
       WHERE ${where}
       ORDER BY bsl.statement_date DESC, bsl.created_at DESC
       LIMIT ${lim} OFFSET ${off}`,
      params
    );

    return res.json({ lines: r.rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to load reconciliation drilldown' });
  }
});

router.get('/statements/reconciliation-exceptions', async (req, res) => {
  try {
    const { bank_account_id, from, to, amount_tolerance = '0.01' } = req.query;
    if (!bank_account_id || !from || !to) {
      return res.status(400).json({
        error: 'bank_account_id, from, and to query params are required',
      });
    }
    const acc = await query(
      `SELECT id FROM bank_accounts WHERE id = $1 AND company_id = $2`,
      [bank_account_id, req.company.id]
    );
    if (!acc.rows.length) return res.status(400).json({ error: 'Invalid bank_account_id' });

    const tol = Math.max(0, Number(amount_tolerance) || 0.01);
    const r = await query(
      `SELECT bsl.id,
              bsl.statement_date,
              bsl.description,
              bsl.reference,
              bsl.amount,
              bsl.is_reconciled,
              bsl.reconciled_transaction_id,
              t.entry_date AS transaction_date,
              t.description AS transaction_description,
              tx.t_debit,
              tx.t_credit,
              tx.net_amount,
              CASE
                WHEN bsl.is_reconciled = FALSE THEN 'unreconciled'
                WHEN bsl.reconciled_transaction_id IS NULL THEN 'missing_transaction_link'
                WHEN ABS(COALESCE(tx.net_amount, 0) - bsl.amount) > $5::numeric THEN 'amount_mismatch'
                ELSE 'ok'
              END AS exception_type
       FROM bank_statement_lines bsl
       LEFT JOIN transactions t
         ON t.id = bsl.reconciled_transaction_id
         AND t.company_id = bsl.company_id
       LEFT JOIN (
         SELECT tl.transaction_id,
                SUM(tl.debit)::numeric(18,2) AS t_debit,
                SUM(tl.credit)::numeric(18,2) AS t_credit,
                (SUM(tl.debit) - SUM(tl.credit))::numeric(18,2) AS net_amount
         FROM transaction_lines tl
         GROUP BY tl.transaction_id
       ) tx ON tx.transaction_id = bsl.reconciled_transaction_id
       WHERE bsl.company_id = $1
         AND bsl.bank_account_id = $2
         AND bsl.statement_date >= $3::date
         AND bsl.statement_date <= $4::date
         AND (
           bsl.is_reconciled = FALSE
           OR bsl.reconciled_transaction_id IS NULL
           OR ABS(COALESCE(tx.net_amount, 0) - bsl.amount) > $5::numeric
         )
       ORDER BY bsl.statement_date DESC, bsl.created_at DESC`,
      [req.company.id, bank_account_id, from, to, tol]
    );
    return res.json({ exceptions: r.rows, amount_tolerance: tol });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to load reconciliation exceptions' });
  }
});

router.get('/statements/match-suggestions', async (req, res) => {
  try {
    const { bank_account_id, line_id, date_window_days = '3' } = req.query;
    if (!bank_account_id || !line_id) {
      return res.status(400).json({ error: 'bank_account_id and line_id are required' });
    }
    const wnd = Math.max(0, Math.min(30, Number(date_window_days) || 3));
    const line = await query(
      `SELECT *
       FROM bank_statement_lines
       WHERE id = $1 AND company_id = $2 AND bank_account_id = $3`,
      [line_id, req.company.id, bank_account_id]
    );
    if (!line.rows.length) return res.status(404).json({ error: 'Statement line not found' });
    const l = line.rows[0];
    const exact = await query(
      `SELECT t.id, t.entry_date, t.description, t.reference,
              ABS((COALESCE(tx.net_amount,0)::numeric(18,2)) - $4::numeric(18,2)) AS amount_diff
       FROM transactions t
       LEFT JOIN (
         SELECT tl.transaction_id, (SUM(tl.debit) - SUM(tl.credit))::numeric(18,2) AS net_amount
         FROM transaction_lines tl
         GROUP BY tl.transaction_id
       ) tx ON tx.transaction_id = t.id
       WHERE t.company_id = $1
         AND t.entry_date BETWEEN ($2::date - ($5 || ' days')::interval)::date
                             AND ($3::date + ($5 || ' days')::interval)::date
         AND ABS(COALESCE(tx.net_amount,0) - $4::numeric) < 0.01
       ORDER BY amount_diff ASC, t.entry_date DESC
       LIMIT 50`,
      [req.company.id, l.statement_date, l.statement_date, l.amount, String(wnd)]
    );
    const fuzzy = await query(
      `SELECT t.id, t.entry_date, t.description, t.reference,
              ABS((COALESCE(tx.net_amount,0)::numeric(18,2)) - $4::numeric(18,2)) AS amount_diff
       FROM transactions t
       LEFT JOIN (
         SELECT tl.transaction_id, (SUM(tl.debit) - SUM(tl.credit))::numeric(18,2) AS net_amount
         FROM transaction_lines tl
         GROUP BY tl.transaction_id
       ) tx ON tx.transaction_id = t.id
       WHERE t.company_id = $1
         AND t.entry_date BETWEEN ($2::date - ($5 || ' days')::interval)::date
                             AND ($3::date + ($5 || ' days')::interval)::date
         AND ABS(COALESCE(tx.net_amount,0) - $4::numeric) <= 10
       ORDER BY amount_diff ASC, t.entry_date DESC
       LIMIT 50`,
      [req.company.id, l.statement_date, l.statement_date, l.amount, String(wnd)]
    );
    return res.json({ line: l, exact_matches: exact.rows, fuzzy_matches: fuzzy.rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to load match suggestions' });
  }
});

router.post('/statements/manual-pair', async (req, res) => {
  try {
    const { line_id, transaction_id, force = false } = req.body || {};
    if (!line_id || !transaction_id) {
      return res.status(400).json({ error: 'line_id and transaction_id are required' });
    }
    const line = await query(
      `SELECT *
       FROM bank_statement_lines
       WHERE id = $1 AND company_id = $2`,
      [line_id, req.company.id]
    );
    if (!line.rows.length) return res.status(404).json({ error: 'Statement line not found' });
    const tx = await query(
      `SELECT t.id,
              t.entry_date,
              (SELECT (SUM(tl.debit) - SUM(tl.credit))::numeric(18,2)
               FROM transaction_lines tl WHERE tl.transaction_id = t.id) AS net_amount
       FROM transactions t
       WHERE t.id = $1 AND t.company_id = $2`,
      [transaction_id, req.company.id]
    );
    if (!tx.rows.length) return res.status(404).json({ error: 'Transaction not found' });
    const amountDiff = Math.abs(Number(tx.rows[0].net_amount || 0) - Number(line.rows[0].amount || 0));
    const dateDiffDays = Math.abs(
      Math.round((new Date(tx.rows[0].entry_date) - new Date(line.rows[0].statement_date)) / 86400000)
    );
    const warnings = [];
    if (amountDiff > 0.01) warnings.push(`Amount mismatch (${amountDiff.toFixed(2)})`);
    if (dateDiffDays > 3) warnings.push(`Date difference is ${dateDiffDays} day(s)`);
    if (warnings.length && !force) {
      return res.status(409).json({ error: 'Pairing has warnings. Retry with force=true.', warnings });
    }
    const upd = await query(
      `UPDATE bank_statement_lines
       SET is_reconciled = TRUE,
           reconciled_transaction_id = $1,
           reconciled_by = $2,
           reconciled_at = NOW()
       WHERE id = $3 AND company_id = $4
       RETURNING *`,
      [transaction_id, req.user.id, line_id, req.company.id]
    );
    return res.json({ line: upd.rows[0], warnings });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed manual pair operation' });
  }
});

router.post('/statements/differences/writeoff', async (req, res) => {
  try {
    const { line_id, writeoff_account_id, writeoff_date, reason } = req.body || {};
    if (!line_id || !writeoff_account_id || !writeoff_date || !reason) {
      return res.status(400).json({ error: 'line_id, writeoff_account_id, writeoff_date, reason are required' });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const line = await client.query(
        `SELECT *
         FROM bank_statement_lines
         WHERE id = $1 AND company_id = $2
         FOR UPDATE`,
        [line_id, req.company.id]
      );
      if (!line.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Statement line not found' });
      }
      const l = line.rows[0];
      const bankAcc = await client.query(
        `SELECT id, account_id FROM bank_accounts WHERE id = $1 AND company_id = $2`,
        [l.bank_account_id, req.company.id]
      );
      if (!bankAcc.rows.length || !bankAcc.rows[0].account_id) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Bank account GL account is required for write-off' });
      }
      const amt = Math.abs(Number(l.amount || 0));
      const tx = await client.query(
        `INSERT INTO transactions (company_id, entry_date, description, reference, status, posted_by, posted_at)
         VALUES ($1,$2,$3,$4,'posted',$5,NOW())
         RETURNING *`,
        [
          req.company.id,
          writeoff_date,
          `Bank reconciliation write-off: ${String(reason)}`,
          `WO-${String(l.id).slice(0, 8)}`,
          req.user.id,
        ]
      );
      if (Number(l.amount) >= 0) {
        await client.query(
          `INSERT INTO transaction_lines (transaction_id, account_id, debit, credit)
           VALUES ($1,$2,$3,0),($1,$4,0,$3)`,
          [tx.rows[0].id, writeoff_account_id, amt, bankAcc.rows[0].account_id]
        );
      } else {
        await client.query(
          `INSERT INTO transaction_lines (transaction_id, account_id, debit, credit)
           VALUES ($1,$2,0,$3),($1,$4,$3,0)`,
          [tx.rows[0].id, writeoff_account_id, amt, bankAcc.rows[0].account_id]
        );
      }
      const upd = await client.query(
        `UPDATE bank_statement_lines
         SET is_reconciled = TRUE,
             reconciled_transaction_id = $1,
             reconciled_by = $2,
             reconciled_at = NOW()
         WHERE id = $3 AND company_id = $4
         RETURNING *`,
        [tx.rows[0].id, req.user.id, line_id, req.company.id]
      );
      await client.query('COMMIT');
      return res.status(201).json({ line: upd.rows[0], writeoff_transaction: tx.rows[0] });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to write off difference' });
  }
});

router.get('/statements/fee-interest-suggestions', async (req, res) => {
  try {
    const { bank_account_id, from, to } = req.query;
    if (!bank_account_id || !from || !to) {
      return res.status(400).json({ error: 'bank_account_id, from, to are required' });
    }
    const r = await query(
      `SELECT id, statement_date, description, reference, amount
       FROM bank_statement_lines
       WHERE company_id = $1
         AND bank_account_id = $2
         AND statement_date BETWEEN $3::date AND $4::date
         AND is_reconciled = FALSE
       ORDER BY statement_date DESC`,
      [req.company.id, bank_account_id, from, to]
    );
    const suggestions = r.rows
      .filter((x) => {
        const text = `${x.description || ''} ${x.reference || ''}`.toLowerCase();
        return text.includes('fee') || text.includes('charge') || text.includes('interest') || text.includes('عمولة') || text.includes('فائدة');
      })
      .map((x) => ({
        ...x,
        suggestion_type: Number(x.amount) >= 0 ? 'interest_income' : 'bank_fee_expense',
      }));
    return res.json({ suggestions });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to load fee/interest suggestions' });
  }
});

router.get('/settlements/batches', async (req, res) => {
  try {
    if (!(await bankSettlementTablesExist())) {
      return res.status(503).json({ error: 'Settlement schema not installed.', hint: bankSettlementSchemaHint() });
    }
    const { bank_account_id } = req.query;
    const params = [req.company.id];
    let sql = `SELECT * FROM bank_settlement_batches WHERE company_id = $1`;
    if (bank_account_id) {
      sql += ` AND bank_account_id = $2`;
      params.push(String(bank_account_id));
    }
    sql += ` ORDER BY batch_date DESC, created_at DESC`;
    const r = await query(sql, params);
    return res.json({ batches: r.rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to list settlement batches' });
  }
});

router.post('/settlements/batches', async (req, res) => {
  try {
    if (!(await bankSettlementTablesExist())) {
      return res.status(503).json({ error: 'Settlement schema not installed.', hint: bankSettlementSchemaHint() });
    }
    const { bank_account_id, batch_date, reference, notes, lines = [] } = req.body || {};
    if (!bank_account_id || !batch_date) {
      return res.status(400).json({ error: 'bank_account_id and batch_date are required' });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const b = await client.query(
        `INSERT INTO bank_settlement_batches (company_id, bank_account_id, batch_date, reference, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING *`,
        [req.company.id, bank_account_id, batch_date, reference || null, notes || null, req.user.id]
      );
      for (const ln of lines) {
        if (!ln.statement_line_id) continue;
        await client.query(
          `INSERT INTO bank_settlement_batch_lines (company_id, batch_id, statement_line_id, transaction_id, settled_amount, status)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [
            req.company.id,
            b.rows[0].id,
            ln.statement_line_id,
            ln.transaction_id || null,
            Math.abs(Number(ln.settled_amount || 0)),
            ln.status || 'matched',
          ]
        );
      }
      await client.query('COMMIT');
      return res.status(201).json({ batch: b.rows[0] });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to create settlement batch' });
  }
});

router.get('/reconciliation-locks', async (req, res) => {
  try {
    if (!(await bankSettlementTablesExist())) {
      return res.status(503).json({ error: 'Settlement schema not installed.', hint: bankSettlementSchemaHint() });
    }
    const r = await query(
      `SELECT *
       FROM reconciliation_locks
       WHERE company_id = $1
       ORDER BY period_end DESC, created_at DESC`,
      [req.company.id]
    );
    return res.json({ locks: r.rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to list reconciliation locks' });
  }
});

router.post('/reconciliation-locks/submit', async (req, res) => {
  return requireRole(['owner', 'admin', 'accountant'])(req, res, async () => {
    try {
      if (!(await bankSettlementTablesExist())) {
        return res.status(503).json({ error: 'Settlement schema not installed.', hint: bankSettlementSchemaHint() });
      }
      const { bank_account_id, period_start, period_end, notes } = req.body || {};
      if (!bank_account_id || !period_start || !period_end) {
        return res.status(400).json({ error: 'bank_account_id, period_start, period_end are required' });
      }
      const up = await query(
        `INSERT INTO reconciliation_locks (
           company_id, bank_account_id, period_start, period_end, status, submitted_by, submitted_at, notes
         )
         VALUES ($1,$2,$3,$4,'submitted',$5,NOW(),$6)
         ON CONFLICT (company_id, bank_account_id, period_start, period_end)
         DO UPDATE SET
           status = 'submitted',
           submitted_by = EXCLUDED.submitted_by,
           submitted_at = NOW(),
           notes = EXCLUDED.notes,
           updated_at = NOW()
         RETURNING *`,
        [req.company.id, bank_account_id, period_start, period_end, req.user.id, notes || null]
      );
      return res.status(201).json({ lock: up.rows[0] });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Failed to submit reconciliation lock' });
    }
  });
});

router.post('/reconciliation-locks/:id/approve', async (req, res) => {
  return requireRole(['owner', 'admin'])(req, res, async () => {
    try {
      if (!(await bankSettlementTablesExist())) {
        return res.status(503).json({ error: 'Settlement schema not installed.', hint: bankSettlementSchemaHint() });
      }
      const up = await query(
        `UPDATE reconciliation_locks
         SET status = 'approved',
             approved_by = $3,
             approved_at = NOW(),
             updated_at = NOW()
         WHERE id = $1 AND company_id = $2
         RETURNING *`,
        [req.params.id, req.company.id, req.user.id]
      );
      if (!up.rows.length) return res.status(404).json({ error: 'Lock not found' });
      return res.json({ lock: up.rows[0] });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Failed to approve reconciliation lock' });
    }
  });
});

router.post('/reconciliation-locks/:id/reopen', async (req, res) => {
  return requireRole(['owner', 'admin'])(req, res, async () => {
    try {
      if (!(await bankSettlementTablesExist())) {
        return res.status(503).json({ error: 'Settlement schema not installed.', hint: bankSettlementSchemaHint() });
      }
      const up = await query(
        `UPDATE reconciliation_locks
         SET status = 'reopened',
             reopened_by = $3,
             reopened_at = NOW(),
             updated_at = NOW()
         WHERE id = $1 AND company_id = $2
         RETURNING *`,
        [req.params.id, req.company.id, req.user.id]
      );
      if (!up.rows.length) return res.status(404).json({ error: 'Lock not found' });
      return res.json({ lock: up.rows[0] });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Failed to reopen reconciliation lock' });
    }
  });
});

export default router;
