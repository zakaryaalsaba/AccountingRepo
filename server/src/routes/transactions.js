import { Router } from 'express';
import { pool } from '../db.js';
import { authRequired } from '../middleware/auth.js';
import { companyContext } from '../middleware/companyContext.js';
import { assertDateOpen } from '../utils/periodLocks.js';
import { dimensionsTablesExist } from '../utils/dimensionsSchema.js';
import { assertFiscalYearOpen, fiscalPhaseOneTablesExist } from '../utils/fiscalSchema.js';
import { writeAuditEvent } from '../utils/auditLog.js';
import { attachAuthorization, requirePermission } from '../middleware/authorization.js';
import {
  transactionBranchServiceSchemaHint,
  transactionsHaveWorkflowColumns,
  transactionsHaveBranchServiceColumns,
  transactionWorkflowSchemaHint,
} from '../utils/transactionSchema.js';

const router = Router();
router.use(authRequired, companyContext);
router.use(attachAuthorization);

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function normalizeDimensionPolicy(input) {
  const mode = String(input?.mode || 'optional');
  const allowed = ['optional', 'required_any', 'required_types'];
  if (!allowed.includes(mode)) {
    return { mode: 'optional', required_types: [] };
  }
  const requiredTypes = Array.isArray(input?.required_types)
    ? [...new Set(input.required_types.map((x) => String(x).trim()).filter(Boolean))]
    : [];
  return { mode, required_types: requiredTypes };
}

async function validateLineDimensionPolicy(client, companyId, lineId, dimensionIds, policy) {
  if (policy.mode === 'optional') return null;
  if (!Array.isArray(dimensionIds) || !dimensionIds.length) {
    return 'Dimensions are required by current policy';
  }
  if (policy.mode === 'required_any') return null;
  const dims = await client.query(
    `SELECT id, type::text AS type
     FROM dimensions
     WHERE company_id = $1
       AND is_active = TRUE
       AND id = ANY($2::uuid[])`,
    [companyId, [...new Set(dimensionIds.map((x) => String(x)))]]
  );
  const typeSet = new Set(dims.rows.map((d) => d.type));
  for (const t of policy.required_types) {
    if (!typeSet.has(t)) {
      return `Missing required dimension type on line ${lineId}: ${t}`;
    }
  }
  const accType = await client.query(
    `SELECT type::text AS type FROM accounts WHERE id = $1 AND company_id = $2`,
    [lineId, companyId]
  );
  const tableExists = await client.query(`SELECT to_regclass('public.account_class_dimension_policies') IS NOT NULL AS ok`);
  if (tableExists.rows[0]?.ok && accType.rows.length) {
    const ap = await client.query(
      `SELECT mode, required_types
       FROM account_class_dimension_policies
       WHERE company_id = $1 AND account_type::text = $2
       LIMIT 1`,
      [companyId, accType.rows[0].type]
    );
    if (ap.rows.length) {
      const pMode = String(ap.rows[0].mode || 'optional');
      const reqTypes = Array.isArray(ap.rows[0].required_types) ? ap.rows[0].required_types.map(String) : [];
      if (pMode !== 'optional' && (!Array.isArray(dimensionIds) || !dimensionIds.length)) {
        return `Dimensions are required for account class ${accType.rows[0].type}`;
      }
      if (pMode === 'required_types') {
        for (const t of reqTypes) {
          if (!typeSet.has(t)) {
            return `Missing required account-class dimension type on line ${lineId}: ${t}`;
          }
        }
      }
    }
  }
  return null;
}

