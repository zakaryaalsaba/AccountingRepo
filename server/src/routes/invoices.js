import { Router } from 'express';
import { pool } from '../db.js';
import { authRequired } from '../middleware/auth.js';
import { companyContext } from '../middleware/companyContext.js';
import {
  postInvoiceCreditNote,
  postInvoicePayment,
  postInvoiceRefund,
  postInvoiceSale,
} from '../utils/invoicePosting.js';
import {
  invoiceCreditNotesTableExists,
  invoicesHaveGlColumns,
  invoicesHaveNumberingColumns,
  invoicesHavePayerColumns,
} from '../utils/invoiceSchema.js';
import { invoiceBalanceRemaining, round2, statusFromPaidTotal } from '../accounting/invoiceBalances.js';
import { assertDateOpen } from '../utils/periodLocks.js';

const router = Router();
router.use(authRequired, companyContext);

const STATUSES = new Set(['draft', 'unpaid', 'partially_paid', 'paid']);
const STATUSES_CREATE = new Set(['draft', 'unpaid', 'paid']);
const PAYER_TYPES = new Set(['customer', 'patient', 'insurance']);

const SELECT_BASE = `id, company_id, customer_name, amount, status::text, invoice_date, created_at`;
const SELECT_FULL = `${SELECT_BASE}, sale_transaction_id, payment_transaction_id`;

