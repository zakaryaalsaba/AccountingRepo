/**
 * Sequential signing: the active signer is the first PENDING recipient when ordered by
 * `signing_order`, then `created_at`.
 *
 * @param {(text: string, params?: unknown[]) => Promise<{ rows: { id: string; status: string; signing_order: number }[] }>} executor
 */
export async function assertRecipientSigningTurn(executor, { documentId, companyId, recipientId }) {
  const r = await executor(
    `SELECT id, status, signing_order
     FROM esign_recipients
     WHERE document_id = $1 AND company_id = $2
     ORDER BY signing_order ASC, created_at ASC`,
    [documentId, companyId]
  );
  const firstPending = r.rows.find((row) => row.status === 'PENDING');
  if (!firstPending) {
    return { ok: false, code: 'no_pending', status: 409 };
  }
  if (String(firstPending.id) !== String(recipientId)) {
    return {
      ok: false,
      code: 'wrong_order',
      status: 409,
      current_signing_order: firstPending.signing_order,
    };
  }
  return { ok: true };
}