router.post('/transfer', async (req, res) => {
  const { entry_date, from_account_id, to_account_id, amount, reference, description } = req.body || {};
  const amt = round2(amount);
  if (!entry_date || !from_account_id || !to_account_id || !amt || amt <= 0) {
    return res.status(400).json({
      error: 'entry_date, from_account_id, to_account_id, and positive amount are required',
    });
  }
  if (from_account_id === to_account_id) {
    return res.status(400).json({ error: 'from_account_id and to_account_id must be different' });
  }

  const client = await pool.connect();
  try {
    await assertDateOpen(req.company.id, entry_date, client);
    await assertFiscalYearOpen(req.company.id, entry_date, client);
    await client.query('BEGIN');

    const fromAcc = await client.query(
      `SELECT id, type::text
       FROM accounts
       WHERE id = $1 AND company_id = $2 AND is_active = TRUE AND level = 5`,
      [from_account_id, req.company.id]
    );
    const toAcc = await client.query(
      `SELECT id, type::text
       FROM accounts
       WHERE id = $1 AND company_id = $2 AND is_active = TRUE AND level = 5`,
      [to_account_id, req.company.id]
    );
    if (!fromAcc.rows.length || !toAcc.rows.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'Invalid account(s) for transfer (must be active posting accounts, level 5)',
      });
    }
    if (fromAcc.rows[0].type !== 'ASSET' || toAcc.rows[0].type !== 'ASSET') {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'Transfer requires ASSET accounts (typically cash/bank accounts)',
      });
    }

    const desc =
      description || `Transfer ${from_account_id.slice(0, 6)} -> ${to_account_id.slice(0, 6)}`;
    const tx = await client.query(
      `INSERT INTO transactions (company_id, entry_date, description, reference)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [req.company.id, entry_date, desc, reference || null]
    );
    const txId = tx.rows[0].id;

    // Credit source account, debit destination account.
    await client.query(
      `INSERT INTO transaction_lines (transaction_id, account_id, debit, credit)
       VALUES ($1, $2, 0, $3)`,
      [txId, from_account_id, amt]
    );
    await client.query(
      `INSERT INTO transaction_lines (transaction_id, account_id, debit, credit)
       VALUES ($1, $2, $3, 0)`,
      [txId, to_account_id, amt]
    );

    const linesOut = await client.query(
      `SELECT tl.*, a.code AS account_code, a.name AS account_name
       FROM transaction_lines tl
       JOIN accounts a ON a.id = tl.account_id
       WHERE tl.transaction_id = $1
       ORDER BY tl.id`,
      [txId]
    );
    await client.query('COMMIT');
    return res.status(201).json({ transaction: { ...tx.rows[0], lines: linesOut.rows } });
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.status === 400) return res.status(400).json({ error: e.message });
    console.error(e);
    return res.status(500).json({ error: 'Failed to create transfer' });
  } finally {
    client.release();
  }
});

router.get('/', async (req, res) => {
  const client = await pool.connect();
  try {
    const hasDims = await dimensionsTablesExist();
    const hasWorkflowCols = await transactionsHaveWorkflowColumns();
    const { from, to, limit = '50', offset = '0' } = req.query;
    const txCols = hasWorkflowCols
      ? 't.id, t.company_id, t.entry_date, t.description, t.reference, t.status, t.posted_by, t.posted_at, t.reversed_transaction_id, t.created_at'
      : 't.id, t.company_id, t.entry_date, t.description, t.reference, t.created_at';
    let sql = `
      SELECT ${txCols}
      FROM transactions t
      WHERE t.company_id = $1`;
    const params = [req.company.id];
    let i = 2;
    if (from) {
      sql += ` AND t.entry_date >= $${i++}`;
      params.push(from);
    }
    if (to) {
      sql += ` AND t.entry_date <= $${i++}`;
      params.push(to);
    }
    const lim = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
    const off = Math.max(0, parseInt(offset, 10) || 0);
    sql += ` ORDER BY t.entry_date DESC, t.created_at DESC LIMIT $${i} OFFSET $${i + 1}`;
    params.push(lim, off);
    const list = await client.query(sql, params);
    const ids = list.rows.map((r) => r.id);
    if (!ids.length) {
      return res.json({ transactions: [] });
    }
    const lines = await client.query(
      `SELECT tl.*, a.code AS account_code, a.name AS account_name
       FROM transaction_lines tl
       JOIN accounts a ON a.id = tl.account_id AND a.company_id = $2
       WHERE tl.transaction_id = ANY($1::uuid[])
       ORDER BY tl.id`,
      [ids, req.company.id]
    );
    const byTx = {};
    for (const l of lines.rows) {
      if (!byTx[l.transaction_id]) byTx[l.transaction_id] = [];
      byTx[l.transaction_id].push(l);
    }
    if (hasDims && lines.rows.length) {
      const lineIds = lines.rows.map((l) => l.id);
      const d = await client.query(
        `SELECT tld.transaction_line_id, di.id, di.type::text AS type, di.code, di.name
         FROM transaction_line_dimensions tld
         JOIN dimensions di ON di.id = tld.dimension_id
         WHERE tld.company_id = $1
           AND tld.transaction_line_id = ANY($2::uuid[])`,
        [req.company.id, lineIds]
      );
      const byLine = {};
      for (const row of d.rows) {
        if (!byLine[row.transaction_line_id]) byLine[row.transaction_line_id] = [];
        byLine[row.transaction_line_id].push({
          id: row.id,
          type: row.type,
          code: row.code,
          name: row.name,
        });
      }
      for (const txId of Object.keys(byTx)) {
        byTx[txId] = byTx[txId].map((ln) => ({ ...ln, dimensions: byLine[ln.id] || [] }));
      }
    }
    const transactions = list.rows.map((t) => ({
      ...t,
      lines: byTx[t.id] || [],
    }));
    return res.json({ transactions });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to list transactions' });
  } finally {
    client.release();
  }
});

router.get('/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    const hasDims = await dimensionsTablesExist();
    const t = await client.query(
      `SELECT * FROM transactions WHERE id = $1 AND company_id = $2`,
      [req.params.id, req.company.id]
    );
    if (!t.rows.length) return res.status(404).json({ error: 'Not found' });
    const lines = await client.query(
      `SELECT tl.*, a.code AS account_code, a.name AS account_name
       FROM transaction_lines tl
       JOIN accounts a ON a.id = tl.account_id
       WHERE tl.transaction_id = $1 AND a.company_id = $2
       ORDER BY tl.id`,
      [req.params.id, req.company.id]
    );
    let outLines = lines.rows;
    if (hasDims && outLines.length) {
      const lineIds = outLines.map((l) => l.id);
      const d = await client.query(
        `SELECT tld.transaction_line_id, di.id, di.type::text AS type, di.code, di.name
         FROM transaction_line_dimensions tld
         JOIN dimensions di ON di.id = tld.dimension_id
         WHERE tld.company_id = $1
           AND tld.transaction_line_id = ANY($2::uuid[])`,
        [req.company.id, lineIds]
      );
      const byLine = {};
      for (const row of d.rows) {
        if (!byLine[row.transaction_line_id]) byLine[row.transaction_line_id] = [];
        byLine[row.transaction_line_id].push({
          id: row.id,
          type: row.type,
          code: row.code,
          name: row.name,
        });
      }
      outLines = outLines.map((ln) => ({ ...ln, dimensions: byLine[ln.id] || [] }));
    }
    return res.json({ transaction: { ...t.rows[0], lines: outLines } });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to load transaction' });
  } finally {
    client.release();
  }
});

router.post('/', async (req, res) => {
  return requirePermission('transactions.create')(req, res, async () => {
  const {
    entry_date,
    description,
    reference,
    lines,
    status = 'posted',
    doc_type,
    fiscal_year_id,
    branch_dimension_id,
    department_dimension_id,
    dimension_policy = {},
    branch_id = null,
    service_card_id = null,
    project_id = null,
  } = req.body || {};
  if (!entry_date || !Array.isArray(lines) || lines.length < 2) {
    return res.status(400).json({
      error: 'entry_date and at least two lines (debit/credit) are required',
    });
  }
  const normalizedStatus = String(status || 'posted').toLowerCase();
  if (!['draft', 'posted'].includes(normalizedStatus)) {
    return res.status(400).json({ error: 'status must be draft or posted' });
  }
  const dimPolicy = normalizeDimensionPolicy(dimension_policy);
  let debitSum = 0;
  let creditSum = 0;
  for (const ln of lines) {
    const d = round2(ln.debit || 0);
    const c = round2(ln.credit || 0);
    if ((d > 0 && c > 0) || (d === 0 && c === 0)) {
      return res.status(400).json({ error: 'Each line must have either debit or credit' });
    }
    debitSum += d;
    creditSum += c;
  }
  if (round2(debitSum) !== round2(creditSum)) {
    return res.status(400).json({ error: 'Total debits must equal total credits' });
  }

  const client = await pool.connect();
  try {
    const hasWorkflowCols = await transactionsHaveWorkflowColumns();
    const hasBranchServiceCols = await transactionsHaveBranchServiceColumns();
    const hasFiscalPhaseOne = await fiscalPhaseOneTablesExist();
    if (normalizedStatus === 'posted') {
      await assertDateOpen(req.company.id, entry_date, client);
      await assertFiscalYearOpen(req.company.id, entry_date, client);
    }
    let finalReference = reference || null;
    if (!finalReference && hasFiscalPhaseOne) {
      try {
        const seq = await client.query(
          `SELECT next_document_number($1,$2,$3,$4,$5) AS number`,
          [
            req.company.id,
            String(doc_type || 'journal_voucher'),
            fiscal_year_id || null,
            branch_dimension_id || null,
            department_dimension_id || null,
          ]
        );
        finalReference = seq.rows[0]?.number || null;
      } catch {
        // If no sequence is configured yet, keep reference nullable.
      }
    }
    await client.query('BEGIN');
    if ((branch_id || service_card_id || project_id) && !hasBranchServiceCols) {
      await client.query('ROLLBACK');
      return res.status(503).json({ error: 'Branch/service schema not installed.', hint: transactionBranchServiceSchemaHint() });
    }
    const ins = hasWorkflowCols
      ? await client.query(
          `INSERT INTO transactions (
             company_id, entry_date, description, reference, status, posted_by, posted_at, branch_id, service_card_id, project_id
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           RETURNING *`,
          [
            req.company.id,
            entry_date,
            description || null,
            finalReference,
            normalizedStatus,
            normalizedStatus === 'posted' ? req.user.id : null,
            normalizedStatus === 'posted' ? new Date().toISOString() : null,
            branch_id,
            service_card_id,
            project_id,
          ]
        )
      : await client.query(
          `INSERT INTO transactions (company_id, entry_date, description, reference, branch_id, service_card_id, project_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
          [req.company.id, entry_date, description || null, finalReference, branch_id, service_card_id, project_id]
        );
    const tx = ins.rows[0];
    const hasDims = await dimensionsTablesExist();
    for (const ln of lines) {
      const d = round2(ln.debit || 0);
      const c = round2(ln.credit || 0);
      const acc = await client.query(
        'SELECT id FROM accounts WHERE id = $1 AND company_id = $2 AND is_active = TRUE AND level = 5',
        [ln.account_id, req.company.id]
      );
      if (!acc.rows.length) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Invalid account for posting (must be active level 5): ${ln.account_id}` });
      }
      const lineIns = await client.query(
        `INSERT INTO transaction_lines (transaction_id, account_id, debit, credit)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [tx.id, ln.account_id, d, c]
      );
      if (hasDims && Array.isArray(ln.dimension_ids) && ln.dimension_ids.length) {
        const dimIds = [...new Set(ln.dimension_ids.map((x) => String(x)))];
        const dims = await client.query(
          `SELECT id
           FROM dimensions
           WHERE company_id = $1
             AND is_active = TRUE
             AND id = ANY($2::uuid[])`,
          [req.company.id, dimIds]
        );
        if (dims.rows.length !== dimIds.length) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'One or more dimension_ids are invalid/inactive' });
        }
        for (const dim of dims.rows) {
          await client.query(
            `INSERT INTO transaction_line_dimensions (company_id, transaction_line_id, dimension_id)
             VALUES ($1,$2,$3)`,
            [req.company.id, lineIns.rows[0].id, dim.id]
          );
        }
      }
      if (hasDims) {
        const err = await validateLineDimensionPolicy(
          client,
          req.company.id,
          ln.account_id,
          Array.isArray(ln.dimension_ids) ? ln.dimension_ids : [],
          dimPolicy
        );
        if (err) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: err });
        }
      }
    }
    await client.query('COMMIT');
    const linesOut = await client.query(
      `SELECT tl.*, a.code AS account_code, a.name AS account_name
       FROM transaction_lines tl
       JOIN accounts a ON a.id = tl.account_id
       WHERE tl.transaction_id = $1`,
      [tx.id]
    );
    let outRows = linesOut.rows;
    if (hasDims && outRows.length) {
      const lineIds = outRows.map((l) => l.id);
      const d = await client.query(
        `SELECT tld.transaction_line_id, di.id, di.type::text AS type, di.code, di.name
         FROM transaction_line_dimensions tld
         JOIN dimensions di ON di.id = tld.dimension_id
         WHERE tld.company_id = $1
           AND tld.transaction_line_id = ANY($2::uuid[])`,
        [req.company.id, lineIds]
      );
      const byLine = {};
      for (const row of d.rows) {
        if (!byLine[row.transaction_line_id]) byLine[row.transaction_line_id] = [];
        byLine[row.transaction_line_id].push({
          id: row.id,
          type: row.type,
          code: row.code,
          name: row.name,
        });
      }
      outRows = outRows.map((l) => ({ ...l, dimensions: byLine[l.id] || [] }));
    }
    await writeAuditEvent({
      companyId: req.company.id,
      actorUserId: req.user.id,
      eventType: 'transaction.created',
      entityType: 'transaction',
      entityId: tx.id,
      details: { line_count: outRows.length, entry_date, status: normalizedStatus, dimension_policy: dimPolicy },
    });
    return res.status(201).json({ transaction: { ...tx, lines: outRows } });
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.status === 400) return res.status(400).json({ error: e.message });
    console.error(e);
    return res.status(500).json({ error: 'Failed to create transaction' });
  } finally {
    client.release();
  }
  });
});

