import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { pool, query } from '../../../db.js';
import { authRequired } from '../../../middleware/auth.js';
import { companyContext } from '../../../middleware/companyContext.js';
import { requireManageStaff } from '../middleware/staffGuards.js';

const router = Router();
const SALT = 12;

const MEMBER_ROLES = new Set(['accountant', 'admin', 'doctor', 'receptionist']);

router.use(authRequired, companyContext, requireManageStaff);

async function companyOwnerId(companyId) {
  const r = await query(`SELECT owner_id FROM companies WHERE id = $1`, [companyId]);
  return r.rows[0]?.owner_id ?? null;
}

async function assertStaffRoleIdsForCompany(client, companyId, ids) {
  if (!ids.length) return { ok: true };
  const r = await client.query(
    `SELECT id FROM staff_roles WHERE company_id = $1 AND id = ANY($2::uuid[])`,
    [companyId, ids]
  );
  if (r.rows.length !== ids.length) return { ok: false, error: 'One or more staff_role_ids are invalid' };
  return { ok: true };
}

async function replaceMemberStaffRoles(client, membershipId, staffRoleIds) {
  await client.query(`DELETE FROM company_member_staff_roles WHERE company_member_id = $1`, [membershipId]);
  for (const rid of staffRoleIds) {
    await client.query(
      `INSERT INTO company_member_staff_roles (company_member_id, staff_role_id) VALUES ($1, $2)`,
      [membershipId, rid]
    );
  }
}

async function fetchStaffRolesForMemberIds(client, companyId, membershipIds) {
  if (!membershipIds.length) return new Map();
  const r = await client.query(
    `SELECT cmsr.company_member_id, sr.id, sr.role_name, sr.permissions
     FROM company_member_staff_roles cmsr
     JOIN staff_roles sr ON sr.id = cmsr.staff_role_id AND sr.company_id = $2
     WHERE cmsr.company_member_id = ANY($1::uuid[])`,
    [membershipIds, companyId]
  );
  /** @type {Map<string, Array<{id:string,role_name:string,permissions:object}>>} */
  const map = new Map();
  for (const row of r.rows) {
    const k = row.company_member_id;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push({
      id: row.id,
      role_name: row.role_name,
      permissions: row.permissions,
    });
  }
  return map;
}

/** Owner + active members; each row includes assigned custom roles. */
router.get('/', async (req, res) => {
  try {
    const companyId = req.company.id;
    const ownerId = await companyOwnerId(companyId);

    const members = await query(
      `SELECT cm.id AS membership_id, cm.user_id, cm.role, cm.is_active, cm.created_at AS joined_at,
              u.email, u.full_name, u.created_at AS user_created_at
       FROM company_members cm
       INNER JOIN users u ON u.id = cm.user_id
       WHERE cm.company_id = $1
       ORDER BY u.full_name NULLS LAST, u.email`,
      [companyId]
    );

    const mIds = members.rows.map((m) => m.membership_id);
    const rolesByMember = await fetchStaffRolesForMemberIds(pool, companyId, mIds);

    const memberUserIds = new Set(members.rows.map((m) => m.user_id));
    const out = [];

    if (ownerId && !memberUserIds.has(ownerId)) {
      const ou = await query(`SELECT id, email, full_name, created_at FROM users WHERE id = $1`, [ownerId]);
      if (ou.rows.length) {
        const u = ou.rows[0];
        out.push({
          user_id: u.id,
          email: u.email,
          full_name: u.full_name,
          user_created_at: u.created_at,
          membership_id: null,
          role: 'owner',
          is_active: true,
          is_owner: true,
          joined_at: null,
          staff_roles: [],
        });
      }
    }

    for (const m of members.rows) {
      out.push({
        user_id: m.user_id,
        email: m.email,
        full_name: m.full_name,
        user_created_at: m.user_created_at,
        membership_id: m.membership_id,
        role: m.role,
        is_active: m.is_active,
        is_owner: m.user_id === ownerId,
        joined_at: m.joined_at,
        staff_roles: rolesByMember.get(m.membership_id) || [],
      });
    }

    return res.json({ staff: out });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to list staff' });
  }
});

