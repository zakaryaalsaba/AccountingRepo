import { Router } from 'express';
import { pool, query } from '../db.js';
import { authRequired } from '../middleware/auth.js';
import { companyContext } from '../middleware/companyContext.js';
import { assertDateOpen } from '../utils/periodLocks.js';
import { fixedAssetsSchemaHint, fixedAssetsTablesExist } from '../utils/fixedAssetsSchema.js';

const router = Router();
router.use(authRequired, companyContext);

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

async function validateAccounts(companyId, assetAccountId, accumId, expenseId, client = pool) {
  const r = await client.query(
    `SELECT id, type::text AS type
     FROM accounts
     WHERE company_id = $1 AND id = ANY($2::uuid[]) AND is_active = TRUE`,
    [companyId, [assetAccountId, accumId, expenseId]]
  );
  if (r.rows.length !== 3) {
    const err = new Error('One or more asset/depreciation accounts are invalid');
    err.status = 400;
    throw err;
  }
}

function monthlyDepreciation(asset) {
  const basis = round2(Number(asset.acquisition_cost) - Number(asset.residual_value || 0));
  if (basis <= 0) return 0;
  return round2(basis / Number(asset.useful_life_months));
}

async function accumulatedDep(companyId, assetId, client = pool) {
  const r = await client.query(
    `SELECT COALESCE(SUM(amount), 0)::numeric(18,2) AS v
     FROM fixed_asset_depreciation_entries
     WHERE company_id = $1 AND asset_id = $2`,
    [companyId, assetId]
  );
  return round2(r.rows[0].v);
}

router.use(async (_req, res, next) => {
  if (!(await fixedAssetsTablesExist())) {
    return res.status(503).json({ error: 'Fixed assets schema not installed.', hint: fixedAssetsSchemaHint() });
  }
  return next();
});