router.patch('/:id', async (req, res) => {
  return requirePermission('transactions.create')(req, res, async () => {
    const { entry_date, description, reference, lines, dimension_policy = {} } = req.body || {};
    const dimPolicy = normalizeDimensionPolicy(dimension_policy);
    if (!entry_date || !Array.isArray(lines) || lines.length < 2) {
      return res.status(400).json({ error: 'entry_date and at least two lines are required' });
    }
    const client = await pool.connect();
    try {
      const hasDims = await dimensionsTablesExist();
      const hasWorkflowCols = await transactionsHaveWorkflowColumns();
      await client.query('BEGIN');
      const cur = await client.query(
        `SELECT id, status
         FROM transactions
         WHERE id = $1 AND company_id = $2
         FOR UPDATE`,
        [req.params.id, req.company.id]
      );
      if (!cur.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Not found' });
      }
      if (hasWorkflowCols && cur.rows[0].status !== 'draft') {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: 'Only draft vouchers are editable. Posted vouchers require reversal workflow.',
        });
      }
      let debitSum = 0;
      let creditSum = 0;
      for (const ln of lines) {
        const d = round2(ln.debit || 0);
        const c = round2(ln.credit || 0);
        if ((d > 0 && c > 0) || (d === 0 && c === 0)) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Each line must have either debit or credit' });
        }
        debitSum += d;
        creditSum += c;
      }
      if (round2(debitSum) !== round2(creditSum)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Total debits must equal total credits' });
      }
      await client.query(
        `UPDATE transactions
         SET entry_date = $3,
             description = $4,
             reference = $5
         WHERE id = $1 AND company_id = $2`,
        [req.params.id, req.company.id, entry_date, description || null, reference || null]
      );
      await client.query(`DELETE FROM transaction_lines WHERE transaction_id = $1`, [req.params.id]);
      for (const ln of lines) {
        const d = round2(ln.debit || 0);
        const c = round2(ln.credit || 0);
        const lineIns = await client.query(
          `INSERT INTO transaction_lines (transaction_id, account_id, debit, credit)
           VALUES ($1,$2,$3,$4)
           RETURNING id`,
          [req.params.id, ln.account_id, d, c]
        );
        if (hasDims && Array.isArray(ln.dimension_ids) && ln.dimension_ids.length) {
          for (const dimId of [...new Set(ln.dimension_ids.map((x) => String(x)))]) {
            await client.query(
              `INSERT INTO transaction_line_dimensions (company_id, transaction_line_id, dimension_id)
               VALUES ($1,$2,$3)`,
              [req.company.id, lineIns.rows[0].id, dimId]
            );
          }
        }
        if (hasDims) {
          const err = await validateLineDimensionPolicy(
            client,
            req.company.id,
            ln.account_id,
            Array.isArray(ln.dimension_ids) ? ln.dimension_ids : [],
            dimPolicy
          );
          if (err) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: err });
          }
        }
      }
      await client.query('COMMIT');
      return res.json({ ok: true });
    } catch (e) {
      await client.query('ROLLBACK');
      console.error(e);
      return res.status(500).json({ error: 'Failed to update transaction' });
    } finally {
      client.release();
    }
  });
});

