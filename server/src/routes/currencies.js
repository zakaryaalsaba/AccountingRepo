import { Router } from 'express';
import { pool, query } from '../db.js';
import { authRequired } from '../middleware/auth.js';
import { companyContext } from '../middleware/companyContext.js';
import { assertDateOpen } from '../utils/periodLocks.js';
import { currencySchemaHint, currencyTablesExist } from '../utils/currencySchema.js';

const router = Router();
router.use(authRequired, companyContext);

function r8(v) {
  return Math.round(Number(v) * 100000000) / 100000000;
}
function r2(v) {
  return Math.round(Number(v) * 100) / 100;
}

async function latestRate(companyId, fromCurrency, toCurrency, asOf, client = pool) {
  if (fromCurrency === toCurrency) return 1;
  const r = await client.query(
    `SELECT rate
     FROM exchange_rates
     WHERE company_id = $1
       AND from_currency = $2
       AND to_currency = $3
       AND rate_date <= $4::date
     ORDER BY rate_date DESC
     LIMIT 1`,
    [companyId, fromCurrency, toCurrency, asOf]
  );
  return r.rows[0] ? Number(r.rows[0].rate) : null;
}

router.use(async (_req, res, next) => {
  if (!(await currencyTablesExist())) {
    return res.status(503).json({ error: 'Multi-currency schema not installed.', hint: currencySchemaHint() });
  }
  return next();
});

