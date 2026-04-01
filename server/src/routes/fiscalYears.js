import { Router } from 'express';
import { pool, query } from '../db.js';
import { authRequired } from '../middleware/auth.js';
import { companyContext } from '../middleware/companyContext.js';
import { attachAuthorization, requirePermission, requireRole } from '../middleware/authorization.js';
import {
  fiscalPhaseOneTablesExist,
  fiscalPhaseOneSchemaHint,
  sequenceDimensionColumnsExist,
  sequenceDimensionsSchemaHint,
} from '../utils/fiscalSchema.js';
import { transactionsHaveWorkflowColumns } from '../utils/transactionSchema.js';
import { writeAuditEvent } from '../utils/auditLog.js';

const router = Router();
router.use(authRequired, companyContext);
router.use(attachAuthorization);

async function guardSchema(res) {
  if (await fiscalPhaseOneTablesExist()) return true;
  res.status(503).json({
    error: 'Fiscal year/sequence schema not installed.',
    hint: fiscalPhaseOneSchemaHint(),
  });
  return false;
}

router.get('/', async (req, res) => {
  try {
    if (!(await guardSchema(res))) return;
    const r = await query(
      `SELECT *
       FROM fiscal_years
       WHERE company_id = $1
       ORDER BY year_code DESC, start_date DESC`,
      [req.company.id]
    );
    return res.json({ fiscal_years: r.rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to list fiscal years' });
  }
});

router.post('/', async (req, res) => {
  return requirePermission('periods.close')(req, res, async () => {
    try {
      if (!(await guardSchema(res))) return;
      const { year_code, name_ar, name_en, start_date, end_date, is_active = false } = req.body || {};
      const y = Number(year_code);
      if (!Number.isInteger(y) || y < 2000 || y > 3000) {
        return res.status(400).json({ error: 'year_code must be a valid integer (e.g. 2026)' });
      }
      if (!start_date || !end_date) {
        return res.status(400).json({ error: 'start_date and end_date are required' });
      }
      if (String(start_date) > String(end_date)) {
        return res.status(400).json({ error: 'start_date must be before or equal to end_date' });
      }
      if (is_active) {
        await query(`UPDATE fiscal_years SET is_active = FALSE WHERE company_id = $1`, [req.company.id]);
      }
      const ins = await query(
        `INSERT INTO fiscal_years (
          company_id, year_code, name_ar, name_en, start_date, end_date, is_active, created_by
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        RETURNING *`,
        [
          req.company.id,
          y,
          name_ar ? String(name_ar).trim() : null,
          name_en ? String(name_en).trim() : null,
          start_date,
          end_date,
          Boolean(is_active),
          req.user.id,
        ]
      );
      return res.status(201).json({ fiscal_year: ins.rows[0] });
    } catch (e) {
      if (e.code === '23505') {
        return res.status(409).json({ error: 'Fiscal year already exists for this company/year_code' });
      }
      if (String(e.message || '').includes('overlaps existing fiscal year')) {
        return res.status(409).json({ error: 'Fiscal year date range overlaps an existing fiscal year' });
      }
      console.error(e);
      return res.status(500).json({ error: 'Failed to create fiscal year' });
    }
  });
});

router.post('/:id/activate', async (req, res) => {
  return requireRole(['owner', 'admin'])(req, res, async () => {
    try {
      if (!(await guardSchema(res))) return;
      const cur = await query(`SELECT * FROM fiscal_years WHERE id = $1 AND company_id = $2`, [
        req.params.id,
        req.company.id,
      ]);
      if (!cur.rows.length) return res.status(404).json({ error: 'Fiscal year not found' });
      await query(`UPDATE fiscal_years SET is_active = FALSE WHERE company_id = $1`, [req.company.id]);
      const up = await query(
        `UPDATE fiscal_years
         SET is_active = TRUE, updated_at = NOW()
         WHERE id = $1 AND company_id = $2
         RETURNING *`,
        [req.params.id, req.company.id]
      );
      await writeAuditEvent({
        companyId: req.company.id,
        actorUserId: req.user.id,
        eventType: 'fiscal_year.activated',
        entityType: 'fiscal_year',
        entityId: req.params.id,
        details: {},
      });
      return res.json({ fiscal_year: up.rows[0] });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Failed to activate fiscal year' });
    }
  });
});

router.post('/:id/set-closing', async (req, res) => {
  return requireRole(['owner', 'admin'])(req, res, async () => {
    try {
      if (!(await guardSchema(res))) return;
      const up = await query(
        `UPDATE fiscal_years
         SET is_active = FALSE, updated_at = NOW()
         WHERE id = $1 AND company_id = $2 AND is_closed = FALSE
         RETURNING *`,
        [req.params.id, req.company.id]
      );
      if (!up.rows.length) return res.status(404).json({ error: 'Open fiscal year not found' });
      await writeAuditEvent({
        companyId: req.company.id,
        actorUserId: req.user.id,
        eventType: 'fiscal_year.closing',
        entityType: 'fiscal_year',
        entityId: req.params.id,
        details: {},
      });
      return res.json({ fiscal_year: up.rows[0], status: 'closing' });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Failed to set fiscal year to closing' });
    }
  });
});

router.post('/:id/close', async (req, res) => {
  return requireRole(['owner', 'admin'])(req, res, async () => {
    try {
      if (!(await guardSchema(res))) return;
      const up = await query(
        `UPDATE fiscal_years
         SET is_closed = TRUE,
             is_active = FALSE,
             closed_at = NOW(),
             closed_by = $3,
             updated_at = NOW()
         WHERE id = $1 AND company_id = $2
         RETURNING *`,
        [req.params.id, req.company.id, req.user.id]
      );
      if (!up.rows.length) return res.status(404).json({ error: 'Fiscal year not found' });
      await writeAuditEvent({
        companyId: req.company.id,
        actorUserId: req.user.id,
        eventType: 'fiscal_year.closed',
        entityType: 'fiscal_year',
        entityId: req.params.id,
        details: {},
      });
      return res.json({ fiscal_year: up.rows[0] });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Failed to close fiscal year' });
    }
  });
});

router.post('/:id/reopen', async (req, res) => {
  return requireRole(['owner', 'admin'])(req, res, async () => {
    try {
      if (!(await guardSchema(res))) return;
      const up = await query(
        `UPDATE fiscal_years
         SET is_closed = FALSE, closed_at = NULL, closed_by = NULL, updated_at = NOW()
         WHERE id = $1 AND company_id = $2
         RETURNING *`,
        [req.params.id, req.company.id]
      );
      if (!up.rows.length) return res.status(404).json({ error: 'Fiscal year not found' });
      await writeAuditEvent({
        companyId: req.company.id,
        actorUserId: req.user.id,
        eventType: 'fiscal_year.reopened',
        entityType: 'fiscal_year',
        entityId: req.params.id,
        details: {},
      });
      return res.json({ fiscal_year: up.rows[0] });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Failed to reopen fiscal year' });
    }
  });
});

router.get('/:id/wizard-checks', async (req, res) => {
  return requireRole(['owner', 'admin'])(req, res, async () => {
    try {
      if (!(await guardSchema(res))) return;
      const hasWorkflow = await transactionsHaveWorkflowColumns();
      const fy = await query(
        `SELECT id, year_code, start_date, end_date
         FROM fiscal_years
         WHERE id = $1 AND company_id = $2`,
        [req.params.id, req.company.id]
      );
      if (!fy.rows.length) return res.status(404).json({ error: 'Fiscal year not found' });
      const { start_date, end_date } = fy.rows[0];
      const drafts = hasWorkflow
        ? await query(
            `SELECT COUNT(*)::int AS c
             FROM transactions
             WHERE company_id = $1
               AND entry_date BETWEEN $2::date AND $3::date
               AND status = 'draft'`,
            [req.company.id, start_date, end_date]
          )
        : { rows: [{ c: 0 }] };
      const unbalanced = await query(
        `SELECT COUNT(*)::int AS c
         FROM (
           SELECT t.id
           FROM transactions t
           JOIN transaction_lines tl ON tl.transaction_id = t.id
           WHERE t.company_id = $1
             AND t.entry_date BETWEEN $2::date AND $3::date
           GROUP BY t.id
           HAVING ROUND(COALESCE(SUM(tl.debit),0)::numeric,2) <> ROUND(COALESCE(SUM(tl.credit),0)::numeric,2)
         ) x`,
        [req.company.id, start_date, end_date]
      );
      const openRec = await query(
        `SELECT COUNT(*)::int AS c
         FROM bank_statement_imports
         WHERE company_id = $1
           AND imported_at::date BETWEEN $2::date AND $3::date
           AND is_reconciled = FALSE`,
        [req.company.id, start_date, end_date]
      );
      return res.json({
        fiscal_year: fy.rows[0],
        checks: {
          unposted_draft_transactions: drafts.rows[0].c,
          unbalanced_transactions: unbalanced.rows[0].c,
          open_bank_reconciliation_imports: openRec.rows[0].c,
        },
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Failed to run fiscal year wizard checks' });
    }
  });
});

router.post('/:id/clone-settings', async (req, res) => {
  return requireRole(['owner', 'admin'])(req, res, async () => {
    try {
      if (!(await guardSchema(res))) return;
      const { from_fiscal_year_id = null } = req.body || {};
      const target = await query(`SELECT * FROM fiscal_years WHERE id = $1 AND company_id = $2`, [
        req.params.id,
        req.company.id,
      ]);
      if (!target.rows.length) return res.status(404).json({ error: 'Target fiscal year not found' });
      let sourceId = from_fiscal_year_id;
      if (!sourceId) {
        const prev = await query(
          `SELECT id
           FROM fiscal_years
           WHERE company_id = $1
             AND end_date < $2::date
           ORDER BY end_date DESC
           LIMIT 1`,
          [req.company.id, target.rows[0].start_date]
        );
        sourceId = prev.rows[0]?.id || null;
      }
      if (!sourceId) return res.status(400).json({ error: 'No source fiscal year found to clone from' });
      const cloned = await query(
        `INSERT INTO document_sequences (
           company_id, doc_type, fiscal_year_id, prefix, suffix, padding, last_number, is_active
         )
         SELECT company_id, doc_type, $3, prefix, suffix, padding, 0, is_active
         FROM document_sequences
         WHERE company_id = $1
           AND fiscal_year_id = $2
         ON CONFLICT (company_id, doc_type, fiscal_year_id)
         DO UPDATE SET
           prefix = EXCLUDED.prefix,
           suffix = EXCLUDED.suffix,
           padding = EXCLUDED.padding,
           is_active = EXCLUDED.is_active,
           updated_at = NOW()
         RETURNING id`,
        [req.company.id, sourceId, req.params.id]
      );
      await writeAuditEvent({
        companyId: req.company.id,
        actorUserId: req.user.id,
        eventType: 'fiscal_year.settings_cloned',
        entityType: 'fiscal_year',
        entityId: req.params.id,
        details: { source_fiscal_year_id: sourceId, cloned_sequences: cloned.rowCount },
      });
      return res.json({ ok: true, source_fiscal_year_id: sourceId, cloned_sequences: cloned.rowCount });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Failed to clone fiscal year settings' });
    }
  });
});

router.post('/:id/opening-balance', async (req, res) => {
  return requireRole(['owner', 'admin'])(req, res, async () => {
    const { entry_date, description, reference, lines } = req.body || {};
    if (!entry_date || !Array.isArray(lines) || lines.length < 2) {
      return res.status(400).json({ error: 'entry_date and at least two lines are required' });
    }
    const fy = await query(
      `SELECT id, start_date, end_date
       FROM fiscal_years
       WHERE id = $1 AND company_id = $2`,
      [req.params.id, req.company.id]
    );
    if (!fy.rows.length) return res.status(404).json({ error: 'Fiscal year not found' });
    if (String(entry_date) < String(fy.rows[0].start_date) || String(entry_date) > String(fy.rows[0].end_date)) {
      return res.status(400).json({ error: 'entry_date must be inside target fiscal year range' });
    }
    const hasWorkflow = await transactionsHaveWorkflowColumns();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const debitSum = lines.reduce((s, ln) => s + Number(ln.debit || 0), 0);
      const creditSum = lines.reduce((s, ln) => s + Number(ln.credit || 0), 0);
      if (Math.round(debitSum * 100) !== Math.round(creditSum * 100)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Total debits must equal total credits' });
      }
      const tx = hasWorkflow
        ? await client.query(
            `INSERT INTO transactions (company_id, entry_date, description, reference, status, posted_by, posted_at)
             VALUES ($1,$2,$3,$4,'posted',$5,NOW())
             RETURNING *`,
            [
              req.company.id,
              entry_date,
              description || `Opening balances for fiscal year ${fy.rows[0].id}`,
              reference || `OB-${fy.rows[0].start_date}`,
              req.user.id,
            ]
          )
        : await client.query(
            `INSERT INTO transactions (company_id, entry_date, description, reference)
             VALUES ($1,$2,$3,$4)
             RETURNING *`,
            [
              req.company.id,
              entry_date,
              description || `Opening balances for fiscal year ${fy.rows[0].id}`,
              reference || `OB-${fy.rows[0].start_date}`,
            ]
          );
      for (const ln of lines) {
        await client.query(
          `INSERT INTO transaction_lines (transaction_id, account_id, debit, credit)
           VALUES ($1,$2,$3,$4)`,
          [tx.rows[0].id, ln.account_id, Number(ln.debit || 0), Number(ln.credit || 0)]
        );
      }
      await client.query('COMMIT');
      await writeAuditEvent({
        companyId: req.company.id,
        actorUserId: req.user.id,
        eventType: 'fiscal_year.opening_balance_posted',
        entityType: 'fiscal_year',
        entityId: req.params.id,
        details: { transaction_id: tx.rows[0].id, line_count: lines.length },
      });
      return res.status(201).json({ transaction: tx.rows[0] });
    } catch (e) {
      await client.query('ROLLBACK');
      console.error(e);
      return res.status(500).json({ error: 'Failed to post opening balances' });
    } finally {
      client.release();
    }
  });
});

router.get('/sequences/list', async (req, res) => {
  try {
    if (!(await guardSchema(res))) return;
    const r = await query(
      `SELECT ds.*,
              fy.year_code,
              fy.name_ar AS fiscal_year_name_ar,
              fy.name_en AS fiscal_year_name_en
       FROM document_sequences ds
       LEFT JOIN fiscal_years fy ON fy.id = ds.fiscal_year_id
       WHERE ds.company_id = $1
       ORDER BY ds.doc_type ASC, fy.year_code DESC NULLS LAST, ds.created_at DESC`,
      [req.company.id]
    );
    return res.json({ sequences: r.rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to list document sequences' });
  }
});

router.post('/sequences/upsert', async (req, res) => {
  return requireRole(['owner', 'admin'])(req, res, async () => {
    try {
      if (!(await guardSchema(res))) return;
      const {
        doc_type,
        fiscal_year_id = null,
        branch_dimension_id = null,
        department_dimension_id = null,
        prefix = null,
        suffix = null,
        padding = 6,
        is_active = true,
      } = req.body || {};
      if (!doc_type || !String(doc_type).trim()) return res.status(400).json({ error: 'doc_type is required' });
      const hasSeqDims = await sequenceDimensionColumnsExist();
      const wantsScopedDims = Boolean(branch_dimension_id || department_dimension_id);
      if (wantsScopedDims && !hasSeqDims) {
        return res.status(503).json({
          error: 'Sequence dimension scope schema not installed.',
          hint: sequenceDimensionsSchemaHint(),
        });
      }
      const pad = Number(padding);
      if (!Number.isInteger(pad) || pad < 1 || pad > 12) {
        return res.status(400).json({ error: 'padding must be an integer between 1 and 12' });
      }
      if (fiscal_year_id) {
        const fy = await query(`SELECT id FROM fiscal_years WHERE id = $1 AND company_id = $2`, [
          fiscal_year_id,
          req.company.id,
        ]);
        if (!fy.rows.length) return res.status(400).json({ error: 'fiscal_year_id is invalid for this company' });
      }
      for (const [label, id] of [
        ['branch_dimension_id', branch_dimension_id],
        ['department_dimension_id', department_dimension_id],
      ]) {
        if (!id) continue;
        const d = await query(
          `SELECT id
           FROM dimensions
           WHERE id = $1 AND company_id = $2 AND is_active = TRUE`,
          [id, req.company.id]
        );
        if (!d.rows.length) {
          return res.status(400).json({ error: `${label} is invalid for this company` });
        }
      }
      const up = hasSeqDims
        ? await query(
            `INSERT INTO document_sequences (
              company_id, doc_type, fiscal_year_id, branch_dimension_id, department_dimension_id, prefix, suffix, padding, is_active
            )
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
            ON CONFLICT (company_id, doc_type, fiscal_year_id, branch_dimension_id, department_dimension_id)
            DO UPDATE SET
              branch_dimension_id = EXCLUDED.branch_dimension_id,
              department_dimension_id = EXCLUDED.department_dimension_id,
              prefix = EXCLUDED.prefix,
              suffix = EXCLUDED.suffix,
              padding = EXCLUDED.padding,
              is_active = EXCLUDED.is_active,
              updated_at = NOW()
            RETURNING *`,
            [
              req.company.id,
              String(doc_type).trim(),
              fiscal_year_id || null,
              branch_dimension_id || null,
              department_dimension_id || null,
              prefix ? String(prefix) : null,
              suffix ? String(suffix) : null,
              pad,
              Boolean(is_active),
            ]
          )
        : await query(
            `INSERT INTO document_sequences (
              company_id, doc_type, fiscal_year_id, prefix, suffix, padding, is_active
            )
            VALUES ($1,$2,$3,$4,$5,$6,$7)
            ON CONFLICT (company_id, doc_type, fiscal_year_id)
            DO UPDATE SET
              prefix = EXCLUDED.prefix,
              suffix = EXCLUDED.suffix,
              padding = EXCLUDED.padding,
              is_active = EXCLUDED.is_active,
              updated_at = NOW()
            RETURNING *`,
            [
              req.company.id,
              String(doc_type).trim(),
              fiscal_year_id || null,
              prefix ? String(prefix) : null,
              suffix ? String(suffix) : null,
              pad,
              Boolean(is_active),
            ]
          );
      return res.status(201).json({ sequence: up.rows[0] });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Failed to upsert document sequence' });
    }
  });
});

router.post('/sequences/next', async (req, res) => {
  return requirePermission('transactions.create')(req, res, async () => {
    try {
      if (!(await guardSchema(res))) return;
      const { doc_type, fiscal_year_id = null, branch_dimension_id = null, department_dimension_id = null } = req.body || {};
      if (!doc_type || !String(doc_type).trim()) return res.status(400).json({ error: 'doc_type is required' });
      const hasSeqDims = await sequenceDimensionColumnsExist();
      const wantsScopedDims = Boolean(branch_dimension_id || department_dimension_id);
      if (wantsScopedDims && !hasSeqDims) {
        return res.status(503).json({
          error: 'Sequence dimension scope schema not installed.',
          hint: sequenceDimensionsSchemaHint(),
        });
      }
      const r = await query(`SELECT next_document_number($1,$2,$3,$4,$5) AS number`, [
        req.company.id,
        String(doc_type).trim(),
        fiscal_year_id || null,
        hasSeqDims ? branch_dimension_id || null : null,
        hasSeqDims ? department_dimension_id || null : null,
      ]);
      return res.json({ number: r.rows[0].number });
    } catch (e) {
      if (String(e.message || '').includes('No active sequence configured')) {
        return res.status(404).json({ error: 'No active sequence configured for this document type' });
      }
      console.error(e);
      return res.status(500).json({ error: 'Failed to generate next document number' });
    }
  });
});

router.post('/sequences/manual-override', async (req, res) => {
  return requireRole(['owner', 'admin'])(req, res, async () => {
    try {
      if (!(await guardSchema(res))) return;
      const { sequence_id, new_last_number, reason } = req.body || {};
      const n = Number(new_last_number);
      if (!sequence_id) return res.status(400).json({ error: 'sequence_id is required' });
      if (!Number.isInteger(n) || n < 0) return res.status(400).json({ error: 'new_last_number must be a non-negative integer' });
      if (!reason || !String(reason).trim()) return res.status(400).json({ error: 'reason is required' });
      const cur = await query(`SELECT * FROM document_sequences WHERE id = $1 AND company_id = $2`, [
        sequence_id,
        req.company.id,
      ]);
      if (!cur.rows.length) return res.status(404).json({ error: 'Sequence not found' });
      const up = await query(
        `UPDATE document_sequences
         SET last_number = $3, updated_at = NOW()
         WHERE id = $1 AND company_id = $2
         RETURNING *`,
        [sequence_id, req.company.id, n]
      );
      await writeAuditEvent({
        companyId: req.company.id,
        actorUserId: req.user.id,
        eventType: 'sequence.manual_override',
        entityType: 'document_sequence',
        entityId: sequence_id,
        details: { old_last_number: cur.rows[0].last_number, new_last_number: n, reason: String(reason).trim() },
      });
      return res.json({ sequence: up.rows[0] });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Failed to override sequence number' });
    }
  });
});

router.get('/sequences/integrity', async (req, res) => {
  try {
    if (!(await guardSchema(res))) return;
    const { doc_type = 'journal_voucher', fiscal_year_id = null, branch_dimension_id = null, department_dimension_id = null } = req.query;
    const hasSeqDims = await sequenceDimensionColumnsExist();
    const wantsScopedDims = Boolean(branch_dimension_id || department_dimension_id);
    if (wantsScopedDims && !hasSeqDims) {
      return res.status(503).json({
        error: 'Sequence dimension scope schema not installed.',
        hint: sequenceDimensionsSchemaHint(),
      });
    }
    const prefixFilter = String(doc_type || '').trim() || null;
    const dup = await query(
      `SELECT reference, COUNT(*)::int AS duplicate_count
       FROM transactions
       WHERE company_id = $1
         AND reference IS NOT NULL
         AND ($2::text IS NULL OR reference LIKE ($2 || '%'))
       GROUP BY reference
       HAVING COUNT(*) > 1
       ORDER BY duplicate_count DESC, reference ASC`,
      [req.company.id, prefixFilter]
    );
    const seq = await query(
      `SELECT prefix, suffix, padding
       FROM document_sequences
       WHERE company_id = $1
         AND doc_type = $2
         AND (($3::uuid IS NULL AND fiscal_year_id IS NULL) OR fiscal_year_id = $3::uuid)
         AND (($4::uuid IS NULL AND branch_dimension_id IS NULL) OR branch_dimension_id = $4::uuid)
         AND (($5::uuid IS NULL AND department_dimension_id IS NULL) OR department_dimension_id = $5::uuid)
       LIMIT 1`,
      [
        req.company.id,
        String(doc_type).trim(),
        fiscal_year_id || null,
        hasSeqDims ? branch_dimension_id || null : null,
        hasSeqDims ? department_dimension_id || null : null,
      ]
    );
    const missing_numbers = [];
    if (seq.rows.length) {
      const s = seq.rows[0];
      const pref = s.prefix || '';
      const suff = s.suffix || '';
      const refs = await query(
        `SELECT reference
         FROM transactions
         WHERE company_id = $1
           AND reference IS NOT NULL
           AND reference LIKE $2`,
        [req.company.id, `${pref}%${suff}`]
      );
      const nums = refs.rows
        .map((r) => {
          const ref = String(r.reference || '');
          if (!ref.startsWith(pref) || !ref.endsWith(suff)) return null;
          const mid = ref.slice(pref.length, ref.length - suff.length);
          return /^\d+$/.test(mid) ? Number(mid) : null;
        })
        .filter((x) => Number.isInteger(x))
        .sort((a, b) => a - b);
      if (nums.length) {
        const seen = new Set(nums);
        for (let n = nums[0]; n <= nums[nums.length - 1]; n++) {
          if (!seen.has(n)) missing_numbers.push(n);
        }
      }
    }
    return res.json({
      doc_type: String(doc_type).trim(),
      fiscal_year_id: fiscal_year_id || null,
      duplicates: dup.rows,
      missing_numbers,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to run sequence integrity checks' });
  }
});

router.post('/sequences/renumber-drafts', async (req, res) => {
  return requireRole(['owner', 'admin'])(req, res, async () => {
    try {
      if (!(await guardSchema(res))) return;
      if (!(await transactionsHaveWorkflowColumns())) {
        return res.status(503).json({
          error: 'Transaction workflow schema not installed.',
          hint: 'Run: psql $DATABASE_URL -f database/migrations/023_fiscal_years_sequences_and_voucher_status.sql',
        });
      }
      const {
        doc_type = 'journal_voucher',
        fiscal_year_id = null,
        branch_dimension_id = null,
        department_dimension_id = null,
      } = req.body || {};
      const hasSeqDims = await sequenceDimensionColumnsExist();
      const wantsScopedDims = Boolean(branch_dimension_id || department_dimension_id);
      if (wantsScopedDims && !hasSeqDims) {
        return res.status(503).json({
          error: 'Sequence dimension scope schema not installed.',
          hint: sequenceDimensionsSchemaHint(),
        });
      }
      const txs = await query(
        `SELECT id
         FROM transactions
         WHERE company_id = $1
           AND status = 'draft'
         ORDER BY entry_date ASC, created_at ASC`,
        [req.company.id]
      );
      const updated = [];
      for (const row of txs.rows) {
        const next = await query(`SELECT next_document_number($1,$2,$3,$4,$5) AS number`, [
          req.company.id,
          String(doc_type).trim(),
          fiscal_year_id || null,
          hasSeqDims ? branch_dimension_id || null : null,
          hasSeqDims ? department_dimension_id || null : null,
        ]);
        await query(`UPDATE transactions SET reference = $3 WHERE id = $1 AND company_id = $2`, [
          row.id,
          req.company.id,
          next.rows[0].number,
        ]);
        updated.push({ id: row.id, reference: next.rows[0].number });
      }
      await writeAuditEvent({
        companyId: req.company.id,
        actorUserId: req.user.id,
        eventType: 'sequence.renumber_drafts',
        entityType: 'transaction',
        entityId: null,
        details: { count: updated.length, doc_type: String(doc_type).trim(), fiscal_year_id: fiscal_year_id || null },
      });
      return res.json({ ok: true, updated });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Failed to renumber draft vouchers' });
    }
  });
});

export default router;