router.post('/:id/post', async (req, res) => {
  return requirePermission('transactions.create')(req, res, async () => {
    const hasWorkflowCols = await transactionsHaveWorkflowColumns();
    if (!hasWorkflowCols) {
      return res.status(503).json({
        error: 'Transaction workflow schema not installed.',
        hint: transactionWorkflowSchemaHint(),
      });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const cur = await client.query(
        `SELECT id, company_id, entry_date, status
         FROM transactions
         WHERE id = $1 AND company_id = $2
         FOR UPDATE`,
        [req.params.id, req.company.id]
      );
      if (!cur.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Not found' });
      }
      const tx = cur.rows[0];
      if (tx.status === 'posted') {
        await client.query('ROLLBACK');
        return res.json({ transaction: tx, message: 'Already posted' });
      }
      if (tx.status === 'reversed') {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Reversed transaction cannot be posted again' });
      }
      await assertDateOpen(req.company.id, tx.entry_date, client);
      await assertFiscalYearOpen(req.company.id, tx.entry_date, client);
      const up = await client.query(
        `UPDATE transactions
         SET status = 'posted',
             posted_by = $3,
             posted_at = NOW()
         WHERE id = $1 AND company_id = $2
         RETURNING *`,
        [req.params.id, req.company.id, req.user.id]
      );
      await client.query('COMMIT');
      await writeAuditEvent({
        companyId: req.company.id,
        actorUserId: req.user.id,
        eventType: 'transaction.posted',
        entityType: 'transaction',
        entityId: req.params.id,
        details: {},
      });
      return res.json({ transaction: up.rows[0] });
    } catch (e) {
      await client.query('ROLLBACK');
      if (e.status === 400) return res.status(400).json({ error: e.message });
      console.error(e);
      return res.status(500).json({ error: 'Failed to post transaction' });
    } finally {
      client.release();
    }
  });
});

