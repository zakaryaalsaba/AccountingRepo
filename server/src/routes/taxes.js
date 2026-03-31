import { Router } from 'express';
import { query } from '../db.js';
import { authRequired } from '../middleware/auth.js';
import { companyContext } from '../middleware/companyContext.js';
import { calcTax, taxSchemaHint, taxTablesExist } from '../utils/taxSchema.js';

const router = Router();
router.use(authRequired, companyContext);

router.use(async (_req, res, next) => {
  if (!(await taxTablesExist())) {
    return res.status(503).json({ error: 'Tax schema not installed.', hint: taxSchemaHint() });
  }
  return next();
});

router.get('/rates', async (req, res) => {
  try {
    const r = await query(
      `SELECT * FROM tax_rates WHERE company_id = $1 ORDER BY created_at DESC`,
      [req.company.id]
    );
    return res.json({ tax_rates: r.rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to list tax rates' });
  }
});

router.post('/rates', async (req, res) => {
  try {
    const { name, rate_percent } = req.body || {};
    if (!name || rate_percent === undefined) {
      return res.status(400).json({ error: 'name and rate_percent are required' });
    }
    const ins = await query(
      `INSERT INTO tax_rates (company_id, name, rate_percent) VALUES ($1,$2,$3) RETURNING *`,
      [req.company.id, String(name).trim(), Number(rate_percent)]
    );
    return res.status(201).json({ tax_rate: ins.rows[0] });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to create tax rate' });
  }
});

router.get('/groups', async (req, res) => {
  try {
    const g = await query(`SELECT * FROM tax_groups WHERE company_id = $1 ORDER BY created_at DESC`, [
      req.company.id,
    ]);
    const lines = await query(
      `SELECT tgr.tax_group_id, tr.*
       FROM tax_group_rates tgr
       JOIN tax_rates tr ON tr.id = tgr.tax_rate_id
       WHERE tgr.company_id = $1`,
      [req.company.id]
    );
    const byGroup = new Map();
    for (const row of lines.rows) {
      if (!byGroup.has(row.tax_group_id)) byGroup.set(row.tax_group_id, []);
      byGroup.get(row.tax_group_id).push(row);
    }
    return res.json({
      tax_groups: g.rows.map((x) => ({ ...x, rates: byGroup.get(x.id) || [] })),
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to list tax groups' });
  }
});

router.post('/groups', async (req, res) => {
  try {
    const { name, tax_rate_ids = [] } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name is required' });
    const g = await query(
      `INSERT INTO tax_groups (company_id, name) VALUES ($1,$2) RETURNING *`,
      [req.company.id, String(name).trim()]
    );
    const gid = g.rows[0].id;
    for (const rid of tax_rate_ids) {
      await query(
        `INSERT INTO tax_group_rates (company_id, tax_group_id, tax_rate_id)
         VALUES ($1,$2,$3)
         ON CONFLICT (tax_group_id, tax_rate_id) DO NOTHING`,
        [req.company.id, gid, rid]
      );
    }
    return res.status(201).json({ tax_group: g.rows[0] });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to create tax group' });
  }
});

router.post('/calculate', async (req, res) => {
  try {
    const { amount, tax_rate_id, tax_inclusive = false } = req.body || {};
    if (amount === undefined) return res.status(400).json({ error: 'amount is required' });
    let rate = 0;
    if (tax_rate_id) {
      const r = await query(
        `SELECT rate_percent FROM tax_rates WHERE id = $1 AND company_id = $2 AND is_active = TRUE`,
        [tax_rate_id, req.company.id]
      );
      if (!r.rows.length) return res.status(400).json({ error: 'Invalid tax_rate_id' });
      rate = Number(r.rows[0].rate_percent);
    }
    return res.json(calcTax({ amountInput: amount, ratePercent: rate, taxInclusive: Boolean(tax_inclusive) }));
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to calculate tax' });
  }
});

router.get('/summary', async (req, res) => {
  try {
    const { from, to } = req.query;
    if (!from || !to) return res.status(400).json({ error: 'from and to are required' });
    const outTax = await query(
      `SELECT COALESCE(SUM(tax_amount),0)::numeric(18,2) AS v
       FROM invoices
       WHERE company_id = $1 AND invoice_date >= $2::date AND invoice_date <= $3::date`,
      [req.company.id, from, to]
    );
    const inTax = await query(
      `SELECT COALESCE(SUM(tax_amount),0)::numeric(18,2) AS v
       FROM bills
       WHERE company_id = $1 AND bill_date >= $2::date AND bill_date <= $3::date`,
      [req.company.id, from, to]
    );
    const output_tax = Number(outTax.rows[0].v);
    const input_tax = Number(inTax.rows[0].v);
    return res.json({
      from,
      to,
      output_tax,
      input_tax,
      net_tax_payable: Math.round((output_tax - input_tax) * 100) / 100,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to build tax summary' });
  }
});

export default router;

