import { Router } from 'express';
import { pool } from '../db.js';
import { authRequired } from '../middleware/auth.js';
import { companyContext } from '../middleware/companyContext.js';
import { postInvoicePayment, postInvoiceSale } from '../utils/invoicePosting.js';
import { invoicesHaveGlColumns, invoicesHavePayerColumns } from '../utils/invoiceSchema.js';
import { invoiceBalanceRemaining, round2, statusFromPaidTotal } from '../accounting/invoiceBalances.js';

const router = Router();
router.use(authRequired, companyContext);

const STATUSES = new Set(['draft', 'unpaid', 'partially_paid', 'paid']);
const STATUSES_CREATE = new Set(['draft', 'unpaid', 'paid']);
const PAYER_TYPES = new Set(['customer', 'patient', 'insurance']);

const SELECT_BASE = `id, company_id, customer_name, amount, status::text, invoice_date, created_at`;
const SELECT_FULL = `${SELECT_BASE}, sale_transaction_id, payment_transaction_id`;

/** Payer columns (002) plus optional GL link columns (001) — avoids 42703 if 002 ran without 001. */
function invoiceSelectColumns(gl, payer) {
  if (payer) {
    const glCols = gl ? ', sale_transaction_id, payment_transaction_id' : '';
    return `${SELECT_BASE}, total_amount, paid_amount, payer_type::text, payer_id${glCols}`;
  }
  if (gl) return SELECT_FULL;
  return SELECT_BASE;
}

function migrationHint() {
  return (
    'Run: psql $DATABASE_URL -f database/migrations/001_invoice_gl_postings.sql ' +
    'and database/migrations/002_payments_invoice_payer.sql'
  );
}

function enrichInvoice(row, hasPayer) {
  if (!hasPayer || row.total_amount === undefined) {
    const total = Number(row.amount);
    return { ...row, balance_remaining: round2(total) };
  }
  const total = Number(row.total_amount);
  const paid = Number(row.paid_amount ?? 0);
  return {
    ...row,
    balance_remaining: invoiceBalanceRemaining(total, paid),
  };
}

async function invoiceHasAllocations(client, companyId, invoiceId) {
  const r = await client.query(
    `SELECT 1 FROM payment_allocations WHERE invoice_id = $1 AND company_id = $2 LIMIT 1`,
    [invoiceId, companyId]
  );
  return r.rows.length > 0;
}

router.get('/', async (req, res) => {
  try {
    const gl = await invoicesHaveGlColumns();
    const payer = await invoicesHavePayerColumns();
    const cols = invoiceSelectColumns(gl, payer);
    const r = await pool.query(
      `SELECT ${cols}
       FROM invoices
       WHERE company_id = $1
       ORDER BY invoice_date DESC, created_at DESC`,
      [req.company.id]
    );
    const rows = r.rows.map((row) => {
      let x = row;
      if (!gl) {
        x = { ...row, sale_transaction_id: null, payment_transaction_id: null };
      }
      return enrichInvoice(x, payer);
    });
    return res.json({ invoices: rows });
  } catch (e) {
    console.error(e);
    if (e.code === '42703') {
      return res.status(500).json({
        error: 'Invoices table is missing columns.',
        detail: e.message,
        hint: migrationHint(),
      });
    }
    return res.status(500).json({ error: 'Failed to list invoices' });
  }
});