router.get('/:userId', async (req, res) => {
  try {
    const companyId = req.company.id;
    const userId = req.params.userId;
    const ownerId = await companyOwnerId(companyId);

    if (userId === ownerId) {
      const u = await query(`SELECT id, email, full_name, created_at FROM users WHERE id = $1`, [userId]);
      if (!u.rows.length) return res.status(404).json({ error: 'Not found' });
      return res.json({
        staff: {
          user_id: u.rows[0].id,
          email: u.rows[0].email,
          full_name: u.rows[0].full_name,
          user_created_at: u.rows[0].created_at,
          membership_id: null,
          role: 'owner',
          is_active: true,
          is_owner: true,
          joined_at: null,
          staff_roles: [],
        },
      });
    }

    const m = await query(
      `SELECT cm.id AS membership_id, cm.user_id, cm.role, cm.is_active, cm.created_at AS joined_at,
              u.email, u.full_name, u.created_at AS user_created_at
       FROM company_members cm
       INNER JOIN users u ON u.id = cm.user_id
       WHERE cm.company_id = $1 AND cm.user_id = $2`,
      [companyId, userId]
    );
    if (!m.rows.length) return res.status(404).json({ error: 'Not found' });
    const row = m.rows[0];
    const map = await fetchStaffRolesForMemberIds(pool, companyId, [row.membership_id]);
    return res.json({
      staff: {
        user_id: row.user_id,
        email: row.email,
        full_name: row.full_name,
        user_created_at: row.user_created_at,
        membership_id: row.membership_id,
        role: row.role,
        is_active: row.is_active,
        is_owner: row.user_id === ownerId,
        joined_at: row.joined_at,
        staff_roles: map.get(row.membership_id) || [],
      },
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to load staff member' });
  }
});

router.post('/', async (req, res) => {
  const body = req.body || {};
  const { email, password, full_name, role, staff_role_ids } = body;
  const staffRoleIds = Array.isArray(staff_role_ids) ? staff_role_ids.filter(Boolean) : [];

  if (!email || !String(email).trim()) {
    return res.status(400).json({ error: 'email is required' });
  }
  const normRole = role && MEMBER_ROLES.has(role) ? role : 'accountant';

  const client = await pool.connect();
  try {
    const chk = await assertStaffRoleIdsForCompany(client, req.company.id, staffRoleIds);
    if (!chk.ok) return res.status(400).json({ error: chk.error });

    const emailNorm = String(email).trim().toLowerCase();
    let userId;
    const existing = await client.query(`SELECT id FROM users WHERE email = $1`, [emailNorm]);

    if (existing.rows.length) {
      userId = existing.rows[0].id;
      if (!password) {
        /* existing user — optional password change not applied */
      }
    } else {
      if (!password || String(password).length < 6) {
        return res.status(400).json({ error: 'password is required (min 6 chars) for new users' });
      }
      const password_hash = await bcrypt.hash(String(password), SALT);
      const ins = await client.query(
        `INSERT INTO users (email, password_hash, full_name) VALUES ($1, $2, $3) RETURNING id`,
        [emailNorm, password_hash, full_name != null ? String(full_name) : null]
      );
      userId = ins.rows[0].id;
    }

    const ownerId = await companyOwnerId(req.company.id);
    if (userId === ownerId) {
      return res.status(400).json({ error: 'Company owner is already part of this company' });
    }

    const dup = await client.query(
      `SELECT 1 FROM company_members WHERE company_id = $1 AND user_id = $2`,
      [req.company.id, userId]
    );
    if (dup.rows.length) {
      return res.status(409).json({ error: 'User is already a member of this company' });
    }

    const mem = await client.query(
      `INSERT INTO company_members (company_id, user_id, role, is_active)
       VALUES ($1, $2, $3, TRUE)
       RETURNING id`,
      [req.company.id, userId, normRole]
    );
    const membershipId = mem.rows[0].id;
    await replaceMemberStaffRoles(client, membershipId, staffRoleIds);

    const u = await client.query(`SELECT id, email, full_name, created_at FROM users WHERE id = $1`, [userId]);
    const map = await fetchStaffRolesForMemberIds(client, req.company.id, [membershipId]);

    return res.status(201).json({
      staff: {
        user_id: u.rows[0].id,
        email: u.rows[0].email,
        full_name: u.rows[0].full_name,
        user_created_at: u.rows[0].created_at,
        membership_id: membershipId,
        role: normRole,
        is_active: true,
        is_owner: false,
        joined_at: new Date().toISOString(),
        staff_roles: map.get(membershipId) || [],
      },
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to create staff member' });
  } finally {
    client.release();
  }
});

router.put('/:userId', async (req, res) => {
  const body = req.body || {};
  const userId = req.params.userId;
  const companyId = req.company.id;
  const ownerId = await companyOwnerId(companyId);

  if (userId === ownerId) {
    const { full_name, email } = body;
    try {
      if (email !== undefined && String(email).trim()) {
        const em = String(email).trim().toLowerCase();
        const taken = await query(`SELECT id FROM users WHERE email = $1 AND id <> $2`, [em, userId]);
        if (taken.rows.length) return res.status(409).json({ error: 'Email already in use' });
        await query(`UPDATE users SET email = $1 WHERE id = $2`, [em, userId]);
      }
      if (full_name !== undefined) {
        await query(`UPDATE users SET full_name = $1 WHERE id = $2`, [
          full_name != null ? String(full_name) : null,
          userId,
        ]);
      }
      if (body.new_password && String(body.new_password).length >= 6) {
        const password_hash = await bcrypt.hash(String(body.new_password), SALT);
        await query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [password_hash, userId]);
      }
      const u = await query(`SELECT id, email, full_name, created_at FROM users WHERE id = $1`, [userId]);
      return res.json({
        staff: {
          user_id: u.rows[0].id,
          email: u.rows[0].email,
          full_name: u.rows[0].full_name,
          user_created_at: u.rows[0].created_at,
          membership_id: null,
          role: 'owner',
          is_active: true,
          is_owner: true,
          joined_at: null,
          staff_roles: [],
        },
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Failed to update owner profile' });
    }
  }

  const m = await query(
    `SELECT id FROM company_members WHERE company_id = $1 AND user_id = $2`,
    [companyId, userId]
  );
  if (!m.rows.length) return res.status(404).json({ error: 'Not found' });
  const membershipId = m.rows[0].id;

  const client = await pool.connect();
  try {
    const { full_name, email, role, is_active, staff_role_ids, new_password } = body;
    const staffRoleIds =
      staff_role_ids !== undefined
        ? Array.isArray(staff_role_ids)
          ? staff_role_ids.filter(Boolean)
          : []
        : null;

    if (staffRoleIds !== null) {
      const chk = await assertStaffRoleIdsForCompany(client, companyId, staffRoleIds);
      if (!chk.ok) return res.status(400).json({ error: chk.error });
    }

    if (email !== undefined && String(email).trim()) {
      const em = String(email).trim().toLowerCase();
      const taken = await client.query(`SELECT id FROM users WHERE email = $1 AND id <> $2`, [em, userId]);
      if (taken.rows.length) return res.status(409).json({ error: 'Email already in use' });
      await client.query(`UPDATE users SET email = $1 WHERE id = $2`, [em, userId]);
    }

    if (full_name !== undefined) {
      await client.query(`UPDATE users SET full_name = $1 WHERE id = $2`, [
        full_name != null ? String(full_name) : null,
        userId,
      ]);
    }

    if (new_password && String(new_password).length >= 6) {
      const password_hash = await bcrypt.hash(String(new_password), SALT);
      await client.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [password_hash, userId]);
    }

    if (role !== undefined || is_active !== undefined) {
      if (userId === ownerId) return res.status(403).json({ error: 'Cannot change membership for owner here' });
      const nextRole = role !== undefined ? (MEMBER_ROLES.has(role) ? role : undefined) : undefined;
      if (role !== undefined && !nextRole) return res.status(400).json({ error: 'Invalid role' });
      const nextActive = is_active !== undefined ? Boolean(is_active) : undefined;
      await client.query(
        `UPDATE company_members
         SET role = COALESCE($1::varchar, role),
             is_active = COALESCE($2, is_active)
         WHERE id = $3 AND company_id = $4`,
        [nextRole ?? null, nextActive ?? null, membershipId, companyId]
      );
    }

    if (staffRoleIds !== null) {
      await replaceMemberStaffRoles(client, membershipId, staffRoleIds);
    }

    const row = await client.query(
      `SELECT cm.id AS membership_id, cm.user_id, cm.role, cm.is_active, cm.created_at AS joined_at,
              u.email, u.full_name, u.created_at AS user_created_at
       FROM company_members cm
       INNER JOIN users u ON u.id = cm.user_id
       WHERE cm.id = $1`,
      [membershipId]
    );
    const map = await fetchStaffRolesForMemberIds(client, companyId, [membershipId]);
    const r = row.rows[0];
    return res.json({
      staff: {
        user_id: r.user_id,
        email: r.email,
        full_name: r.full_name,
        user_created_at: r.user_created_at,
        membership_id: r.membership_id,
        role: r.role,
        is_active: r.is_active,
        is_owner: r.user_id === ownerId,
        joined_at: r.joined_at,
        staff_roles: map.get(membershipId) || [],
      },
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to update staff member' });
  } finally {
    client.release();
  }
});

router.delete('/:userId', async (req, res) => {
  const userId = req.params.userId;
  const companyId = req.company.id;
  const ownerId = await companyOwnerId(companyId);
  if (userId === ownerId) {
    return res.status(403).json({ error: 'Cannot deactivate company owner' });
  }
  try {
    const r = await query(
      `UPDATE company_members SET is_active = FALSE
       WHERE company_id = $1 AND user_id = $2
       RETURNING id`,
      [companyId, userId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    return res.json({ ok: true, deactivated: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to deactivate staff member' });
  }
});

export default router;