router.post('/:id/reverse', async (req, res) => {
  return requirePermission('transactions.create')(req, res, async () => {
    const hasWorkflowCols = await transactionsHaveWorkflowColumns();
    if (!hasWorkflowCols) {
      return res.status(503).json({
        error: 'Transaction workflow schema not installed.',
        hint: transactionWorkflowSchemaHint(),
      });
    }
    const { reverse_date, reason, reference, attachment_reference } = req.body || {};
    if (!reason || !String(reason).trim() || !attachment_reference) {
      return res.status(400).json({ error: 'reason and attachment_reference are required' });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const cur = await client.query(
        `SELECT *
         FROM transactions
         WHERE id = $1 AND company_id = $2
         FOR UPDATE`,
        [req.params.id, req.company.id]
      );
      if (!cur.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Not found' });
      }
      const tx = cur.rows[0];
      if (tx.status !== 'posted') {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Only posted transactions can be reversed' });
      }

      const revDate = reverse_date || tx.entry_date;
      await assertDateOpen(req.company.id, revDate, client);
      await assertFiscalYearOpen(req.company.id, revDate, client);
      const lines = await client.query(
        `SELECT account_id, debit, credit
         FROM transaction_lines
         WHERE transaction_id = $1
         ORDER BY id`,
        [tx.id]
      );
      if (!lines.rows.length) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Cannot reverse transaction without lines' });
      }

      const revTx = await client.query(
        `INSERT INTO transactions (
           company_id, entry_date, description, reference, status, posted_by, posted_at, reversed_transaction_id
         )
         VALUES ($1,$2,$3,$4,'posted',$5,NOW(),$6)
         RETURNING *`,
        [
          req.company.id,
          revDate,
          `Reversal of ${tx.reference || tx.id.slice(0, 8)}: ${String(reason).trim()}`,
          reference || `REV-${tx.reference || tx.id.slice(0, 8)}`,
          req.user.id,
          tx.id,
        ]
      );
      for (const ln of lines.rows) {
        await client.query(
          `INSERT INTO transaction_lines (transaction_id, account_id, debit, credit)
           VALUES ($1,$2,$3,$4)`,
          [revTx.rows[0].id, ln.account_id, ln.credit, ln.debit]
        );
      }
      await client.query(
        `UPDATE transactions
         SET status = 'reversed',
             reversed_transaction_id = $3
         WHERE id = $1 AND company_id = $2`,
        [tx.id, req.company.id, revTx.rows[0].id]
      );
      await client.query('COMMIT');
      await writeAuditEvent({
        companyId: req.company.id,
        actorUserId: req.user.id,
        eventType: 'transaction.reversed',
        entityType: 'transaction',
        entityId: tx.id,
        details: { reversal_transaction_id: revTx.rows[0].id, reason: String(reason).trim(), attachment_reference: String(attachment_reference) },
      });
      return res.status(201).json({ transaction: revTx.rows[0] });
    } catch (e) {
      await client.query('ROLLBACK');
      if (e.status === 400) return res.status(400).json({ error: e.message });
      console.error(e);
      return res.status(500).json({ error: 'Failed to reverse transaction' });
    } finally {
      client.release();
    }
  });
});

