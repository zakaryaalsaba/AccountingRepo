import { Router } from 'express';
import { pool, query } from '../db.js';
import { authRequired } from '../middleware/auth.js';
import { companyContext } from '../middleware/companyContext.js';
import { attachAuthorization, requirePermission } from '../middleware/authorization.js';
import { assertDateOpen } from '../utils/periodLocks.js';
import { assertFiscalYearOpen } from '../utils/fiscalSchema.js';
import { writeAuditEvent } from '../utils/auditLog.js';
import {
  voucherBranchServiceSchemaHint,
  voucherSchemaHint,
  voucherTablesExist,
  vouchersHaveBranchServiceColumns,
} from '../utils/voucherSchema.js';

const router = Router();
router.use(authRequired, companyContext);
router.use(attachAuthorization);

function r2(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}

async function getFxAccounts(companyId, client) {
  const gain = await client.query(
    `SELECT id FROM accounts
     WHERE company_id = $1 AND (account_code = '4100' OR code = '4100') AND is_active = TRUE
     LIMIT 1`,
    [companyId]
  );
  const loss = await client.query(
    `SELECT id FROM accounts
     WHERE company_id = $1 AND (account_code = '5101' OR code = '5101') AND is_active = TRUE
     LIMIT 1`,
    [companyId]
  );
  return {
    gainAccountId: gain.rows[0]?.id || null,
    lossAccountId: loss.rows[0]?.id || null,
  };
}

async function getBaseCurrency(companyId, client) {
  const r = await client.query(
    `SELECT currency_code
     FROM company_currencies
     WHERE company_id = $1 AND is_base = TRUE
     ORDER BY created_at ASC
     LIMIT 1`,
    [companyId]
  );
  return r.rows[0]?.currency_code || null;
}

async function createTransaction(client, companyId, entryDate, description, reference, lines) {
  const tx = await client.query(
    `INSERT INTO transactions (company_id, entry_date, description, reference, status, posted_by, posted_at)
     VALUES ($1,$2,$3,$4,'posted',$5,NOW())
     RETURNING *`,
    [companyId, entryDate, description || null, reference || null, null]
  );
  for (const ln of lines) {
    await client.query(
      `INSERT INTO transaction_lines (transaction_id, account_id, debit, credit)
       VALUES ($1,$2,$3,$4)`,
      [tx.rows[0].id, ln.account_id, r2(ln.debit), r2(ln.credit)]
    );
  }
  return tx.rows[0];
}

router.use(async (_req, res, next) => {
  if (await voucherTablesExist()) return next();
  return res.status(503).json({ error: 'Voucher schema not installed.', hint: voucherSchemaHint() });
});