router.get('/', async (req, res) => {
  try {
    const r = await query(
      `SELECT fa.*,
              aa.code AS asset_account_code,
              ad.code AS accumulated_depr_account_code,
              de.code AS depreciation_expense_account_code
       FROM fixed_assets fa
       JOIN accounts aa ON aa.id = fa.asset_account_id
       JOIN accounts ad ON ad.id = fa.accumulated_depr_account_id
       JOIN accounts de ON de.id = fa.depreciation_expense_account_id
       WHERE fa.company_id = $1
       ORDER BY fa.acquisition_date DESC, fa.created_at DESC`,
      [req.company.id]
    );
    return res.json({ assets: r.rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to list fixed assets' });
  }
});

router.post('/', async (req, res) => {
  const {
    asset_code,
    name,
    acquisition_date,
    acquisition_cost,
    useful_life_months,
    residual_value = 0,
    asset_account_id,
    accumulated_depr_account_id,
    depreciation_expense_account_id,
  } = req.body || {};
  if (
    !name ||
    !acquisition_date ||
    !acquisition_cost ||
    !useful_life_months ||
    !asset_account_id ||
    !accumulated_depr_account_id ||
    !depreciation_expense_account_id
  ) {
    return res.status(400).json({ error: 'Missing required fixed asset fields' });
  }
  const client = await pool.connect();
  try {
    await assertDateOpen(req.company.id, acquisition_date, client);
    await client.query('BEGIN');
    await validateAccounts(
      req.company.id,
      asset_account_id,
      accumulated_depr_account_id,
      depreciation_expense_account_id,
      client
    );
    const ins = await client.query(
      `INSERT INTO fixed_assets (
         company_id, asset_code, name, acquisition_date, acquisition_cost, useful_life_months, residual_value,
         asset_account_id, accumulated_depr_account_id, depreciation_expense_account_id
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [
        req.company.id,
        asset_code ? String(asset_code).trim() : null,
        String(name).trim(),
        acquisition_date,
        round2(acquisition_cost),
        Number(useful_life_months),
        round2(residual_value),
        asset_account_id,
        accumulated_depr_account_id,
        depreciation_expense_account_id,
      ]
    );
    const fa = ins.rows[0];

    const cashAcc = await client.query(
      `SELECT id FROM accounts WHERE company_id = $1 AND code = '1000' AND is_active = TRUE LIMIT 1`,
      [req.company.id]
    );
    if (!cashAcc.rows.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Missing active cash account code 1000' });
    }
    const tx = await client.query(
      `INSERT INTO transactions (company_id, entry_date, description, reference)
       VALUES ($1,$2::date,$3,$4) RETURNING id`,
      [req.company.id, acquisition_date, `Fixed asset acquisition — ${fa.name}`, `FA-${fa.id.slice(0, 8)}`]
    );
    const tid = tx.rows[0].id;
    await client.query(
      `INSERT INTO transaction_lines (transaction_id, account_id, debit, credit) VALUES ($1,$2,$3,0)`,
      [tid, fa.asset_account_id, round2(fa.acquisition_cost)]
    );
    await client.query(
      `INSERT INTO transaction_lines (transaction_id, account_id, debit, credit) VALUES ($1,$2,0,$3)`,
      [tid, cashAcc.rows[0].id, round2(fa.acquisition_cost)]
    );
    await client.query(
      `UPDATE fixed_assets SET acquisition_transaction_id = $1, updated_at = NOW()
       WHERE id = $2 AND company_id = $3`,
      [tid, fa.id, req.company.id]
    );
    const out = await client.query(`SELECT * FROM fixed_assets WHERE id = $1 AND company_id = $2`, [
      fa.id,
      req.company.id,
    ]);
    await client.query('COMMIT');
    return res.status(201).json({ asset: out.rows[0] });
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.status === 400) return res.status(400).json({ error: e.message });
    console.error(e);
    return res.status(500).json({ error: 'Failed to create fixed asset' });
  } finally {
    client.release();
  }
});

router.post('/depreciation/run', async (req, res) => {
  const { period_start, period_end } = req.body || {};
  if (!period_start || !period_end) return res.status(400).json({ error: 'period_start and period_end required' });
  const client = await pool.connect();
  try {
    await assertDateOpen(req.company.id, period_end, client);
    await client.query('BEGIN');
    const assets = await client.query(
      `SELECT * FROM fixed_assets
       WHERE company_id = $1
         AND acquisition_date <= $2::date
         AND (is_disposed = FALSE OR disposal_date > $2::date)`,
      [req.company.id, period_end]
    );
    let posted = 0;
    for (const asset of assets.rows) {
      const exists = await client.query(
        `SELECT 1 FROM fixed_asset_depreciation_entries
         WHERE asset_id = $1 AND period_start = $2::date AND period_end = $3::date LIMIT 1`,
        [asset.id, period_start, period_end]
      );
      if (exists.rows.length) continue;
      const monthly = monthlyDepreciation(asset);
      if (monthly <= 0) continue;
      const accumulated = await accumulatedDep(req.company.id, asset.id, client);
      const basis = round2(Number(asset.acquisition_cost) - Number(asset.residual_value || 0));
      const remaining = round2(basis - accumulated);
      const amount = remaining < monthly ? remaining : monthly;
      if (amount <= 0) continue;

      const tx = await client.query(
        `INSERT INTO transactions (company_id, entry_date, description, reference)
         VALUES ($1,$2::date,$3,$4) RETURNING id`,
        [
          req.company.id,
          period_end,
          `Depreciation — ${asset.name}`,
          `FA-DEP-${asset.id.slice(0, 8)}`,
        ]
      );
      const tid = tx.rows[0].id;
      await client.query(
        `INSERT INTO transaction_lines (transaction_id, account_id, debit, credit) VALUES ($1,$2,$3,0)`,
        [tid, asset.depreciation_expense_account_id, amount]
      );
      await client.query(
        `INSERT INTO transaction_lines (transaction_id, account_id, debit, credit) VALUES ($1,$2,0,$3)`,
        [tid, asset.accumulated_depr_account_id, amount]
      );
      await client.query(
        `INSERT INTO fixed_asset_depreciation_entries
         (company_id, asset_id, period_start, period_end, amount, transaction_id)
         VALUES ($1,$2,$3::date,$4::date,$5,$6)`,
        [req.company.id, asset.id, period_start, period_end, amount, tid]
      );
      posted += 1;
    }
    await client.query('COMMIT');
    return res.json({ ok: true, posted_entries: posted });
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.status === 400) return res.status(400).json({ error: e.message });
    console.error(e);
    return res.status(500).json({ error: 'Failed to run depreciation' });
  } finally {
    client.release();
  }
});

router.post('/:id/dispose', async (req, res) => {
  const { disposal_date, disposal_proceeds = 0 } = req.body || {};
  if (!disposal_date) return res.status(400).json({ error: 'disposal_date is required' });
  const client = await pool.connect();
  try {
    await assertDateOpen(req.company.id, disposal_date, client);
    await client.query('BEGIN');
    const assetRes = await client.query(
      `SELECT * FROM fixed_assets WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [req.params.id, req.company.id]
    );
    if (!assetRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Fixed asset not found' });
    }
    const asset = assetRes.rows[0];
    if (asset.is_disposed) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Asset already disposed' });
    }
    const accDep = await accumulatedDep(req.company.id, asset.id, client);
    const book = round2(Number(asset.acquisition_cost) - accDep);
    const proceeds = round2(disposal_proceeds);
    const gainLoss = round2(proceeds - book);

    const tx = await client.query(
      `INSERT INTO transactions (company_id, entry_date, description, reference)
       VALUES ($1,$2::date,$3,$4) RETURNING id`,
      [req.company.id, disposal_date, `Fixed asset disposal — ${asset.name}`, `FA-DISP-${asset.id.slice(0, 8)}`]
    );
    const tid = tx.rows[0].id;

    // Reverse accumulated depreciation and remove asset cost.
    if (accDep > 0) {
      await client.query(
        `INSERT INTO transaction_lines (transaction_id, account_id, debit, credit) VALUES ($1,$2,$3,0)`,
        [tid, asset.accumulated_depr_account_id, accDep]
      );
    }
    await client.query(
      `INSERT INTO transaction_lines (transaction_id, account_id, debit, credit) VALUES ($1,$2,0,$3)`,
      [tid, asset.asset_account_id, round2(asset.acquisition_cost)]
    );
    // Cash proceeds and gain/loss use default revenue/expense accounts.
    const cashAcc = await client.query(
      `SELECT id FROM accounts WHERE company_id = $1 AND code = '1000' AND is_active = TRUE LIMIT 1`,
      [req.company.id]
    );
    const revAcc = await client.query(
      `SELECT id FROM accounts WHERE company_id = $1 AND code = '4000' AND is_active = TRUE LIMIT 1`,
      [req.company.id]
    );
    const expAcc = await client.query(
      `SELECT id FROM accounts WHERE company_id = $1 AND code = '5000' AND is_active = TRUE LIMIT 1`,
      [req.company.id]
    );
    if (proceeds > 0 && cashAcc.rows[0]?.id) {
      await client.query(
        `INSERT INTO transaction_lines (transaction_id, account_id, debit, credit) VALUES ($1,$2,$3,0)`,
        [tid, cashAcc.rows[0].id, proceeds]
      );
    }
    if (gainLoss > 0 && revAcc.rows[0]?.id) {
      await client.query(
        `INSERT INTO transaction_lines (transaction_id, account_id, debit, credit) VALUES ($1,$2,0,$3)`,
        [tid, revAcc.rows[0].id, gainLoss]
      );
    } else if (gainLoss < 0 && expAcc.rows[0]?.id) {
      await client.query(
        `INSERT INTO transaction_lines (transaction_id, account_id, debit, credit) VALUES ($1,$2,$3,0)`,
        [tid, expAcc.rows[0].id, Math.abs(gainLoss)]
      );
    }

    await client.query(
      `UPDATE fixed_assets
       SET is_disposed = TRUE,
           disposal_date = $1::date,
           disposal_proceeds = $2,
           disposal_transaction_id = $3,
           updated_at = NOW()
       WHERE id = $4 AND company_id = $5`,
      [disposal_date, proceeds, tid, asset.id, req.company.id]
    );
    const out = await client.query(`SELECT * FROM fixed_assets WHERE id = $1 AND company_id = $2`, [
      asset.id,
      req.company.id,
    ]);
    await client.query('COMMIT');
    return res.json({ asset: out.rows[0], book_value: book, gain_or_loss: gainLoss });
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.status === 400) return res.status(400).json({ error: e.message });
    console.error(e);
    return res.status(500).json({ error: 'Failed to dispose fixed asset' });
  } finally {
    client.release();
  }
});

export default router;

