import { canManageStaff, canManageRoles } from '../services/staffPermissions.js';

export async function requireManageStaff(req, res, next) {
  try {
    if (await canManageStaff(req.company.id, req.user.id)) return next();
    return res.status(403).json({ error: 'Staff management access required' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Authorization check failed' });
  }
}

export async function requireManageRoles(req, res, next) {
  try {
    if (await canManageRoles(req.company.id, req.user.id)) return next();
    return res.status(403).json({ error: 'Roles management access required' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Authorization check failed' });
  }
}