router.get('/', async (req, res) => {
  try {
    const { family } = req.query;
    const params = [req.company.id];
    let sql = `SELECT * FROM vouchers WHERE company_id = $1`;
    if (family) {
      params.push(String(family));
      sql += ` AND family = $2::voucher_family`;
    }
    sql += ` ORDER BY entry_date DESC, created_at DESC`;
    const r = await query(sql, params);
    return res.json({ vouchers: r.rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to list vouchers' });
  }
});

router.post('/', async (req, res) => {
  return requirePermission('transactions.create')(req, res, async () => {
    const {
      family,
      entry_date,
      amount,
      source_account_id,
      destination_account_id,
      reference,
      description,
      currency_code = null,
      exchange_rate = null,
      settlement_base_amount = null,
      receipt_allocations = [],
      receipt_customer_balances = [],
      bill_allocations = [],
      vendor_prepayments = [],
      bill_credit_allocations = [],
      branch_id = null,
      service_card_id = null,
      project_id = null,
    } = req.body || {};
    if (!family || !['receipt', 'payment', 'transfer', 'adjustment'].includes(String(family))) {
      return res.status(400).json({ error: 'family must be receipt/payment/transfer/adjustment' });
    }
    if (!entry_date) return res.status(400).json({ error: 'entry_date is required' });
    const amt = r2(amount);
    if (amt <= 0) return res.status(400).json({ error: 'amount must be positive' });
    if (!source_account_id || !destination_account_id) {
      return res.status(400).json({ error: 'source_account_id and destination_account_id are required' });
    }
    const client = await pool.connect();
    try {
      await assertDateOpen(req.company.id, entry_date, client);
      await assertFiscalYearOpen(req.company.id, entry_date, client);
      await client.query('BEGIN');
      const hasBranchServiceCols = await vouchersHaveBranchServiceColumns();
      if ((branch_id || service_card_id || project_id) && !hasBranchServiceCols) {
        await client.query('ROLLBACK');
        return res.status(503).json({
          error: 'Voucher branch/service schema not installed.',
          hint: voucherBranchServiceSchemaHint(),
        });
      }
      const src = await client.query(
        `SELECT id, type::text AS type FROM accounts WHERE id = $1 AND company_id = $2 AND is_active = TRUE`,
        [source_account_id, req.company.id]
      );
      const dst = await client.query(
        `SELECT id, type::text AS type FROM accounts WHERE id = $1 AND company_id = $2 AND is_active = TRUE`,
        [destination_account_id, req.company.id]
      );
      if (!src.rows.length || !dst.rows.length) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Invalid source/destination accounts' });
      }
      if (family === 'transfer') {
        if (src.rows[0].type !== 'ASSET' || dst.rows[0].type !== 'ASSET') {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Transfer vouchers require ASSET to ASSET accounts' });
        }
      }

      const baseCurrency = await getBaseCurrency(req.company.id, client);
      let effectiveAmount = amt;
      const isForeign = currency_code && baseCurrency && String(currency_code).toUpperCase() !== String(baseCurrency).toUpperCase();
      if (isForeign) {
        if (!exchange_rate || Number(exchange_rate) <= 0) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'exchange_rate is required for foreign-currency vouchers' });
        }
        effectiveAmount = r2(amt * Number(exchange_rate));
      }

      const lines = [
        { account_id: destination_account_id, debit: effectiveAmount, credit: 0 },
        { account_id: source_account_id, debit: 0, credit: effectiveAmount },
      ];

      // Optional realized FX line based on settlement base amount.
      if (isForeign && settlement_base_amount !== null && settlement_base_amount !== undefined) {
        const settle = r2(settlement_base_amount);
        const diff = r2(settle - effectiveAmount);
        if (Math.abs(diff) >= 0.01) {
          const fx = await getFxAccounts(req.company.id, client);
          const fxAcc = diff > 0 ? fx.gainAccountId : fx.lossAccountId;
          if (fxAcc) {
            if (diff > 0) {
              lines.push({ account_id: fxAcc, debit: 0, credit: Math.abs(diff) });
              lines[0].debit = r2(lines[0].debit + Math.abs(diff));
            } else {
              lines.push({ account_id: fxAcc, debit: Math.abs(diff), credit: 0 });
              lines[1].credit = r2(lines[1].credit + Math.abs(diff));
            }
          }
        }
      }

      const tx = await createTransaction(
        client,
        req.company.id,
        entry_date,
        description || `${family} voucher`,
        reference || null,
        lines
      );

      const v = await client.query(
        `INSERT INTO vouchers (
           company_id, family, entry_date, amount, currency_code, exchange_rate, settlement_base_amount,
           source_account_id, destination_account_id, reference, description, status, transaction_id, created_by,
           branch_id, service_card_id, project_id
         )
         VALUES ($1,$2::voucher_family,$3,$4,$5,$6,$7,$8,$9,$10,$11,'posted',$12,$13,$14,$15,$16)
         RETURNING *`,
        [
          req.company.id,
          family,
          entry_date,
          amt,
          currency_code ? String(currency_code).toUpperCase() : null,
          exchange_rate ? Number(exchange_rate) : null,
          settlement_base_amount ? Number(settlement_base_amount) : null,
          source_account_id,
          destination_account_id,
          reference || null,
          description || null,
          tx.id,
          req.user.id,
          branch_id,
          service_card_id,
          project_id,
        ]
      );
      const voucher = v.rows[0];

      if (family === 'receipt') {
        for (const a of receipt_allocations || []) {
          const x = r2(a.amount);
          if (!a.invoice_id || x <= 0) continue;
          const inv = await client.query(
            `SELECT id, total_amount, paid_amount, status
             FROM invoices
             WHERE id = $1 AND company_id = $2
             FOR UPDATE`,
            [a.invoice_id, req.company.id]
          );
          if (!inv.rows.length) continue;
          const remaining = r2(inv.rows[0].total_amount - inv.rows[0].paid_amount);
          const applied = Math.min(x, remaining);
          if (applied <= 0) continue;
          await client.query(
            `INSERT INTO receipt_invoice_allocations (company_id, voucher_id, invoice_id, amount)
             VALUES ($1,$2,$3,$4)`,
            [req.company.id, voucher.id, a.invoice_id, applied]
          );
          const newPaid = r2(inv.rows[0].paid_amount + applied);
          const newStatus = newPaid <= 0 ? 'unpaid' : (newPaid >= inv.rows[0].total_amount ? 'paid' : 'partially_paid');
          await client.query(
            `UPDATE invoices SET paid_amount = $1, status = $2::invoice_status WHERE id = $3 AND company_id = $4`,
            [newPaid, newStatus, a.invoice_id, req.company.id]
          );
        }
        for (const b of receipt_customer_balances || []) {
          const x = r2(b.amount);
          if (!b.customer_name || x <= 0) continue;
          await client.query(
            `INSERT INTO receipt_customer_balances (company_id, voucher_id, customer_name, balance_type, amount)
             VALUES ($1,$2,$3,$4,$5)`,
            [req.company.id, voucher.id, String(b.customer_name), String(b.balance_type || 'on_account'), x]
          );
        }
      }

      if (family === 'payment') {
        for (const a of bill_allocations || []) {
          const x = r2(a.amount);
          if (!a.bill_id || x <= 0) continue;
          const b = await client.query(
            `SELECT id, total_amount, paid_amount
             FROM bills
             WHERE id = $1 AND company_id = $2
             FOR UPDATE`,
            [a.bill_id, req.company.id]
          );
          if (!b.rows.length) continue;
          const rem = r2(b.rows[0].total_amount - b.rows[0].paid_amount);
          const applied = Math.min(x, rem);
          if (applied <= 0) continue;
          await client.query(
            `INSERT INTO payment_bill_allocations (company_id, voucher_id, bill_id, amount)
             VALUES ($1,$2,$3,$4)`,
            [req.company.id, voucher.id, a.bill_id, applied]
          );
          const newPaid = r2(b.rows[0].paid_amount + applied);
          const newStatus = newPaid <= 0 ? 'unpaid' : (newPaid >= b.rows[0].total_amount ? 'paid' : 'partially_paid');
          await client.query(
            `UPDATE bills SET paid_amount = $1, status = $2::bill_status WHERE id = $3 AND company_id = $4`,
            [newPaid, newStatus, a.bill_id, req.company.id]
          );
        }
        for (const p of vendor_prepayments || []) {
          const x = r2(p.amount);
          if (!p.vendor_id || x <= 0) continue;
          await client.query(
            `INSERT INTO vendor_prepayments (company_id, voucher_id, vendor_id, amount)
             VALUES ($1,$2,$3,$4)`,
            [req.company.id, voucher.id, p.vendor_id, x]
          );
        }
        for (const c of bill_credit_allocations || []) {
          const x = r2(c.amount);
          if (!c.bill_credit_id || x <= 0) continue;
          await client.query(
            `INSERT INTO payment_bill_credit_allocations (company_id, voucher_id, bill_credit_id, amount)
             VALUES ($1,$2,$3,$4)`,
            [req.company.id, voucher.id, c.bill_credit_id, x]
          );
        }
      }

      await client.query('COMMIT');
      await writeAuditEvent({
        companyId: req.company.id,
        actorUserId: req.user.id,
        eventType: 'voucher.created',
        entityType: 'voucher',
        entityId: voucher.id,
        details: { family: voucher.family, status: voucher.status, amount: voucher.amount },
      });
      return res.status(201).json({ voucher });
    } catch (e) {
      await client.query('ROLLBACK');
      if (e.status === 400) return res.status(400).json({ error: e.message });
      console.error(e);
      return res.status(500).json({ error: 'Failed to create voucher' });
    } finally {
      client.release();
    }
  });
});

