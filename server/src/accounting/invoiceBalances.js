/** Helpers for invoice paid / balance / status (non-draft). */

export function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

/**
 * Maps total vs paid to invoice_status when the invoice is not a draft.
 */
export function statusFromPaidTotal(total, paid) {
  const t = round2(total);
  const p = round2(paid);
  if (p <= 0) return 'unpaid';
  if (p >= t) return 'paid';
  return 'partially_paid';
}

export function invoiceBalanceRemaining(total, paid) {
  return Math.max(0, round2(round2(total) - round2(paid)));
}

/**
 * @param {object} inv — row with status, total_amount, paid_amount
 * @param {number} newPaidAmount
 */
export function nextInvoiceStatus(inv, newPaidAmount) {
  if (inv.status === 'draft') return 'draft';
  return statusFromPaidTotal(inv.total_amount, newPaidAmount);
}
