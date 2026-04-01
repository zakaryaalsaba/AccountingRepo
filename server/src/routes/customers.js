import { Router } from 'express';
import { query } from '../db.js';
import { authRequired } from '../middleware/auth.js';
import { companyContext } from '../middleware/companyContext.js';
import { customerWorkflowSchemaHint, customerRemindersTableExists } from '../utils/customerWorkflowSchema.js';
import { statementConfirmationsTableExists, statementSchemaHint } from '../utils/statementSchema.js';

const router = Router();
router.use(authRequired, companyContext);

router.get('/', async (req, res) => {
  try {
    const { include_inactive } = req.query;
    const includeInactive = include_inactive === 'true';
    const r = await query(
      `SELECT *
       FROM customers
       WHERE company_id = $1
         AND ($2::boolean = TRUE OR is_active = TRUE)
       ORDER BY name ASC`,
      [req.company.id, includeInactive]
    );
    return res.json({ customers: r.rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to list customers' });
  }
});

router.post('/', async (req, res) => {
  try {
    const { name, email, phone, tax_id, payment_terms_days, credit_limit, notes } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'name is required' });
    }
    const ins = await query(
      `INSERT INTO customers (
         company_id, name, email, phone, tax_id, payment_terms_days, credit_limit, notes
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        req.company.id,
        String(name).trim(),
        email ? String(email).trim() : null,
        phone ? String(phone).trim() : null,
        tax_id ? String(tax_id).trim() : null,
        Number(payment_terms_days || 0),
        Number(credit_limit || 0),
        notes ? String(notes) : null,
      ]
    );
    return res.status(201).json({ customer: ins.rows[0] });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to create customer' });
  }
});

router.patch('/:id', async (req, res) => {
  try {
    const cur = await query(
      `SELECT * FROM customers WHERE id = $1 AND company_id = $2`,
      [req.params.id, req.company.id]
    );
    if (!cur.rows.length) return res.status(404).json({ error: 'Not found' });
    const row = cur.rows[0];
    const b = req.body || {};
    const upd = await query(
      `UPDATE customers
       SET name = $1,
           email = $2,
           phone = $3,
           tax_id = $4,
           payment_terms_days = $5,
           credit_limit = $6,
           notes = $7,
           is_active = $8,
           updated_at = NOW()
       WHERE id = $9 AND company_id = $10
       RETURNING *`,
      [
        b.name !== undefined ? String(b.name).trim() : row.name,
        b.email !== undefined ? (b.email ? String(b.email).trim() : null) : row.email,
        b.phone !== undefined ? (b.phone ? String(b.phone).trim() : null) : row.phone,
        b.tax_id !== undefined ? (b.tax_id ? String(b.tax_id).trim() : null) : row.tax_id,
        b.payment_terms_days !== undefined ? Number(b.payment_terms_days) : row.payment_terms_days,
        b.credit_limit !== undefined ? Number(b.credit_limit) : row.credit_limit,
        b.notes !== undefined ? (b.notes ? String(b.notes) : null) : row.notes,
        b.is_active !== undefined ? Boolean(b.is_active) : row.is_active,
        req.params.id,
        req.company.id,
      ]
    );
    return res.json({ customer: upd.rows[0] });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to update customer' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const used = await query(
      `SELECT 1
       FROM invoices
       WHERE company_id = $1
         AND payer_type::text = 'customer'
         AND payer_id = $2
       LIMIT 1`,
      [req.company.id, Number(req.params.id)]
    );
    if (used.rows.length) {
      return res.status(400).json({
        error: 'Customer is linked to invoices; deactivate instead of deleting',
      });
    }
    const r = await query(
      `DELETE FROM customers WHERE id = $1 AND company_id = $2 RETURNING id`,
      [req.params.id, req.company.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to delete customer' });
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
    const c = await query(
      `SELECT id, name
       FROM customers
       WHERE id = $1 AND company_id = $2`,
      [req.params.id, req.company.id]
    );
    if (!c.rows.length) return res.status(404).json({ error: 'Customer not found' });

    const openingInv = await query(
      `SELECT COALESCE(SUM(GREATEST(total_amount - paid_amount, 0)), 0)::numeric(18,2) AS v
       FROM invoices
       WHERE company_id = $1
         AND payer_type::text = 'customer'
         AND payer_id = $2
         AND ($4::boolean = TRUE OR status <> 'draft'::invoice_status)
         AND invoice_date < $3::date`,
      [req.company.id, Number(req.params.id), from, include_unposted === 'true']
    );
    const branchFilter =
      branch_id
        ? `AND (
             sale_transaction_id IN (
               SELECT id FROM transactions WHERE company_id = $1 AND branch_id = $5
             )
             OR payment_transaction_id IN (
               SELECT id FROM transactions WHERE company_id = $1 AND branch_id = $5
             )
           )`
        : '';
    const inRangeInv = await query(
      `SELECT id, invoice_date::date, customer_name, total_amount, paid_amount,
              GREATEST(total_amount - paid_amount, 0)::numeric(18,2) AS balance
       FROM invoices
       WHERE company_id = $1
         AND payer_type::text = 'customer'
         AND payer_id = $2
         AND ($6::boolean = TRUE OR status <> 'draft'::invoice_status)
         AND invoice_date >= $3::date
         AND invoice_date <= $4::date
         ${branchFilter}
       ORDER BY invoice_date ASC, created_at ASC`,
      [req.company.id, Number(req.params.id), from, to, branch_id, include_unposted === 'true']
    );
    const payments = await query(
      `SELECT p.id AS payment_id,
              p.payment_date::date AS payment_date,
              p.amount,
              p.method::text AS method,
              COALESCE(SUM(pa.amount_applied), 0)::numeric(18,2) AS applied_amount
       FROM payments p
       LEFT JOIN payment_allocations pa
         ON pa.payment_id = p.id
         AND pa.company_id = p.company_id
       LEFT JOIN invoices i
         ON i.id = pa.invoice_id
         AND i.company_id = p.company_id
       LEFT JOIN transactions pt ON pt.id = p.payment_transaction_id AND pt.company_id = p.company_id
       WHERE p.company_id = $1
         AND p.payment_date::date >= $2::date
         AND p.payment_date::date <= $3::date
         AND (i.payer_type::text = 'customer' AND i.payer_id = $4)
         AND ($5::uuid IS NULL OR pt.branch_id = $5)
       GROUP BY p.id
       ORDER BY p.payment_date ASC, p.created_at ASC`,
      [req.company.id, from, to, Number(req.params.id), branch_id]
    );

    const opening_balance = include_opening === 'true' ? Number(openingInv.rows[0].v) : 0;
    const invoice_additions = inRangeInv.rows.reduce((s, x) => s + Number(x.total_amount), 0);
    const payments_applied = payments.rows.reduce((s, x) => s + Number(x.applied_amount), 0);
    const closing_balance = Math.round((opening_balance + invoice_additions - payments_applied) * 100) / 100;
    const rows = [
      ...inRangeInv.rows.map((x) => ({
        row_type: 'invoice',
        row_id: x.id,
        row_date: x.invoice_date,
        reference: x.id,
        debit: Number(x.total_amount),
        credit: 0,
      })),
      ...payments.rows.map((x) => ({
        row_type: 'payment',
        row_id: x.payment_id,
        row_date: x.payment_date,
        reference: x.payment_id,
        debit: 0,
        credit: Number(x.applied_amount),
      })),
    ].sort((a, b) => String(a.row_date).localeCompare(String(b.row_date)));
    let running = opening_balance;
    const detailed_rows = rows.map((r) => {
      running = Math.round((running + Number(r.debit) - Number(r.credit)) * 100) / 100;
      return { ...r, running_balance: running };
    });

    return res.json({
      customer: c.rows[0],
      from,
      to,
      filters: {
        include_opening: include_opening === 'true',
        include_unposted: include_unposted === 'true',
        branch_id,
        currency,
      },
      opening_balance,
      invoice_additions: Math.round(invoice_additions * 100) / 100,
      payments_applied: Math.round(payments_applied * 100) / 100,
      closing_balance,
      invoices: inRangeInv.rows,
      payments: payments.rows,
      detailed_rows,
      note:
        currency ? 'currency filter is accepted for workflow parity; current AR statement rows are base-currency amounts.' : null,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to build customer statement' });
  }
});

router.get('/:id/statement/drilldown', async (req, res) => {
  try {
    const { row_type, row_id } = req.query;
    if (!row_type || !row_id) return res.status(400).json({ error: 'row_type and row_id are required' });
    if (row_type === 'invoice') {
      const r = await query(
        `SELECT *
         FROM invoices
         WHERE id = $1 AND company_id = $2
           AND payer_type::text = 'customer'
           AND payer_id = $3`,
        [row_id, req.company.id, Number(req.params.id)]
      );
      if (!r.rows.length) return res.status(404).json({ error: 'Invoice row not found' });
      return res.json({ row_type, details: r.rows[0] });
    }
    if (row_type === 'payment') {
      const r = await query(
        `SELECT p.*
         FROM payments p
         JOIN payment_allocations pa ON pa.payment_id = p.id AND pa.company_id = p.company_id
         JOIN invoices i ON i.id = pa.invoice_id AND i.company_id = p.company_id
         WHERE p.id = $1
           AND p.company_id = $2
           AND i.payer_type::text = 'customer'
           AND i.payer_id = $3
         LIMIT 1`,
        [row_id, req.company.id, Number(req.params.id)]
      );
      if (!r.rows.length) return res.status(404).json({ error: 'Payment row not found' });
      return res.json({ row_type, details: r.rows[0] });
    }
    return res.status(400).json({ error: 'row_type must be invoice|payment' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to load statement drilldown' });
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
         AND party_type = 'customer'::statement_party_type
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
       VALUES ($1,'customer',$2,$3,$4,$5::statement_confirmation_status,$6,$7,$7,
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

router.get('/:id/reminders', async (req, res) => {
  try {
    if (!(await customerRemindersTableExists())) {
      return res.status(503).json({
        error: 'Customer reminder schema not installed.',
        hint: customerWorkflowSchemaHint(),
      });
    }
    const r = await query(
      `SELECT *
       FROM customer_reminders
       WHERE company_id = $1 AND customer_id = $2
       ORDER BY reminder_date DESC, created_at DESC`,
      [req.company.id, Number(req.params.id)]
    );
    return res.json({ reminders: r.rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to list customer reminders' });
  }
});

router.post('/:id/reminders', async (req, res) => {
  try {
    if (!(await customerRemindersTableExists())) {
      return res.status(503).json({
        error: 'Customer reminder schema not installed.',
        hint: customerWorkflowSchemaHint(),
      });
    }
    const { reminder_date, channel = 'email', subject, message } = req.body || {};
    if (!reminder_date || !message) {
      return res.status(400).json({ error: 'reminder_date and message are required' });
    }
    const c = await query(`SELECT id FROM customers WHERE id = $1 AND company_id = $2`, [
      req.params.id,
      req.company.id,
    ]);
    if (!c.rows.length) return res.status(404).json({ error: 'Customer not found' });
    const ins = await query(
      `INSERT INTO customer_reminders (
         company_id, customer_id, reminder_date, channel, subject, message, status, created_by
       )
       VALUES ($1,$2,$3::date,$4,$5,$6,'queued',$7)
       RETURNING *`,
      [
        req.company.id,
        Number(req.params.id),
        reminder_date,
        String(channel),
        subject ? String(subject) : null,
        String(message),
        req.user.id,
      ]
    );
    return res.status(201).json({ reminder: ins.rows[0] });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to create reminder' });
  }
});

export default router;