router.get('/:id/print-layout', async (req, res) => {
  try {
    const { lang = 'ar', watermark = null } = req.query;
    const r = await query(
      `SELECT * FROM vouchers WHERE id = $1 AND company_id = $2`,
      [req.params.id, req.company.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Voucher not found' });
    const v = r.rows[0];
    const labels = {
      ar: {
        title: {
          receipt: 'سند قبض',
          payment: 'سند صرف',
          transfer: 'سند تحويل',
          adjustment: 'سند تسوية',
        },
        date: 'التاريخ',
        amount: 'المبلغ',
        ref: 'المرجع',
      },
      en: {
        title: {
          receipt: 'Receipt Voucher',
          payment: 'Payment Voucher',
          transfer: 'Transfer Voucher',
          adjustment: 'Adjustment Voucher',
        },
        date: 'Date',
        amount: 'Amount',
        ref: 'Reference',
      },
    };
    const l = labels[String(lang).toLowerCase()] || labels.en;
    const normalizedStatus = String(v.status || '').toLowerCase();
    const defaultWatermark =
      normalizedStatus === 'draft'
        ? String(lang).toLowerCase() === 'ar'
          ? 'مسودة'
          : 'DRAFT'
        : normalizedStatus === 'cancelled'
          ? String(lang).toLowerCase() === 'ar'
            ? 'ملغي'
            : 'CANCELLED'
          : normalizedStatus === 'reversed'
            ? String(lang).toLowerCase() === 'ar'
              ? 'معكوس'
              : 'REVERSED'
            : null;
    const wm = watermark || defaultWatermark;
    const html = `<!doctype html>
<html lang="${lang}" dir="${String(lang).toLowerCase() === 'ar' ? 'rtl' : 'ltr'}">
<head><meta charset="utf-8"><title>${l.title[v.family]}</title>
<style>
  .watermark{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;font-size:78px;color:rgba(120,120,120,0.16);transform:rotate(-22deg);pointer-events:none;z-index:1}
</style>
</head>
<body style="font-family: sans-serif; padding: 24px; position: relative">
  ${wm ? `<div class="watermark">${String(wm)}</div>` : ''}
  <h2>${l.title[v.family]}</h2>
  <p><strong>${l.date}:</strong> ${v.entry_date}</p>
  <p><strong>${l.amount}:</strong> ${v.amount}</p>
  <p><strong>${l.ref}:</strong> ${v.reference || '-'}</p>
  <hr />
  <p>${v.description || ''}</p>
</body>
</html>`;
    await writeAuditEvent({
      companyId: req.company.id,
      actorUserId: req.user.id,
      eventType: 'voucher.printed',
      entityType: 'voucher',
      entityId: req.params.id,
      details: { lang: String(lang), watermark: wm || null },
    });
    return res.json({ voucher: v, html });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to render print layout' });
  }
});

export default router;