router.delete('/:id', async (req, res) => {
  return requirePermission('transactions.delete')(req, res, async () => {
  try {
    const { reason } = req.body || {};
    if (!reason || !String(reason).trim()) {
      return res.status(400).json({ error: 'reason is required for delete' });
    }
    const approved = await pool.query(
      `SELECT status
       FROM journal_approvals
       WHERE company_id = $1 AND transaction_id = $2
       LIMIT 1`,
      [req.company.id, req.params.id]
    );
    if (approved.rows[0]?.status === 'approved') {
      return res.status(400).json({ error: 'Posted/approved journal cannot be deleted' });
    }
    const cur = await pool.query(
      'SELECT entry_date, status FROM transactions WHERE id = $1 AND company_id = $2',
      [req.params.id, req.company.id]
    );
    if (!cur.rows.length) return res.status(404).json({ error: 'Not found' });
    if (await transactionsHaveWorkflowColumns()) {
      const st = cur.rows[0].status;
      if (st !== 'draft') {
        return res.status(400).json({
          error: 'Only draft vouchers can be deleted. Posted vouchers require reversal workflow.',
        });
      }
    }
    await assertDateOpen(req.company.id, cur.rows[0].entry_date);
    await assertFiscalYearOpen(req.company.id, cur.rows[0].entry_date);

    const r = await pool.query(
      'DELETE FROM transactions WHERE id = $1 AND company_id = $2 RETURNING id',
      [req.params.id, req.company.id]
    );
    if (r.rows.length) {
      await writeAuditEvent({
        companyId: req.company.id,
        actorUserId: req.user.id,
        eventType: 'transaction.deleted',
        entityType: 'transaction',
        entityId: req.params.id,
        details: {},
      });
    }
    return res.json({ ok: true });
  } catch (e) {
    if (e.status === 400) return res.status(400).json({ error: e.message });
    console.error(e);
    return res.status(500).json({ error: 'Failed to delete transaction' });
  }
  });
});

