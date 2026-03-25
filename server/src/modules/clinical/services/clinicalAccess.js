import { pool } from '../../../db.js';

/**
 * Resolves effective role for clinical RBAC: company owner → 'owner', else company_members.role.
 * Users with no row in company_members but who are owner still get owner.
 */
export async function getActorClinicalRole(companyId, userId) {
  const c = await pool.query(`SELECT owner_id FROM companies WHERE id = $1`, [companyId]);
  if (c.rows[0]?.owner_id === userId) return 'owner';
  const m = await pool.query(
    `SELECT role FROM company_members WHERE company_id = $1 AND user_id = $2 AND is_active = TRUE`,
    [companyId, userId]
  );
  return m.rows[0]?.role ?? null;
}

/**
 * Owner/admin: manage any record. Doctor: only records where they are the prescribing/ordering doctor.
 */
export function mayMutatePrescriptionLab(actorRole, userId, recordDoctorId) {
  if (actorRole === 'owner' || actorRole === 'admin') return true;
  if (actorRole === 'doctor' && recordDoctorId === userId) return true;
  return false;
}

/** Same rule for create: doctor must prescribe/order as themselves unless admin/owner. */
export function mayCreatePrescriptionLab(actorRole, userId, bodyDoctorId) {
  return mayMutatePrescriptionLab(actorRole, userId, bodyDoctorId);
}

/**
 * Valid prescribing user for this company: company owner or member with role "doctor".
 */
export async function isCompanyDoctorOrOwner(client, companyId, doctorUserId) {
  const c = await client.query(`SELECT owner_id FROM companies WHERE id = $1`, [companyId]);
  if (c.rows[0]?.owner_id === doctorUserId) return true;
  const m = await client.query(
    `SELECT 1 FROM company_members WHERE company_id = $1 AND user_id = $2 AND role = 'doctor' AND is_active = TRUE`,
    [companyId, doctorUserId]
  );
  return m.rows.length > 0;
}

export async function isCompanyDoctorOrOwnerPool(companyId, doctorUserId) {
  const client = await pool.connect();
  try {
    return await isCompanyDoctorOrOwner(client, companyId, doctorUserId);
  } finally {
    client.release();
  }
}

/**
 * Appointment write permissions.
 *
 * - owner/admin/receptionist: can create/update/delete any appointment in company.
 * - doctor: can only create/update/delete appointments assigned to them.
 */
export function mayCreateAppointment(actorRole, actorUserId, bodyAssignedDoctorId) {
  if (actorRole === 'owner' || actorRole === 'admin' || actorRole === 'receptionist') return true;
  if (actorRole === 'doctor') {
    // Doctor may only create appointments for themselves.
    if (bodyAssignedDoctorId == null || bodyAssignedDoctorId === '') return true;
    return bodyAssignedDoctorId === actorUserId;
  }
  return false;
}

export function mayMutateAppointment(actorRole, actorUserId, recordAssignedDoctorId) {
  if (actorRole === 'owner' || actorRole === 'admin' || actorRole === 'receptionist') return true;
  if (actorRole === 'doctor') return recordAssignedDoctorId === actorUserId;
  return false;
}
