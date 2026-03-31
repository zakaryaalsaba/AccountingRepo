import { Router } from 'express';
import { pool, query } from '../db.js';
import { authRequired } from '../middleware/auth.js';
import { companyContext } from '../middleware/companyContext.js';
import { assertDateOpen } from '../utils/periodLocks.js';
import { integrationSchemaHint, integrationTablesExist } from '../utils/integrationSchema.js';

const router = Router();
router.use(authRequired, companyContext);

function r2(v) {
  return Math.round(Number(v) * 100) / 100;
}

router.use(async (_req, res, next) => {
  if (!(await integrationTablesExist())) {
    return res.status(503).json({ error: 'Integrations schema not installed.', hint: integrationSchemaHint() });
  }
  return next();
});

router.get('/connections', async (req, res) => {
  try {
    const r = await query(
      `SELECT * FROM integration_connections WHERE company_id = $1 ORDER BY created_at DESC`,
      [req.company.id]
    );
    return res.json({ connections: r.rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to list integration connections' });
  }
});

router.post('/connections', async (req, res) => {
  try {
    const { provider, name, settings = {}, status = 'active' } = req.body || {};
    if (!provider || !name) return res.status(400).json({ error: 'provider and name are required' });
    const ins = await query(
      `INSERT INTO integration_connections (company_id, provider, name, settings, status)
       VALUES ($1,$2,$3,$4::jsonb,$5)
       RETURNING *`,
      [req.company.id, String(provider), String(name), JSON.stringify(settings || {}), String(status)]
    );
    return res.status(201).json({ connection: ins.rows[0] });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to create integration connection' });
  }
});

// Payment gateway integration
router.post('/payment-gateway/intents', async (req, res) => {
  try {
    const { connection_id, amount, currency = 'SAR', external_id } = req.body || {};
    if (!connection_id || !amount) return res.status(400).json({ error: 'connection_id and amount are required' });
    const evt = await query(
      `INSERT INTO payment_gateway_events (company_id, connection_id, event_type, external_id, payload, processed)
       VALUES ($1,$2,'payment_intent.created',$3,$4::jsonb,TRUE)
       RETURNING *`,
      [
        req.company.id,
        connection_id,
        external_id || null,
        JSON.stringify({ amount: r2(amount), currency }),
      ]
    );
    return res.status(201).json({
      intent: {
        id: evt.rows[0].id,
        status: 'created',
        amount: r2(amount),
        currency,
      },
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to create payment intent' });
  }
});

router.post('/payment-gateway/webhook', async (req, res) => {
  try {
    const { connection_id, event_type, external_id, payload = {} } = req.body || {};
    if (!event_type) return res.status(400).json({ error: 'event_type is required' });
    const ins = await query(
      `INSERT INTO payment_gateway_events (company_id, connection_id, event_type, external_id, payload, processed)
       VALUES ($1,$2,$3,$4,$5::jsonb,TRUE)
       RETURNING *`,
      [req.company.id, connection_id || null, String(event_type), external_id || null, JSON.stringify(payload || {})]
    );
    return res.status(201).json({ event: ins.rows[0] });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to process payment gateway webhook' });
  }
});

// Payroll summary posting
router.post('/payroll/summary-post', async (req, res) => {
  const { entry_date, gross_pay, deductions = 0, payroll_expense_account_id, payroll_payable_account_id, reference } =
    req.body || {};
  if (!entry_date || !gross_pay || !payroll_expense_account_id || !payroll_payable_account_id) {
    return res.status(400).json({
      error: 'entry_date, gross_pay, payroll_expense_account_id, payroll_payable_account_id are required',
    });
  }
  const gross = r2(gross_pay);
  const ded = r2(deductions);
  const net = r2(gross - ded);
  if (gross <= 0 || net < 0) return res.status(400).json({ error: 'Invalid payroll amounts' });
  const client = await pool.connect();
  try {
    await assertDateOpen(req.company.id, entry_date, client);
    await client.query('BEGIN');
    const tx = await client.query(
      `INSERT INTO transactions (company_id, entry_date, description, reference)
       VALUES ($1,$2::date,$3,$4)
       RETURNING *`,
      [req.company.id, entry_date, 'Payroll summary posting', reference || 'PAYROLL-SUMMARY']
    );
    const txId = tx.rows[0].id;
    await client.query(
      `INSERT INTO transaction_lines (transaction_id, account_id, debit, credit)
       VALUES ($1,$2,$3,0)`,
      [txId, payroll_expense_account_id, gross]
    );
    await client.query(
      `INSERT INTO transaction_lines (transaction_id, account_id, debit, credit)
       VALUES ($1,$2,0,$3)`,
      [txId, payroll_payable_account_id, net]
    );
    if (ded > 0) {
      await client.query(
        `INSERT INTO transaction_lines (transaction_id, account_id, debit, credit)
         VALUES ($1,$2,0,$3)`,
        [txId, payroll_payable_account_id, ded]
      );
    }
    await client.query('COMMIT');
    return res.status(201).json({ transaction: tx.rows[0], amounts: { gross, deductions: ded, net } });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    return res.status(500).json({ error: 'Failed to post payroll summary' });
  } finally {
    client.release();
  }
});

// E-commerce sales sync
router.post('/ecommerce/sales-sync', async (req, res) => {
  const { connection_id, order_date, external_order_id, customer_name, amount, currency_code = 'SAR' } = req.body || {};
  if (!order_date || !external_order_id || amount === undefined) {
    return res.status(400).json({ error: 'order_date, external_order_id, amount are required' });
  }
  const amt = r2(amount);
  const client = await pool.connect();
  try {
    await assertDateOpen(req.company.id, order_date, client);
    await client.query('BEGIN');
    const existing = await client.query(
      `SELECT id FROM ecommerce_sales_syncs WHERE company_id = $1 AND external_order_id = $2 LIMIT 1`,
      [req.company.id, String(external_order_id)]
    );
    if (existing.rows.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Order already synced' });
    }
    const ar = await client.query(
      `SELECT id FROM accounts WHERE company_id = $1 AND code = '1100' AND is_active = TRUE LIMIT 1`,
      [req.company.id]
    );
    const rev = await client.query(
      `SELECT id FROM accounts WHERE company_id = $1 AND code = '4000' AND is_active = TRUE LIMIT 1`,
      [req.company.id]
    );
    if (!ar.rows.length || !rev.rows.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Missing AR or revenue accounts (1100/4000)' });
    }
    const tx = await client.query(
      `INSERT INTO transactions (company_id, entry_date, description, reference)
       VALUES ($1,$2::date,$3,$4)
       RETURNING *`,
      [req.company.id, order_date, `E-commerce sale ${external_order_id}`, `ECOM-${external_order_id}`]
    );
    const txId = tx.rows[0].id;
    await client.query(
      `INSERT INTO transaction_lines (transaction_id, account_id, debit, credit) VALUES ($1,$2,$3,0)`,
      [txId, ar.rows[0].id, amt]
    );
    await client.query(
      `INSERT INTO transaction_lines (transaction_id, account_id, debit, credit) VALUES ($1,$2,0,$3)`,
      [txId, rev.rows[0].id, amt]
    );
    const sync = await client.query(
      `INSERT INTO ecommerce_sales_syncs (
         company_id, connection_id, external_order_id, order_date, customer_name, amount, currency_code, payload, imported_transaction_id
       )
       VALUES ($1,$2,$3,$4::date,$5,$6,$7,$8::jsonb,$9)
       RETURNING *`,
      [
        req.company.id,
        connection_id || null,
        String(external_order_id),
        order_date,
        customer_name ? String(customer_name) : null,
        amt,
        String(currency_code || 'SAR'),
        JSON.stringify(req.body || {}),
        txId,
      ]
    );
    await client.query('COMMIT');
    return res.status(201).json({ sync: sync.rows[0], transaction: tx.rows[0] });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    return res.status(500).json({ error: 'Failed to sync e-commerce sale' });
  } finally {
    client.release();
  }
});

// Banking API integration stub
router.post('/banking/sync', async (req, res) => {
  try {
    const { connection_id, bank_account_id, lines = [] } = req.body || {};
    if (!bank_account_id || !Array.isArray(lines)) {
      return res.status(400).json({ error: 'bank_account_id and lines[] are required' });
    }
    let imported = 0;
    for (const ln of lines) {
      if (!ln.statement_date || ln.amount === undefined) continue;
      await query(
        `INSERT INTO bank_statement_lines (
           company_id, bank_account_id, import_id, statement_date, description, reference, amount, running_balance
         )
         VALUES ($1,$2,NULL,$3::date,$4,$5,$6,$7)`,
        [
          req.company.id,
          bank_account_id,
          ln.statement_date,
          ln.description || null,
          ln.reference || null,
          r2(ln.amount),
          ln.running_balance !== undefined ? r2(ln.running_balance) : null,
        ]
      );
      imported += 1;
    }
    if (connection_id) {
      await query(
        `UPDATE integration_connections
         SET last_synced_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND company_id = $2`,
        [connection_id, req.company.id]
      );
    }
    return res.status(201).json({ imported_lines: imported });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed banking API sync import' });
  }
});

export default router;

