import { query } from '../db.js';

/**
 * Returns company row if user may access it (owner or company_members).
 */
export async function getAccessibleCompany(companyId, userId) {
  const r = await query(
    `SELECT c.*
     FROM companies c
     WHERE c.id = $1
       AND (
         c.owner_id = $2
         OR EXISTS (
           SELECT 1 FROM company_members m
           WHERE m.company_id = c.id AND m.user_id = $2 AND m.is_active = TRUE
         )
       )`,
    [companyId, userId]
  );
  return r.rows[0] || null;
}