router.post('/import-csv-dry-run', async (req, res) => {
  return requirePermission('transactions.create')(req, res, async () => {
    const { csv_text, delimiter = ',' } = req.body || {};
    if (!csv_text || !String(csv_text).trim()) {
      return res.status(400).json({ error: 'csv_text is required' });
    }
    const lines = String(csv_text).split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 2) {
      return res.status(400).json({ error: 'CSV needs header + at least one row' });
    }
    const header = lines[0].split(delimiter).map((s) => s.trim().toLowerCase());
    const idx = {
      account_code: header.indexOf('account_code'),
      debit: header.indexOf('debit'),
      credit: header.indexOf('credit'),
      note: header.indexOf('note'),
    };
    if (idx.account_code < 0 || idx.debit < 0 || idx.credit < 0) {
      return res.status(400).json({
        error: 'CSV header must include: account_code,debit,credit (note optional)',
      });
    }
    const acc = await pool.query(
      `SELECT id, account_code, code
       FROM accounts
       WHERE company_id = $1`,
      [req.company.id]
    );
    const accByCode = new Map();
    for (const a of acc.rows) {
      accByCode.set(String(a.account_code), a.id);
      accByCode.set(String(a.code), a.id);
    }
    const parsed = [];
    const errors = [];
    let debitTotal = 0;
    let creditTotal = 0;
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(delimiter);
      const accountCode = String(cols[idx.account_code] || '').trim();
      const debit = round2(cols[idx.debit] || 0);
      const credit = round2(cols[idx.credit] || 0);
      const note = idx.note >= 0 ? String(cols[idx.note] || '').trim() : '';
      const accountId = accByCode.get(accountCode);
      if (!accountId) {
        errors.push({ row: i + 1, error: `Unknown account_code: ${accountCode}` });
        continue;
      }
      if ((debit > 0 && credit > 0) || (debit === 0 && credit === 0)) {
        errors.push({ row: i + 1, error: 'Each row needs either debit or credit' });
        continue;
      }
      parsed.push({ account_id: accountId, account_code: accountCode, debit, credit, note: note || null });
      debitTotal += debit;
      creditTotal += credit;
    }
    return res.json({
      ok: errors.length === 0 && round2(debitTotal) === round2(creditTotal),
      parsed_lines: parsed,
      errors,
      totals: {
        debit: round2(debitTotal),
        credit: round2(creditTotal),
        balanced: round2(debitTotal) === round2(creditTotal),
      },
      dry_run: true,
    });
  });
});

export default router;
