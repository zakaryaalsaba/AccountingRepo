import { Router } from 'express';
import { query } from '../db.js';
import { authRequired } from '../middleware/auth.js';
import { companyContext } from '../middleware/companyContext.js';
import { apSchemaHint, apTablesExist } from '../utils/apSchema.js';
import { statementConfirmationsTableExists, statementSchemaHint } from '../utils/statementSchema.js';

const router = Router();
router.use(authRequired, companyContext);

router.use(async (_req, res, next) => {
  if (!(await apTablesExist())) {
    return res.status(503).json({ error: 'AP schema not installed.', hint: apSchemaHint() });
  }
  return next();
});

router.get('/', async (req, res) => {
  try {
    const r = await query(
      `SELECT *
       FROM vendors
       WHERE company_id = $1
       ORDER BY name ASC`,
      [req.company.id]
    );
    return res.json({ vendors: r.rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to list vendors' });
  }
});

router.post('/', async (req, res) => {
  try {
    const { name, email, phone, tax_id, payment_terms_days, notes } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' });
    const ins = await query(
      `INSERT INTO vendors (company_id, name, email, phone, tax_id, payment_terms_days, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        req.company.id,
        String(name).trim(),
        email ? String(email).trim() : null,
        phone ? String(phone).trim() : null,
        tax_id ? String(tax_id).trim() : null,
        Number(payment_terms_days || 0),
        notes ? String(notes) : null,
      ]
    );
    return res.status(201).json({ vendor: ins.rows[0] });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to create vendor' });
  }
});

router.patch('/:id', async (req, res) => {
  try {
    const cur = await query(`SELECT * FROM vendors WHERE id = $1 AND company_id = $2`, [
      req.params.id,
      req.company.id,
    ]);
    if (!cur.rows.length) return res.status(404).json({ error: 'Not found' });
    const row = cur.rows[0];
    const b = req.body || {};
    const upd = await query(
      `UPDATE vendors
       SET name = $1,
           email = $2,
           phone = $3,
           tax_id = $4,
           payment_terms_days = $5,
           notes = $6,
           is_active = $7,
           updated_at = NOW()
       WHERE id = $8 AND company_id = $9
       RETURNING *`,
      [
        b.name !== undefined ? String(b.name).trim() : row.name,
        b.email !== undefined ? (b.email ? String(b.email).trim() : null) : row.email,
        b.phone !== undefined ? (b.phone ? String(b.phone).trim() : null) : row.phone,
        b.tax_id !== undefined ? (b.tax_id ? String(b.tax_id).trim() : null) : row.tax_id,
        b.payment_terms_days !== undefined ? Number(b.payment_terms_days) : row.payment_terms_days,
        b.notes !== undefined ? (b.notes ? String(b.notes) : null) : row.notes,
        b.is_active !== undefined ? Boolean(b.is_active) : row.is_active,
        req.params.id,
        req.company.id,
      ]
    );
    return res.json({ vendor: upd.rows[0] });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to update vendor' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const used = await query(
      `SELECT 1 FROM bills WHERE company_id = $1 AND vendor_id = $2 LIMIT 1`,
      [req.company.id, req.params.id]
    );
    if (used.rows.length) {
      return res.status(400).json({ error: 'Vendor is linked to bills; deactivate instead' });
    }
    const r = await query(`DELETE FROM vendors WHERE id = $1 AND company_id = $2 RETURNING id`, [
      req.params.id,
      req.company.id,
    ]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to delete vendor' });
  }
});

router.get('/:id/statement', async (req, res) => {
  try {
    const {
      from,
      to,
      include_opening = 'true',
      include_unposted = 'false',
      branch_id = null,
      currency = null,
    } = req.query;
    if (!from || !to) return res.status(400).json({ error: 'from and to are required' });
    const v = await query(`SELECT id, name FROM vendors WHERE id = $1 AND company_id = $2`, [req.params.id, req.company.id]);
    if (!v.rows.length) return res.status(404).json({ error: 'Vendor not found' });

    const opening = await query(
      `SELECT COALESCE(SUM(GREATEST(total_amount - paid_amount, 0)), 0)::numeric(18,2) AS v
       FROM bills
       WHERE company_id = $1
         AND vendor_id = $2
         AND ($4::boolean = TRUE OR status <> 'draft'::bill_status)
         AND bill_date < $3::date`,
      [req.company.id, req.params.id, from, include_unposted === 'true']
    );
    const bills = await query(
      `SELECT b.*
       FROM bills b
       LEFT JOIN transactions bt ON bt.id = b.posting_transaction_id AND bt.company_id = b.company_id
       WHERE b.company_id = $1
         AND b.vendor_id = $2
         AND ($6::boolean = TRUE OR b.status <> 'draft'::bill_status)
         AND b.bill_date >= $3::date
         AND b.bill_date <= $4::date
         AND ($5::uuid IS NULL OR bt.branch_id = $5)
       ORDER BY b.bill_date ASC, b.created_at ASC`,
      [req.company.id, req.params.id, from, to, branch_id, include_unposted === 'true']
    );
    const payments = await query(
      `SELECT bp.*, b.bill_number, b.bill_date
       FROM bill_payments bp
       JOIN bills b ON b.id = bp.bill_id AND b.company_id = bp.company_id
       LEFT JOIN transactions pt ON pt.id = bp.payment_transaction_id AND pt.company_id = bp.company_id
       WHERE bp.company_id = $1
         AND b.vendor_id = $2
         AND bp.payment_date >= $3::date
         AND bp.payment_date <= $4::date
         AND ($5::uuid IS NULL OR pt.branch_id = $5)
       ORDER BY bp.payment_date ASC, bp.created_at ASC`,
      [req.company.id, req.params.id, from, to, branch_id]
    );
    const opening_balance = include_opening === 'true' ? Number(opening.rows[0].v) : 0;
    const bill_additions = bills.rows.reduce((s, x) => s + Number(x.total_amount), 0);
    const payments_applied = payments.rows.reduce((s, x) => s + Number(x.amount), 0);
    const closing_balance = Math.round((opening_balance + bill_additions - payments_applied) * 100) / 100;

    const rows = [
      ...bills.rows.map((x) => ({
        row_type: 'bill',
        row_id: x.id,
        row_date: x.bill_date,
        reference: x.bill_number || x.id,
        debit: Number(x.total_amount),
        credit: 0,
      })),
      ...payments.rows.map((x) => ({
        row_type: 'bill_payment',
        row_id: x.id,
        row_date: x.payment_date,
        reference: x.reference || x.id,
        debit: 0,
        credit: Number(x.amount),
      })),
    ].sort((a, b) => String(a.row_date).localeCompare(String(b.row_date)));
    let running = opening_balance;
    const detailed_rows = rows.map((r) => {
      running = Math.round((running + Number(r.debit) - Number(r.credit)) * 100) / 100;
      return { ...r, running_balance: running };
    });

    return res.json({
      vendor: v.rows[0],
      from,
      to,
      filters: {
        include_opening: include_opening === 'true',
        include_unposted: include_unposted === 'true',
        branch_id,
        currency,
      },
      opening_balance,
      bill_additions: Math.round(bill_additions * 100) / 100,
      payments_applied: Math.round(payments_applied * 100) / 100,
      closing_balance,
      bills: bills.rows,
      payments: payments.rows,
      detailed_rows,
      note:
        currency ? 'currency filter is accepted for workflow parity; current AP statement rows are base-currency amounts.' : null,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to build vendor statement' });
  }
});

router.get('/:id/statement/drilldown', async (req, res) => {
  try {
    const { row_type, row_id } = req.query;
    if (!row_type || !row_id) return res.status(400).json({ error: 'row_type and row_id are required' });
    if (row_type === 'bill') {
      const r = await query(`SELECT * FROM bills WHERE id = $1 AND company_id = $2 AND vendor_id = $3`, [
        row_id,
        req.company.id,
        req.params.id,
      ]);
      if (!r.rows.length) return res.status(404).json({ error: 'Bill row not found' });
      return res.json({ row_type, details: r.rows[0] });
    }
    if (row_type === 'bill_payment') {
      const r = await query(
        `SELECT bp.*
         FROM bill_payments bp
         JOIN bills b ON b.id = bp.bill_id AND b.company_id = bp.company_id
         WHERE bp.id = $1 AND bp.company_id = $2 AND b.vendor_id = $3`,
        [row_id, req.company.id, req.params.id]
      );
      if (!r.rows.length) return res.status(404).json({ error: 'Bill payment row not found' });
      return res.json({ row_type, details: r.rows[0] });
    }
    return res.status(400).json({ error: 'row_type must be bill|bill_payment' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to load vendor statement drilldown' });
  }
});

router.get('/:id/statement-confirmations', async (req, res) => {
  try {
    if (!(await statementConfirmationsTableExists())) {
      return res.status(503).json({ error: 'Statement confirmation schema not installed.', hint: statementSchemaHint() });
    }
    const r = await query(
      `SELECT *
       FROM statement_confirmations
       WHERE company_id = $1
         AND party_type = 'vendor'::statement_party_type
         AND party_id = $2
       ORDER BY period_to DESC, created_at DESC`,
      [req.company.id, String(req.params.id)]
    );
    return res.json({ confirmations: r.rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to list statement confirmations' });
  }
});

router.post('/:id/statement-confirmations', async (req, res) => {
  try {
    if (!(await statementConfirmationsTableExists())) {
      return res.status(503).json({ error: 'Statement confirmation schema not installed.', hint: statementSchemaHint() });
    }
    const { period_from, period_to, status = 'sent', notes = null } = req.body || {};
    if (!period_from || !period_to) return res.status(400).json({ error: 'period_from and period_to are required' });
    const ins = await query(
      `INSERT INTO statement_confirmations (
         company_id, party_type, party_id, period_from, period_to, status, notes, created_by, updated_by,
         acknowledged_at, disputed_at
       )
       VALUES ($1,'vendor',$2,$3,$4,$5::statement_confirmation_status,$6,$7,$7,
         CASE WHEN $5 = 'acknowledged' THEN NOW() ELSE NULL END,
         CASE WHEN $5 = 'disputed' THEN NOW() ELSE NULL END
       )
       RETURNING *`,
      [req.company.id, String(req.params.id), period_from, period_to, status, notes, req.user.id]
    );
    return res.status(201).json({ confirmation: ins.rows[0] });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to create statement confirmation' });
  }
});

export default router;