router.post('/', async (req, res) => {
  const {
    customer_name,
    amount,
    total_amount,
    status,
    invoice_date,
    payer_type,
    payer_id,
  } = req.body || {};
  if (!customer_name || (amount === undefined && total_amount === undefined) || !invoice_date) {
    return res.status(400).json({
      error: 'customer_name, amount (or total_amount), and invoice_date are required',
    });
  }
  const stRaw = status && STATUSES_CREATE.has(status) ? status : 'unpaid';
  if (status && !STATUSES_CREATE.has(status)) {
    return res.status(400).json({ error: 'Invalid status for create (use draft, unpaid, or paid)' });
  }
  const amt = round2(Number(amount !== undefined ? amount : total_amount));
  if (amt < 0) return res.status(400).json({ error: 'Invalid amount' });

  const gl = await invoicesHaveGlColumns();
  const payer = await invoicesHavePayerColumns();
  const retCols = invoiceSelectColumns(gl, payer);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let inv;
    if (payer) {
      const pt = payer_type && PAYER_TYPES.has(payer_type) ? payer_type : 'customer';
      const pid =
        payer_id !== undefined && payer_id !== null && String(payer_id).trim() !== ''
          ? parseInt(String(payer_id), 10)
          : null;
      if (pid !== null && Number.isNaN(pid)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Invalid payer_id' });
      }
      const paidInit = stRaw === 'paid' ? amt : 0;
      const ins = await client.query(
        `INSERT INTO invoices (
           company_id, customer_name, total_amount, paid_amount, status, invoice_date,
           payer_type, payer_id
         )
         VALUES ($1, $2, $3, $4, $5::invoice_status, $6, $7::invoice_payer_type, $8)
         RETURNING ${retCols}`,
        [
          req.company.id,
          String(customer_name).trim(),
          amt,
          paidInit,
          stRaw,
          invoice_date,
          pt,
          pid,
        ]
      );
      inv = ins.rows[0];
    } else {
      const ins = await client.query(
        `INSERT INTO invoices (company_id, customer_name, amount, status, invoice_date)
         VALUES ($1, $2, $3, $4::invoice_status, $5)
         RETURNING ${retCols}`,
        [req.company.id, String(customer_name).trim(), amt, stRaw, invoice_date]
      );
      inv = ins.rows[0];
    }

    if (!gl && (stRaw !== 'draft' || stRaw === 'paid')) {
      await client.query('COMMIT');
      return res.status(201).json({
        invoice: {
          ...inv,
          sale_transaction_id: null,
          payment_transaction_id: null,
          balance_remaining: payer ? invoiceBalanceRemaining(amt, inv.paid_amount ?? 0) : amt,
        },
        warning:
          'Invoice GL columns not installed; journal automation skipped. ' + migrationHint(),
      });
    }

    if (gl) {
      const postSale = stRaw !== 'draft' && amt > 0;
      if (postSale) {
        await postInvoiceSale(client, {
          companyId: req.company.id,
          invoiceId: inv.id,
          amount: amt,
          entryDate: invoice_date,
          customerName: inv.customer_name,
        });
      }
      if (stRaw === 'paid' && amt > 0) {
        await postInvoicePayment(client, {
          companyId: req.company.id,
          invoiceId: inv.id,
          amount: amt,
          entryDate: invoice_date,
          customerName: inv.customer_name,
        });
      }
      const out = await client.query(
        `SELECT ${retCols} FROM invoices WHERE id = $1 AND company_id = $2`,
        [inv.id, req.company.id]
      );
      inv = out.rows[0];
    }

    await client.query('COMMIT');
    return res.status(201).json({
      invoice: enrichInvoice(inv, payer),
    });
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.status === 400) return res.status(400).json({ error: e.message });
    console.error(e);
    if (e.code === '42703') {
      return res.status(500).json({
        error: 'Database schema mismatch.',
        hint: migrationHint(),
      });
    }
    return res.status(500).json({ error: 'Failed to create invoice' });
  } finally {
    client.release();
  }
});

