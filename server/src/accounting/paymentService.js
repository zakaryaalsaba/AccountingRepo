import { pool } from '../db.js';
import { postCashReceiptAgainstAr } from '../utils/invoicePosting.js';
import { invoicesHaveGlColumns } from '../utils/invoiceSchema.js';
import { invoiceBalanceRemaining, nextInvoiceStatus, round2 } from './invoiceBalances.js';

export const PAYMENT_METHODS = new Set(['cash', 'card', 'bank_transfer', 'insurance']);

function paymentDateToEntryDate(paymentDate) {
  const d = paymentDate ? new Date(paymentDate) : new Date();
  if (Number.isNaN(d.getTime())) throw Object.assign(new Error('Invalid payment_date'), { status: 400 });
  return d.toISOString().slice(0, 10);
}

/**
 * Create payment, post Dr Cash / Cr AR for the full amount (ledger reflects cash in).
 * Allocations are applied separately and only update invoice sub-ledgers.
 */
export async function createPayment(companyId, body) {
  const { amount, payment_date, method, reference, notes } = body || {};
  const amt = round2(amount);
  if (amt <= 0) throw Object.assign(new Error('amount must be positive'), { status: 400 });
  if (!method || !PAYMENT_METHODS.has(method)) {
    throw Object.assign(new Error('method must be cash, card, bank_transfer, or insurance'), {
      status: 400,
    });
  }

  const entryDate = paymentDateToEntryDate(payment_date);
  const gl = await invoicesHaveGlColumns();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ins = await client.query(
      `INSERT INTO payments (company_id, amount, payment_date, method, reference, notes)
       VALUES ($1, $2, $3::timestamptz, $4::payment_method, $5, $6)
       RETURNING *`,
      [
        companyId,
        amt,
        payment_date || new Date().toISOString(),
        method,
        reference != null ? String(reference).slice(0, 255) : null,
        notes != null ? String(notes) : null,
      ]
    );
    const payment = ins.rows[0];
    let receiptTxId = null;
    if (gl) {
      receiptTxId = await postCashReceiptAgainstAr(client, {
        companyId,
        amount: amt,
        entryDate,
        description: `Payment (${method})${reference ? ` — ${String(reference).slice(0, 120)}` : ''}`,
        reference: `PAY-${String(payment.id).replace(/-/g, '').slice(0, 12)}`,
      });
      await client.query(
        `UPDATE payments SET receipt_transaction_id = $1 WHERE id = $2 AND company_id = $3`,
        [receiptTxId, payment.id, companyId]
      );
      payment.receipt_transaction_id = receiptTxId;
    }
    await client.query('COMMIT');
    return payment;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function listPayments(companyId) {
  const r = await pool.query(
    `SELECT p.*,
            COALESCE(
              (SELECT SUM(pa.amount_applied)
               FROM payment_allocations pa
               WHERE pa.payment_id = p.id AND pa.company_id = p.company_id),
              0
            )::numeric AS allocated_amount
     FROM payments p
     WHERE p.company_id = $1
     ORDER BY p.payment_date DESC, p.created_at DESC`,
    [companyId]
  );
  return r.rows.map((row) => ({
    ...row,
    allocated_amount: round2(row.allocated_amount),
    unallocated_amount: round2(round2(row.amount) - round2(row.allocated_amount)),
  }));
}

export async function getPaymentById(companyId, paymentId) {
  const p = await pool.query(`SELECT * FROM payments WHERE id = $1 AND company_id = $2`, [
    paymentId,
    companyId,
  ]);
  if (!p.rows.length) return null;
  const payment = p.rows[0];
  const alloc = await pool.query(
    `SELECT pa.*, i.customer_name, i.total_amount AS invoice_total, i.paid_amount AS invoice_paid_before_line,
            i.status::text AS invoice_status
     FROM payment_allocations pa
     JOIN invoices i ON i.id = pa.invoice_id AND i.company_id = pa.company_id
     WHERE pa.payment_id = $1 AND pa.company_id = $2
     ORDER BY pa.created_at ASC`,
    [paymentId, companyId]
  );
  const allocated = alloc.rows.reduce((s, a) => s + round2(a.amount_applied), 0);
  return {
    ...payment,
    allocations: alloc.rows,
    allocated_amount: round2(allocated),
    unallocated_amount: round2(round2(payment.amount) - allocated),
  };
}

/**
 * @param {string} companyId
 * @param {string} paymentId
 * @param {{ invoice_id: string, amount_applied: number }[]} allocations
 */
export async function applyPaymentToInvoices(companyId, paymentId, allocations) {
  if (!Array.isArray(allocations) || allocations.length === 0) {
    throw Object.assign(new Error('allocations must be a non-empty array'), { status: 400 });
  }

  const merged = new Map();
  for (const raw of allocations) {
    const invId = raw.invoice_id;
    const applied = round2(raw.amount_applied);
    if (!invId) throw Object.assign(new Error('Each allocation needs invoice_id'), { status: 400 });
    if (applied <= 0) throw Object.assign(new Error('amount_applied must be positive'), { status: 400 });
    merged.set(invId, round2((merged.get(invId) || 0) + applied));
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const payRes = await client.query(
      `SELECT * FROM payments WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [paymentId, companyId]
    );
    if (!payRes.rows.length) {
      await client.query('ROLLBACK');
      throw Object.assign(new Error('Payment not found'), { status: 404 });
    }
    const payment = payRes.rows[0];

    const sumExisting = await client.query(
      `SELECT COALESCE(SUM(amount_applied), 0)::numeric AS s FROM payment_allocations
       WHERE payment_id = $1 AND company_id = $2`,
      [paymentId, companyId]
    );
    const already = round2(sumExisting.rows[0].s);
    const newTotal = round2([...merged.values()].reduce((a, b) => a + b, 0));
    if (round2(already + newTotal) > round2(payment.amount)) {
      await client.query('ROLLBACK');
      throw Object.assign(
        new Error('Total allocations exceed payment amount'),
        { status: 400 }
      );
    }

    for (const [invoiceId, amountApplied] of merged) {
      const invRes = await client.query(
        `SELECT * FROM invoices WHERE id = $1 AND company_id = $2 FOR UPDATE`,
        [invoiceId, companyId]
      );
      if (!invRes.rows.length) {
        await client.query('ROLLBACK');
        throw Object.assign(new Error(`Invoice not found: ${invoiceId}`), { status: 400 });
      }
      const inv = invRes.rows[0];
      if (inv.status === 'draft') {
        await client.query('ROLLBACK');
        throw Object.assign(new Error('Cannot allocate to draft invoices'), { status: 400 });
      }

      const remaining = invoiceBalanceRemaining(inv.total_amount, inv.paid_amount);
      if (amountApplied > remaining + 0.001) {
        await client.query('ROLLBACK');
        throw Object.assign(
          new Error(`Allocation exceeds remaining balance for invoice ${invoiceId}`),
          { status: 400 }
        );
      }

      await client.query(
        `INSERT INTO payment_allocations (company_id, payment_id, invoice_id, amount_applied)
         VALUES ($1, $2, $3, $4)`,
        [companyId, paymentId, invoiceId, amountApplied]
      );

      const newPaid = round2(round2(inv.paid_amount) + amountApplied);
      const nextStatus = nextInvoiceStatus(inv, newPaid);
      await client.query(
        `UPDATE invoices
         SET paid_amount = $1, status = $2::invoice_status
         WHERE id = $3 AND company_id = $4`,
        [newPaid, nextStatus, invoiceId, companyId]
      );
    }

    await client.query('COMMIT');
    return getPaymentById(companyId, paymentId);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
