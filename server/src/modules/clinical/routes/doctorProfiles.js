import { Router } from 'express';
import { pool } from '../../../db.js';
import { authRequired } from '../../../middleware/auth.js';
import { companyContext } from '../../../middleware/companyContext.js';
import { getActorClinicalRole } from '../services/clinicalAccess.js';

const router = Router();
router.use(authRequired, companyContext);

const SELECT_ROW = `dp.id, dp.company_id, dp.user_id, dp.specialization, dp.license_number, dp.notes, dp.created_at,
  u.full_name AS user_full_name, u.email AS user_email`;

/**
 * Doctors list for clinical dropdowns:
 * - must be a company member with role = 'doctor'
 * - must be active (company_members.is_active = TRUE)
 * Optional profile row joined.
 */
router.get('/', async (req, res) => {
  try {
    const doctors = await pool.query(
      `WITH doc_users AS (
         SELECT m.user_id
         FROM company_members m
         WHERE m.company_id = $1 AND m.role = 'doctor' AND m.is_active = TRUE
       )
       SELECT DISTINCT u.id AS user_id, u.full_name, u.email,
              dp.id AS profile_id, dp.specialization, dp.license_number, dp.notes, dp.created_at AS profile_created_at
       FROM doc_users d
       JOIN users u ON u.id = d.user_id
       LEFT JOIN doctor_profiles dp ON dp.user_id = u.id AND dp.company_id = $1
       ORDER BY u.full_name NULLS LAST`,
      [req.company.id]
    );
    return res.json({ doctors: doctors.rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to list doctors' });
  }
});

/** Upsert profile for a user in this company. */
router.post('/', async (req, res) => {
  const { user_id, specialization, license_number, notes } = req.body || {};
  const targetUserId = user_id || req.user.id;
  const role = await getActorClinicalRole(req.company.id, req.user.id);
  if (targetUserId !== req.user.id && role !== 'owner' && role !== 'admin') {
    return res.status(403).json({ error: 'Only admins or the user themself can manage this profile' });
  }
  try {
    const r = await pool.query(
      `INSERT INTO doctor_profiles (company_id, user_id, specialization, license_number, notes)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (company_id, user_id)
       DO UPDATE SET
         specialization = EXCLUDED.specialization,
         license_number = EXCLUDED.license_number,
         notes = EXCLUDED.notes
       RETURNING id`,
      [
        req.company.id,
        targetUserId,
        specialization != null ? String(specialization).slice(0, 255) : null,
        license_number != null ? String(license_number).slice(0, 100) : null,
        notes != null ? String(notes) : null,
      ]
    );
    const out = await pool.query(
      `SELECT ${SELECT_ROW}
       FROM doctor_profiles dp
       JOIN users u ON u.id = dp.user_id
       WHERE dp.id = $1 AND dp.company_id = $2`,
      [r.rows[0].id, req.company.id]
    );
    return res.status(201).json({ doctor_profile: out.rows[0] });
  } catch (e) {
    console.error(e);
    if (e.code === '23503') return res.status(400).json({ error: 'Invalid user_id' });
    return res.status(500).json({ error: 'Failed to save doctor profile' });
  }
});

router.put('/:id', async (req, res) => {
  const { specialization, license_number, notes } = req.body || {};
  const role = await getActorClinicalRole(req.company.id, req.user.id);
  try {
    const cur = await pool.query(
      `SELECT * FROM doctor_profiles WHERE id = $1 AND company_id = $2`,
      [req.params.id, req.company.id]
    );
    if (!cur.rows.length) return res.status(404).json({ error: 'Not found' });
    const row = cur.rows[0];
    if (row.user_id !== req.user.id && role !== 'owner' && role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const nextSpec =
      specialization !== undefined
        ? specialization != null
          ? String(specialization).slice(0, 255)
          : null
        : row.specialization;
    const nextLic =
      license_number !== undefined
        ? license_number != null
          ? String(license_number).slice(0, 100)
          : null
        : row.license_number;
    const nextNotes =
      notes !== undefined ? (notes != null ? String(notes) : null) : row.notes;

    await pool.query(
      `UPDATE doctor_profiles
       SET specialization = $1, license_number = $2, notes = $3
       WHERE id = $4 AND company_id = $5`,
      [nextSpec, nextLic, nextNotes, req.params.id, req.company.id]
    );
    const out = await pool.query(
      `SELECT ${SELECT_ROW}
       FROM doctor_profiles dp
       JOIN users u ON u.id = dp.user_id
       WHERE dp.id = $1`,
      [req.params.id]
    );
    return res.json({ doctor_profile: out.rows[0] });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to update doctor profile' });
  }
});

export default router;