router.patch('/:id', async (req, res) => {
  const {
    customer_name,
    amount,
    total_amount,
    status,
    invoice_date,
    payer_type,
    payer_id,
  } = req.body || {};
  const gl = await invoicesHaveGlColumns();
  const payer = await invoicesHavePayerColumns();
  const retCols = invoiceSelectColumns(gl, payer);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query(
      `SELECT * FROM invoices WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [req.params.id, req.company.id]
    );
    if (!cur.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Not found' });
    }
    const row = cur.rows[0];

    const nextName = customer_name !== undefined ? String(customer_name).trim() : row.customer_name;
    const nextDate = invoice_date !== undefined ? invoice_date : row.invoice_date;

    let nextTotal = payer
      ? Number(total_amount !== undefined ? total_amount : amount !== undefined ? amount : row.total_amount)
      : Number(amount !== undefined ? amount : row.amount);
    if (nextTotal < 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Invalid amount' });
    }
    nextTotal = round2(nextTotal);

    let nextPaid = payer ? round2(row.paid_amount) : row.status === 'paid' ? round2(Number(row.amount)) : 0;
    let nextStatus = row.status;
    let payerType = row.payer_type;
    let payerId = row.payer_id;

    if (payer) {
      if (payer_type !== undefined) {
        if (!PAYER_TYPES.has(payer_type)) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Invalid payer_type' });
        }
        payerType = payer_type;
      }
      if (payer_id !== undefined) {
        if (payer_id === null || String(payer_id).trim() === '') payerId = null;
        else {
          const n = parseInt(String(payer_id), 10);
          if (Number.isNaN(n)) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Invalid payer_id' });
          }
          payerId = n;
        }
      }
    }

    if (status !== undefined) {
      if (!STATUSES.has(status)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Invalid status' });
      }
      if (status === 'partially_paid') {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Status partially_paid is set automatically from payments' });
      }
      nextStatus = status;
    }

    if (gl) {
      if (row.sale_transaction_id && payer && nextTotal !== round2(Number(row.total_amount))) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: 'Cannot change amount after the invoice is posted to the ledger',
        });
      }
      if (row.sale_transaction_id && !payer && amount !== undefined && nextTotal !== Number(row.amount)) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: 'Cannot change amount after the invoice is posted to the ledger',
        });
      }

      if (row.sale_transaction_id && nextStatus === 'draft' && row.status !== 'draft') {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: 'Cannot set invoice to draft; it is already posted to the ledger',
        });
      }
    }

    if (payer && gl && row.status === 'paid' && nextStatus !== 'paid' && row.payment_transaction_id) {
      const hasAll = await invoiceHasAllocations(client, req.company.id, row.id);
      if (hasAll) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: 'Invoice has payment allocations; adjust via payments or support before changing status',
        });
      }
      await client.query('DELETE FROM transactions WHERE id = $1 AND company_id = $2', [
        row.payment_transaction_id,
        req.company.id,
      ]);
      await client.query(
        `UPDATE invoices SET payment_transaction_id = NULL WHERE id = $1 AND company_id = $2`,
        [row.id, req.company.id]
      );
    }

    if (!payer && gl && row.status === 'paid' && nextStatus !== 'paid' && row.payment_transaction_id) {
      await client.query('DELETE FROM transactions WHERE id = $1 AND company_id = $2', [
        row.payment_transaction_id,
        req.company.id,
      ]);
      await client.query(
        `UPDATE invoices SET payment_transaction_id = NULL WHERE id = $1 AND company_id = $2`,
        [row.id, req.company.id]
      );
    }

    if (payer && nextStatus === 'draft' && row.status !== 'draft') {
      const hasAll = await invoiceHasAllocations(client, req.company.id, row.id);
      if (hasAll) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: 'Clear payment allocations before setting this invoice to draft',
        });
      }
    }

    if (payer && nextStatus === 'unpaid' && row.status !== 'unpaid') {
      const hasAll = await invoiceHasAllocations(client, req.company.id, row.id);
      if (hasAll) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: 'Clear payment allocations before marking this invoice unpaid',
        });
      }
      nextPaid = 0;
    }

    if (payer && nextStatus === 'paid') {
      const remainder = round2(nextTotal - nextPaid);
      if (remainder > 0 && gl) {
        await postInvoicePayment(client, {
          companyId: req.company.id,
          invoiceId: row.id,
          amount: remainder,
          entryDate: nextDate,
          customerName: nextName,
        });
      }
      nextPaid = nextTotal;
    }

    if (payer) {
      if (nextStatus === 'draft') {
        nextPaid = 0;
      } else {
        nextStatus = statusFromPaidTotal(nextTotal, nextPaid);
      }
    }

    if (payer) {
      await client.query(
        `UPDATE invoices
         SET customer_name = $1,
             total_amount = $2,
             paid_amount = $3,
             status = $4::invoice_status,
             invoice_date = $5,
             payer_type = $6::invoice_payer_type,
             payer_id = $7
         WHERE id = $8 AND company_id = $9`,
        [nextName, nextTotal, nextPaid, nextStatus, nextDate, payerType, payerId, req.params.id, req.company.id]
      );
    } else {
      await client.query(
        `UPDATE invoices
         SET customer_name = $1, amount = $2, status = $3::invoice_status, invoice_date = $4
         WHERE id = $5 AND company_id = $6`,
        [nextName, nextTotal, nextStatus, nextDate, req.params.id, req.company.id]
      );
    }

    if (gl) {
      const inv = (
        await client.query(`SELECT * FROM invoices WHERE id = $1 AND company_id = $2`, [
          req.params.id,
          req.company.id,
        ])
      ).rows[0];

      const saleAmount = payer ? Number(inv.total_amount) : Number(inv.amount);
      if (!inv.sale_transaction_id && inv.status !== 'draft' && saleAmount > 0) {
        await postInvoiceSale(client, {
          companyId: req.company.id,
          invoiceId: inv.id,
          amount: saleAmount,
          entryDate: inv.invoice_date,
          customerName: inv.customer_name,
        });
      }

      if (!payer) {
        const inv2 = (
          await client.query(`SELECT * FROM invoices WHERE id = $1 AND company_id = $2`, [
            req.params.id,
            req.company.id,
          ])
        ).rows[0];
        if (inv2.status === 'paid' && Number(inv2.amount) > 0 && !inv2.payment_transaction_id) {
          await postInvoicePayment(client, {
            companyId: req.company.id,
            invoiceId: inv2.id,
            amount: inv2.amount,
            entryDate: inv2.invoice_date,
            customerName: inv2.customer_name,
          });
        }
      }
    }

    const out = await client.query(
      `SELECT ${retCols} FROM invoices WHERE id = $1 AND company_id = $2`,
      [req.params.id, req.company.id]
    );
    await client.query('COMMIT');
    let payload = out.rows[0];
    if (!gl) {
      payload = {
        ...payload,
        sale_transaction_id: null,
        payment_transaction_id: null,
      };
    }
    return res.json({ invoice: enrichInvoice(payload, payer) });
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.status === 400) return res.status(400).json({ error: e.message });
    console.error(e);
    if (e.code === '42703') {
      return res.status(500).json({ error: 'Database schema mismatch.', hint: migrationHint() });
    }
    return res.status(500).json({ error: 'Failed to update invoice' });
  } finally {
    client.release();
  }
});

router.delete('/:id', async (req, res) => {
  const gl = await invoicesHaveGlColumns();

  if (!gl) {
    try {
      const r = await pool.query(
        'DELETE FROM invoices WHERE id = $1 AND company_id = $2 RETURNING id',
        [req.params.id, req.company.id]
      );
      if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
      return res.json({ ok: true });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Failed to delete invoice' });
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query(
      `SELECT sale_transaction_id, payment_transaction_id FROM invoices WHERE id = $1 AND company_id = $2`,
      [req.params.id, req.company.id]
    );
    if (!cur.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Not found' });
    }
    const { payment_transaction_id, sale_transaction_id } = cur.rows[0];
    if (payment_transaction_id) {
      await client.query('DELETE FROM transactions WHERE id = $1 AND company_id = $2', [
        payment_transaction_id,
        req.company.id,
      ]);
    }
    if (sale_transaction_id) {
      await client.query('DELETE FROM transactions WHERE id = $1 AND company_id = $2', [
        sale_transaction_id,
        req.company.id,
      ]);
    }
    const del = await client.query(
      'DELETE FROM invoices WHERE id = $1 AND company_id = $2 RETURNING id',
      [req.params.id, req.company.id]
    );
    await client.query('COMMIT');
    if (!del.rows.length) return res.status(404).json({ error: 'Not found' });
    return res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    return res.status(500).json({ error: 'Failed to delete invoice' });
  } finally {
    client.release();
  }
});

export default router;
