import { query } from '../../../db.js';

/**
 * Permission keys (documented contract; UI and future middleware can rely on these):
 * - staff.manage — create/update/deactivate users in company
 * - roles.manage — create/update/delete staff_roles definitions
 * Owner and company_members.role === 'admin' bypass JSON and have full access.
 */

/**
 * Merge multiple permission objects: a key is true if any role sets it to true.
 * @param {Record<string, unknown>[]} objects
 */
export function mergePermissionObjects(objects) {
  const out = {};
  for (const obj of objects) {
    if (!obj || typeof obj !== 'object') continue;
    for (const [k, v] of Object.entries(obj)) {
      if (v === true) out[k] = true;
    }
  }
  return out;
}

/**
 * @param {Record<string, unknown>} merged
 * @param {string} key
 */
export function permissionIsTrue(merged, key) {
  return merged[key] === true;
}

/**
 * Loads all staff_roles.permissions assigned to this user's membership row (if any).
 */
export async function getMergedStaffRolePermissions(companyId, userId) {
  const r = await query(
    `SELECT sr.permissions
     FROM company_members cm
     JOIN company_member_staff_roles cmsr ON cmsr.company_member_id = cm.id
     JOIN staff_roles sr ON sr.id = cmsr.staff_role_id AND sr.company_id = cm.company_id
     WHERE cm.company_id = $1 AND cm.user_id = $2 AND cm.is_active = TRUE`,
    [companyId, userId]
  );
  return mergePermissionObjects(r.rows.map((row) => row.permissions));
}

/**
 * True if user may perform staff admin actions (users list / CRUD).
 */
export async function canManageStaff(companyId, userId) {
  const c = await query(`SELECT owner_id FROM companies WHERE id = $1`, [companyId]);
  if (c.rows[0]?.owner_id === userId) return true;
  const m = await query(
    `SELECT role FROM company_members WHERE company_id = $1 AND user_id = $2 AND is_active = TRUE`,
    [companyId, userId]
  );
  if (m.rows[0]?.role === 'admin') return true;
  const perms = await getMergedStaffRolePermissions(companyId, userId);
  return permissionIsTrue(perms, 'staff.manage');
}

/**
 * True if user may manage staff_roles definitions (roles CRUD).
 */
export async function canManageRoles(companyId, userId) {
  const c = await query(`SELECT owner_id FROM companies WHERE id = $1`, [companyId]);
  if (c.rows[0]?.owner_id === userId) return true;
  const m = await query(
    `SELECT role FROM company_members WHERE company_id = $1 AND user_id = $2 AND is_active = TRUE`,
    [companyId, userId]
  );
  if (m.rows[0]?.role === 'admin') return true;
  const perms = await getMergedStaffRolePermissions(companyId, userId);
  return permissionIsTrue(perms, 'roles.manage');
}
