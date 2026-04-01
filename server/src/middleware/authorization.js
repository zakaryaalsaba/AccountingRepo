import { query } from '../db.js';

const DEFAULT_ROLE_PERMISSIONS = {
  owner: { '*': true },
  admin: { '*': true },
  accountant: {
    'transactions.read': true,
    'transactions.create': true,
    'transactions.delete': false,
    'reports.read': true,
    'periods.close': false,
    'periods.reopen': false,
    'periods.year_close': false,
    'audit.approval.decide': false,
    'documents.read': true,
    'documents.manage': true,
  },
  viewer: {
    'transactions.read': true,
    'reports.read': true,
    'documents.read': true,
    'documents.manage': false,
  },
};

export async function resolveUserRole(companyId, userId) {
  const c = await query(`SELECT owner_id FROM companies WHERE id = $1`, [companyId]);
  if (c.rows[0]?.owner_id === userId) return { role: 'owner', is_owner: true, permissions: { '*': true } };
  const m = await query(
    `SELECT id, role
     FROM company_members
     WHERE company_id = $1 AND user_id = $2 AND is_active = TRUE
     LIMIT 1`,
    [companyId, userId]
  );
  const role = m.rows[0]?.role || 'viewer';
  const perms = { ...(DEFAULT_ROLE_PERMISSIONS[role] || DEFAULT_ROLE_PERMISSIONS.viewer) };
  if (m.rows[0]?.id) {
    const sr = await query(
      `SELECT COALESCE(sr.permissions, '{}'::jsonb) AS permissions
       FROM company_member_staff_roles cmsr
       JOIN staff_roles sr ON sr.id = cmsr.staff_role_id
       WHERE cmsr.company_member_id = $1`,
      [m.rows[0].id]
    );
    for (const row of sr.rows) {
      const p = row.permissions || {};
      for (const [k, v] of Object.entries(p)) perms[k] = Boolean(v);
    }
  }
  return { role, is_owner: false, permissions: perms };
}

export async function attachAuthorization(req, _res, next) {
  const auth = await resolveUserRole(req.company.id, req.user.id);
  req.authorization = auth;
  next();
}

export function requireRole(roles) {
  const allowed = new Set(roles);
  return async (req, res, next) => {
    if (!req.authorization) req.authorization = await resolveUserRole(req.company.id, req.user.id);
    if (!allowed.has(req.authorization.role)) return res.status(403).json({ error: 'Insufficient role' });
    next();
  };
}

export function requirePermission(permissionKey) {
  return async (req, res, next) => {
    if (!req.authorization) req.authorization = await resolveUserRole(req.company.id, req.user.id);
    const p = req.authorization.permissions || {};
    if (p['*'] || p[permissionKey]) return next();
    return res.status(403).json({ error: `Missing permission: ${permissionKey}` });
  };
}

export async function assertRoleAmountLimit({ companyId, role, actionKey, amount }) {
  const v = Number(amount || 0);
  if (v <= 0) return;
  const r = await query(
    `SELECT max_amount
     FROM role_action_limits
     WHERE company_id = $1
       AND role = $2
       AND action_key = $3
     LIMIT 1`,
    [companyId, String(role), String(actionKey)]
  );
  if (!r.rows.length) return;
  const max = Number(r.rows[0].max_amount || 0);
  if (v > max) {
    const err = new Error(`Amount exceeds role limit for ${actionKey}. Max allowed: ${max}`);
    err.status = 403;
    throw err;
  }
}