/** Payer columns (002) plus optional GL link columns (001) — avoids 42703 if 002 ran without 001. */
function invoiceSelectColumns(gl, payer, numbering) {
  const numberingCols = numbering ? ', invoice_number, invoice_template_id' : '';
  if (payer) {
    const glCols = gl ? ', sale_transaction_id, payment_transaction_id' : '';
    return `${SELECT_BASE}${numberingCols}, total_amount, paid_amount, payer_type::text, payer_id${glCols}`;
  }
  if (gl) return `${SELECT_FULL}${numberingCols}`;
  return `${SELECT_BASE}${numberingCols}`;
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

async function assertValidCustomerPayer(client, companyId, payerType, payerId) {
  if (payerType !== 'customer' || payerId === null || payerId === undefined) return;
  const r = await client.query(
    `SELECT id
     FROM customers
     WHERE id = $1 AND company_id = $2 AND is_active = TRUE
     LIMIT 1`,
    [payerId, companyId]
  );
  if (!r.rows.length) {
    const err = new Error('Invalid customer payer_id (customer not found or inactive)');
    err.status = 400;
    throw err;
  }
}

async function assertValidTemplate(client, companyId, templateId) {
  if (!templateId) return;
  const r = await client.query(
    `SELECT id FROM invoice_templates WHERE id = $1 AND company_id = $2 LIMIT 1`,
    [templateId, companyId]
  );
  if (!r.rows.length) {
    const err = new Error('Invalid invoice_template_id');
    err.status = 400;
    throw err;
  }
}

async function nextInvoiceNumber(client, companyId, invoiceDate) {
  const year = String(invoiceDate).slice(0, 4);
  const prefix = `INV-${year}-`;
  const r = await client.query(
    `SELECT invoice_number
     FROM invoices
     WHERE company_id = $1
       AND invoice_number LIKE $2
     ORDER BY invoice_number DESC
     LIMIT 1`,
    [companyId, `${prefix}%`]
  );
  const last = r.rows[0]?.invoice_number || '';
  const n = last ? parseInt(last.slice(prefix.length), 10) + 1 : 1;
  return `${prefix}${String(Number.isNaN(n) ? 1 : n).padStart(6, '0')}`;
}

router.get('/', async (req, res) => {
  try {
    const gl = await invoicesHaveGlColumns();
    const payer = await invoicesHavePayerColumns();
    const numbering = await invoicesHaveNumberingColumns();
    const cols = invoiceSelectColumns(gl, payer, numbering);
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
    invoice_template_id,
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
  const numbering = await invoicesHaveNumberingColumns();
  const retCols = invoiceSelectColumns(gl, payer, numbering);

  const client = await pool.connect();
  try {
    await assertDateOpen(req.company.id, invoice_date, client);
    await client.query('BEGIN');

    const invoiceNumber = numbering ? await nextInvoiceNumber(client, req.company.id, invoice_date) : null;
    const templateId = invoice_template_id ? String(invoice_template_id) : null;
    if (numbering) await assertValidTemplate(client, req.company.id, templateId);

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
      await assertValidCustomerPayer(client, req.company.id, pt, pid);
      const paidInit = stRaw === 'paid' ? amt : 0;
      const sql = numbering
        ? `INSERT INTO invoices (
             company_id, customer_name, invoice_number, invoice_template_id,
             total_amount, paid_amount, status, invoice_date, payer_type, payer_id
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7::invoice_status, $8, $9::invoice_payer_type, $10)
           RETURNING ${retCols}`
        : `INSERT INTO invoices (
             company_id, customer_name, total_amount, paid_amount, status, invoice_date,
             payer_type, payer_id
           )
           VALUES ($1, $2, $3, $4, $5::invoice_status, $6, $7::invoice_payer_type, $8)
           RETURNING ${retCols}`;
      const params = numbering
        ? [
            req.company.id,
            String(customer_name).trim(),
            invoiceNumber,
            templateId,
            amt,
            paidInit,
            stRaw,
            invoice_date,
            pt,
            pid,
          ]
        : [req.company.id, String(customer_name).trim(), amt, paidInit, stRaw, invoice_date, pt, pid];
      const ins = await client.query(sql, params);
      inv = ins.rows[0];
    } else {
      const sql = numbering
        ? `INSERT INTO invoices (
             company_id, customer_name, invoice_number, invoice_template_id, amount, status, invoice_date
           )
           VALUES ($1, $2, $3, $4, $5, $6::invoice_status, $7)
           RETURNING ${retCols}`
        : `INSERT INTO invoices (company_id, customer_name, amount, status, invoice_date)
           VALUES ($1, $2, $3, $4::invoice_status, $5)
           RETURNING ${retCols}`;
      const params = numbering
        ? [req.company.id, String(customer_name).trim(), invoiceNumber, templateId, amt, stRaw, invoice_date]
        : [req.company.id, String(customer_name).trim(), amt, stRaw, invoice_date];
      const ins = await client.query(sql, params);
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
    invoice_template_id,
    payer_type,
    payer_id,
  } = req.body || {};
  const gl = await invoicesHaveGlColumns();
  const payer = await invoicesHavePayerColumns();
  const numbering = await invoicesHaveNumberingColumns();
  const retCols = invoiceSelectColumns(gl, payer, numbering);

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
    await assertDateOpen(req.company.id, row.invoice_date, client);
    await assertDateOpen(req.company.id, nextDate, client);

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
    const nextTemplateId =
      numbering && invoice_template_id !== undefined
        ? invoice_template_id
          ? String(invoice_template_id)
          : null
        : row.invoice_template_id;
    if (numbering) await assertValidTemplate(client, req.company.id, nextTemplateId);

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
      await assertValidCustomerPayer(client, req.company.id, payerType, payerId);
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
             payer_id = $7,
             invoice_template_id = $8
         WHERE id = $9 AND company_id = $10`,
        [
          nextName,
          nextTotal,
          nextPaid,
          nextStatus,
          nextDate,
          payerType,
          payerId,
          nextTemplateId,
          req.params.id,
          req.company.id,
        ]
      );
    } else {
      if (numbering) {
        await client.query(
          `UPDATE invoices
           SET customer_name = $1,
               amount = $2,
               status = $3::invoice_status,
               invoice_date = $4,
               invoice_template_id = $5
           WHERE id = $6 AND company_id = $7`,
          [nextName, nextTotal, nextStatus, nextDate, nextTemplateId, req.params.id, req.company.id]
        );
      } else {
        await client.query(
          `UPDATE invoices
           SET customer_name = $1, amount = $2, status = $3::invoice_status, invoice_date = $4
           WHERE id = $5 AND company_id = $6`,
          [nextName, nextTotal, nextStatus, nextDate, req.params.id, req.company.id]
        );
      }
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

router.get('/:id/credit-notes', async (req, res) => {
  try {
    if (!(await invoiceCreditNotesTableExists())) {
      return res.status(503).json({
        error: 'Credit notes schema not installed.',
        hint: 'Run: psql $DATABASE_URL -f database/migrations/008_invoice_credit_notes.sql',
      });
    }
    const inv = await pool.query(`SELECT id FROM invoices WHERE id = $1 AND company_id = $2`, [
      req.params.id,
      req.company.id,
    ]);
    if (!inv.rows.length) return res.status(404).json({ error: 'Invoice not found' });
    const r = await pool.query(
      `SELECT *
       FROM invoice_credit_notes
       WHERE company_id = $1 AND invoice_id = $2
       ORDER BY credit_date DESC, created_at DESC`,
      [req.company.id, req.params.id]
    );
    return res.json({ credit_notes: r.rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to list credit notes' });
  }
});

router.post('/:id/credit-notes', async (req, res) => {
  if (!(await invoiceCreditNotesTableExists())) {
    return res.status(503).json({
      error: 'Credit notes schema not installed.',
      hint: 'Run: psql $DATABASE_URL -f database/migrations/008_invoice_credit_notes.sql',
    });
  }
  const { amount, credit_date, reason, is_refund = false } = req.body || {};
  const amt = round2(Number(amount));
  if (!credit_date || !amt || amt <= 0) {
    return res.status(400).json({ error: 'credit_date and positive amount are required' });
  }

  const payer = await invoicesHavePayerColumns();
  if (!payer) {
    return res.status(503).json({
      error: 'Credit notes require payer schema.',
      hint: 'Run: psql $DATABASE_URL -f database/migrations/002_payments_invoice_payer.sql',
    });
  }

  const client = await pool.connect();
  try {
    await assertDateOpen(req.company.id, credit_date, client);
    await client.query('BEGIN');
    const invRes = await client.query(
      `SELECT * FROM invoices WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [req.params.id, req.company.id]
    );
    if (!invRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Invoice not found' });
    }
    const inv = invRes.rows[0];
    if (inv.status === 'draft') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Cannot credit a draft invoice' });
    }

    const total = round2(inv.total_amount);
    const paid = round2(inv.paid_amount);
    const open = round2(total - paid);

    if (!is_refund && amt > open + 0.0001) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Credit amount exceeds outstanding balance' });
    }
    if (is_refund && amt > paid + 0.0001) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Refund credit amount exceeds paid amount' });
    }

    const newTotal = round2(total - amt);
    const newPaid = is_refund ? round2(paid - amt) : paid;
    if (newTotal < 0 || newPaid < 0 || newPaid > newTotal + 0.0001) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'Credit note would result in invalid invoice balances',
      });
    }
    const nextStatus = statusFromPaidTotal(newTotal, newPaid);

    const gl = await invoicesHaveGlColumns();
    let creditTxId = null;
    let refundTxId = null;
    if (gl) {
      creditTxId = await postInvoiceCreditNote(client, {
        companyId: req.company.id,
        invoiceId: inv.id,
        amount: amt,
        entryDate: credit_date,
        customerName: inv.customer_name,
      });
      if (is_refund) {
        refundTxId = await postInvoiceRefund(client, {
          companyId: req.company.id,
          invoiceId: inv.id,
          amount: amt,
          entryDate: credit_date,
          customerName: inv.customer_name,
        });
      }
    }

    await client.query(
      `UPDATE invoices
       SET total_amount = $1,
           amount = $1,
           paid_amount = $2,
           status = $3::invoice_status
       WHERE id = $4 AND company_id = $5`,
      [newTotal, newPaid, nextStatus, inv.id, req.company.id]
    );
    const cn = await client.query(
      `INSERT INTO invoice_credit_notes (
         company_id, invoice_id, credit_date, amount, reason, is_refund,
         credit_transaction_id, refund_transaction_id, created_by
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        req.company.id,
        inv.id,
        credit_date,
        amt,
        reason ? String(reason) : null,
        Boolean(is_refund),
        creditTxId,
        refundTxId,
        req.user.id,
      ]
    );
    const numbering = await invoicesHaveNumberingColumns();
    const outInv = await client.query(
      `SELECT ${invoiceSelectColumns(gl, true, numbering)}
       FROM invoices WHERE id = $1 AND company_id = $2`,
      [inv.id, req.company.id]
    );
    await client.query('COMMIT');
    return res.status(201).json({
      credit_note: cn.rows[0],
      invoice: enrichInvoice(outInv.rows[0], true),
    });
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.status === 400) return res.status(400).json({ error: e.message });
    console.error(e);
    return res.status(500).json({ error: 'Failed to create credit note' });
  } finally {
    client.release();
  }
});

router.delete('/:id', async (req, res) => {
  const gl = await invoicesHaveGlColumns();

  if (!gl) {
    try {
      const cur = await pool.query(
        'SELECT invoice_date FROM invoices WHERE id = $1 AND company_id = $2',
        [req.params.id, req.company.id]
      );
      if (!cur.rows.length) return res.status(404).json({ error: 'Not found' });
      await assertDateOpen(req.company.id, cur.rows[0].invoice_date);

      const r = await pool.query(
        'DELETE FROM invoices WHERE id = $1 AND company_id = $2 RETURNING id',
        [req.params.id, req.company.id]
      );
      return res.json({ ok: true });
    } catch (e) {
      if (e.status === 400) return res.status(400).json({ error: e.message });
      console.error(e);
      return res.status(500).json({ error: 'Failed to delete invoice' });
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query(
      `SELECT invoice_date, sale_transaction_id, payment_transaction_id
       FROM invoices WHERE id = $1 AND company_id = $2`,
      [req.params.id, req.company.id]
    );
    if (!cur.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Not found' });
    }
    const { invoice_date, payment_transaction_id, sale_transaction_id } = cur.rows[0];
    await assertDateOpen(req.company.id, invoice_date, client);
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