router.get('/', async (req, res) => {
  try {
    const r = await query(
      `SELECT * FROM company_currencies WHERE company_id = $1 ORDER BY is_base DESC, currency_code ASC`,
      [req.company.id]
    );
    return res.json({ currencies: r.rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to list company currencies' });
  }
});

router.post('/', async (req, res) => {
  try {
    const { currency_code, is_base = false } = req.body || {};
    if (!currency_code) return res.status(400).json({ error: 'currency_code is required' });
    const c = String(currency_code).trim().toUpperCase();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (is_base) {
        await client.query(`UPDATE company_currencies SET is_base = FALSE WHERE company_id = $1`, [req.company.id]);
      }
      const up = await client.query(
        `INSERT INTO company_currencies (company_id, currency_code, is_base)
         VALUES ($1,$2,$3)
         ON CONFLICT (company_id, currency_code)
         DO UPDATE SET is_base = EXCLUDED.is_base
         RETURNING *`,
        [req.company.id, c, Boolean(is_base)]
      );
      const anyBase = await client.query(
        `SELECT 1 FROM company_currencies WHERE company_id = $1 AND is_base = TRUE LIMIT 1`,
        [req.company.id]
      );
      if (!anyBase.rows.length) {
        await client.query(
          `UPDATE company_currencies SET is_base = TRUE
           WHERE id = (
             SELECT id FROM company_currencies WHERE company_id = $1 ORDER BY created_at ASC LIMIT 1
           )`,
          [req.company.id]
        );
      }
      await client.query('COMMIT');
      return res.status(201).json({ currency: up.rows[0] });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to save company currency' });
  }
});

router.get('/rates', async (req, res) => {
  try {
    const { from_currency, to_currency, as_of } = req.query;
    if (from_currency && to_currency && as_of) {
      const rate = await latestRate(
        req.company.id,
        String(from_currency).toUpperCase(),
        String(to_currency).toUpperCase(),
        as_of
      );
      return res.json({ rate });
    }
    const r = await query(
      `SELECT * FROM exchange_rates WHERE company_id = $1 ORDER BY rate_date DESC, created_at DESC`,
      [req.company.id]
    );
    return res.json({ rates: r.rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to list exchange rates' });
  }
});

router.post('/rates', async (req, res) => {
  try {
    const { rate_date, from_currency, to_currency, rate } = req.body || {};
    if (!rate_date || !from_currency || !to_currency || !rate) {
      return res.status(400).json({ error: 'rate_date, from_currency, to_currency, rate are required' });
    }
    const ins = await query(
      `INSERT INTO exchange_rates (company_id, rate_date, from_currency, to_currency, rate)
       VALUES ($1,$2::date,$3,$4,$5)
       ON CONFLICT (company_id, rate_date, from_currency, to_currency)
       DO UPDATE SET rate = EXCLUDED.rate
       RETURNING *`,
      [
        req.company.id,
        rate_date,
        String(from_currency).trim().toUpperCase(),
        String(to_currency).trim().toUpperCase(),
        r8(rate),
      ]
    );
    return res.status(201).json({ exchange_rate: ins.rows[0] });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to save exchange rate' });
  }
});

router.post('/fx/realized', async (req, res) => {
  const { settlement_date, from_currency, to_currency, amount_foreign, invoice_rate, settle_rate, post = false } =
    req.body || {};
  if (!settlement_date || !from_currency || !to_currency || !amount_foreign || !invoice_rate || !settle_rate) {
    return res.status(400).json({ error: 'Missing required realized FX fields' });
  }
  const amount = Number(amount_foreign);
  const origBase = r2(amount * Number(invoice_rate));
  const settleBase = r2(amount * Number(settle_rate));
  const diff = r2(settleBase - origBase);
  let transaction_id = null;
  if (post && diff !== 0) {
    const client = await pool.connect();
    try {
      await assertDateOpen(req.company.id, settlement_date, client);
      await client.query('BEGIN');
      const cash = await client.query(
        `SELECT id FROM accounts WHERE company_id = $1 AND code = '1000' AND is_active = TRUE LIMIT 1`,
        [req.company.id]
      );
      const gain = await client.query(
        `SELECT id FROM accounts WHERE company_id = $1 AND code = '4100' AND is_active = TRUE LIMIT 1`,
        [req.company.id]
      );
      const loss = await client.query(
        `SELECT id FROM accounts WHERE company_id = $1 AND code = '5101' AND is_active = TRUE LIMIT 1`,
        [req.company.id]
      );
      if (!cash.rows.length || (!gain.rows.length && diff > 0) || (!loss.rows.length && diff < 0)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Missing FX or cash accounts (1000, 4100, 5101)' });
      }
      const tx = await client.query(
        `INSERT INTO transactions (company_id, entry_date, description, reference)
         VALUES ($1,$2::date,$3,$4)
         RETURNING id`,
        [req.company.id, settlement_date, 'Realized FX adjustment', 'FX-REALIZED']
      );
      transaction_id = tx.rows[0].id;
      if (diff > 0) {
        await client.query(
          `INSERT INTO transaction_lines (transaction_id, account_id, debit, credit) VALUES ($1,$2,$3,0)`,
          [transaction_id, cash.rows[0].id, diff]
        );
        await client.query(
          `INSERT INTO transaction_lines (transaction_id, account_id, debit, credit) VALUES ($1,$2,0,$3)`,
          [transaction_id, gain.rows[0].id, diff]
        );
      } else {
        const v = Math.abs(diff);
        await client.query(
          `INSERT INTO transaction_lines (transaction_id, account_id, debit, credit) VALUES ($1,$2,$3,0)`,
          [transaction_id, loss.rows[0].id, v]
        );
        await client.query(
          `INSERT INTO transaction_lines (transaction_id, account_id, debit, credit) VALUES ($1,$2,0,$3)`,
          [transaction_id, cash.rows[0].id, v]
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
  return res.json({
    settlement_date,
    from_currency,
    to_currency,
    amount_foreign: r2(amount),
    original_base_amount: origBase,
    settlement_base_amount: settleBase,
    realized_fx_difference: diff,
    transaction_id,
  });
});

router.post('/fx/revalue', async (req, res) => {
  const { as_of, from_currency, to_currency, open_amount_foreign, carrying_rate, post = false } = req.body || {};
  if (!as_of || !from_currency || !to_currency || !open_amount_foreign || !carrying_rate) {
    return res.status(400).json({ error: 'Missing required revaluation fields' });
  }
  const closeRate = await latestRate(
    req.company.id,
    String(from_currency).toUpperCase(),
    String(to_currency).toUpperCase(),
    as_of
  );
  if (!closeRate) return res.status(400).json({ error: 'No closing rate available for as_of date' });
  const amount = Number(open_amount_foreign);
  const carryingBase = r2(amount * Number(carrying_rate));
  const closingBase = r2(amount * closeRate);
  const diff = r2(closingBase - carryingBase);
  let transaction_id = null;
  if (post && diff !== 0) {
    const client = await pool.connect();
    try {
      await assertDateOpen(req.company.id, as_of, client);
      await client.query('BEGIN');
      const gain = await client.query(
        `SELECT id FROM accounts WHERE company_id = $1 AND code = '4100' AND is_active = TRUE LIMIT 1`,
        [req.company.id]
      );
      const loss = await client.query(
        `SELECT id FROM accounts WHERE company_id = $1 AND code = '5101' AND is_active = TRUE LIMIT 1`,
        [req.company.id]
      );
      const ar = await client.query(
        `SELECT id FROM accounts WHERE company_id = $1 AND code = '1100' AND is_active = TRUE LIMIT 1`,
        [req.company.id]
      );
      if (!ar.rows.length || !gain.rows.length || !loss.rows.length) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Missing FX or AR accounts (1100, 4100, 5101)' });
      }
      const tx = await client.query(
        `INSERT INTO transactions (company_id, entry_date, description, reference)
         VALUES ($1,$2::date,$3,$4)
         RETURNING id`,
        [req.company.id, as_of, 'Unrealized FX revaluation', 'FX-REVALUE']
      );
      transaction_id = tx.rows[0].id;
      if (diff > 0) {
        await client.query(
          `INSERT INTO transaction_lines (transaction_id, account_id, debit, credit) VALUES ($1,$2,$3,0)`,
          [transaction_id, ar.rows[0].id, diff]
        );
        await client.query(
          `INSERT INTO transaction_lines (transaction_id, account_id, debit, credit) VALUES ($1,$2,0,$3)`,
          [transaction_id, gain.rows[0].id, diff]
        );
      } else {
        const v = Math.abs(diff);
        await client.query(
          `INSERT INTO transaction_lines (transaction_id, account_id, debit, credit) VALUES ($1,$2,$3,0)`,
          [transaction_id, loss.rows[0].id, v]
        );
        await client.query(
          `INSERT INTO transaction_lines (transaction_id, account_id, debit, credit) VALUES ($1,$2,0,$3)`,
          [transaction_id, ar.rows[0].id, v]
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
  return res.json({
    as_of,
    from_currency,
    to_currency,
    open_amount_foreign: r2(amount),
    carrying_base_amount: carryingBase,
    closing_rate: closeRate,
    closing_base_amount: closingBase,
    unrealized_fx_difference: diff,
    transaction_id,
  });
});

export default router;

