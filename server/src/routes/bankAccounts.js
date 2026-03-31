import { Router } from 'express';
import { pool, query } from '../db.js';
import { authRequired } from '../middleware/auth.js';
import { companyContext } from '../middleware/companyContext.js';

const router = Router();
router.use(authRequired, companyContext);

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

export default router;
