import { Router } from 'express';
import { pool, query } from '../db.js';
import { authRequired } from '../middleware/auth.js';
import { companyContext } from '../middleware/companyContext.js';
import { assertDateOpen } from '../utils/periodLocks.js';
import { serviceInvoiceSchemaHint, serviceInvoiceTablesExist } from '../utils/serviceInvoiceSchema.js';
import { isModuleEnabled } from '../utils/featureFlags.js';

const router = Router();
router.use(authRequired, companyContext);

const r2 = (x) => Math.round(Number(x || 0) * 100) / 100;
const r4 = (x) => Math.round(Number(x || 0) * 10000) / 10000;

router.use(async (_req, res, next) => {
  if (await serviceInvoiceTablesExist()) return next();
  return res.status(503).json({ error: 'Service invoice schema not installed.', hint: serviceInvoiceSchemaHint() });
});

router.use(async (req, res, next) => {
  if (await isModuleEnabled(req.company.id, 'service_invoices', true)) return next();
  return res.status(403).json({ error: 'Service invoices module is disabled for this company' });
});

router.get('/', async (req, res) => {
  try {
    const r = await query(
      `SELECT *
       FROM service_invoices
       WHERE company_id = $1
       ORDER BY invoice_date DESC, created_at DESC`,
      [req.company.id]
    );
    return res.json({ service_invoices: r.rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to list service invoices' });
  }
});

router.post('/', async (req, res) => {
  const {
    customer_name,
    invoice_date,
    service_description,
    quantity,
    unit_price,
    tax_rate_percent = 0,
    project_id = null,
    status = 'issued',
  } = req.body || {};
  if (!customer_name || !invoice_date || !quantity || unit_price === undefined) {
    return res.status(400).json({ error: 'customer_name, invoice_date, quantity, unit_price are required' });
  }
  const q = r4(quantity);
  const price = r4(unit_price);
  if (q <= 0 || price < 0) return res.status(400).json({ error: 'Invalid quantity or unit_price' });
  const subtotal = r2(q * price);
  const tax = r2(subtotal * (Number(tax_rate_percent || 0) / 100));
  const total = r2(subtotal + tax);
  const client = await pool.connect();
  try {
    await assertDateOpen(req.company.id, invoice_date, client);
    await client.query('BEGIN');
    const ins = await client.query(
      `INSERT INTO service_invoices (
         company_id, customer_name, invoice_date, service_description, quantity, unit_price,
         subtotal_amount, tax_rate_percent, tax_amount, total_amount, project_id, status, created_by
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::service_invoice_status,$13)
       RETURNING *`,
      [
        req.company.id,
        String(customer_name).trim(),
        invoice_date,
        service_description ? String(service_description) : null,
        q,
        price,
        subtotal,
        Number(tax_rate_percent || 0),
        tax,
        total,
        project_id || null,
        status === 'draft' ? 'draft' : 'issued',
        req.user.id,
      ]
    );
    await client.query('COMMIT');
    return res.status(201).json({ service_invoice: ins.rows[0] });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    return res.status(500).json({ error: 'Failed to create service invoice' });
  } finally {
    client.release();
  }
});

router.post('/:id/returns', async (req, res) => {
  const { return_date, return_quantity, reason } = req.body || {};
  if (!return_date || !return_quantity) {
    return res.status(400).json({ error: 'return_date and return_quantity are required' });
  }
  const qty = r4(return_quantity);
  if (qty <= 0) return res.status(400).json({ error: 'return_quantity must be positive' });
  const client = await pool.connect();
  try {
    await assertDateOpen(req.company.id, return_date, client);
    await client.query('BEGIN');
    const invRes = await client.query(
      `SELECT *
       FROM service_invoices
       WHERE id = $1 AND company_id = $2
       FOR UPDATE`,
      [req.params.id, req.company.id]
    );
    if (!invRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Service invoice not found' });
    }
    const inv = invRes.rows[0];
    const remainingQty = r4(Number(inv.quantity) - Number(inv.returned_quantity || 0));
    if (qty > remainingQty + 0.0001) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Return quantity exceeds original unreturned quantity' });
    }
    const unit = Number(inv.unit_price);
    const sub = r2(qty * unit);
    const tax = r2(sub * (Number(inv.tax_rate_percent || 0) / 100));
    const total = r2(sub + tax);
    const newReturnedQty = r4(Number(inv.returned_quantity || 0) + qty);
    const newReturnedAmount = r2(Number(inv.returned_amount || 0) + total);
    const newStatus = newReturnedQty >= Number(inv.quantity) - 0.0001 ? 'returned' : 'partially_returned';

    const ret = await client.query(
      `INSERT INTO service_invoice_returns (
         company_id, service_invoice_id, return_date, return_quantity, return_subtotal, return_tax, return_total, reason, created_by
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [req.company.id, req.params.id, return_date, qty, sub, tax, total, reason ? String(reason) : null, req.user.id]
    );
    const upd = await client.query(
      `UPDATE service_invoices
       SET returned_quantity = $1,
           returned_amount = $2,
           status = $3::service_invoice_status,
           updated_at = NOW()
       WHERE id = $4 AND company_id = $5
       RETURNING *`,
      [newReturnedQty, newReturnedAmount, newStatus, req.params.id, req.company.id]
    );
    await client.query('COMMIT');
    return res.status(201).json({ service_return: ret.rows[0], service_invoice: upd.rows[0] });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    return res.status(500).json({ error: 'Failed to create service return' });
  } finally {
    client.release();
  }
});

export default router;
