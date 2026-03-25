import { Router } from 'express';
import { pool } from '../../../db.js';
import { authRequired } from '../../../middleware/auth.js';
import { companyContext } from '../../../middleware/companyContext.js';
import {
  getActorClinicalRole,
  isCompanyDoctorOrOwner,
  mayCreateAppointment,
  mayMutateAppointment,
} from '../services/clinicalAccess.js';

const router = Router();
router.use(authRequired, companyContext);

const STATUSES = new Set(['scheduled', 'completed', 'cancelled']);

const APPOINTMENT_SELECT = `a.id, a.company_id, a.patient_id, a.assigned_doctor_id, a.appointment_date, a.status::text, a.notes, a.created_at,
  a.blood_pressure, a.heart_rate, a.spo2, a.temperature_c, a.respiratory_rate, a.weight_kg`;

const PATIENT_DETAIL_SELECT = `id, company_id, full_name, phone, email, date_of_birth, blood_group, gender::text, notes,
  blood_pressure, heart_rate, spo2, temperature_c, respiratory_rate, weight_kg, created_at`;

const RX_DETAIL = `pr.id, pr.company_id, pr.appointment_id, pr.doctor_id, pr.patient_id,
  pr.medication_name, pr.dosage, pr.instructions, pr.service_fee, pr.created_at,
  p.full_name AS patient_name, u.full_name AS doctor_name`;

const LAB_DETAIL = `lo.id, lo.company_id, lo.appointment_id, lo.doctor_id, lo.patient_id,
  lo.test_name, lo.instructions, lo.status::text, lo.results, lo.test_fee, lo.created_at,
  p.full_name AS patient_name, u.full_name AS doctor_name`;

function optTrim(v, maxLen) {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  return String(v).trim().slice(0, maxLen);
}

function optSmallInt(v) {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  const n = parseInt(String(v), 10);
  if (Number.isNaN(n)) return null;
  return n;
}

function optDecimal(v) {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  const n = Number(v);
  if (Number.isNaN(n)) return null;
  return n;
}

function validateVitals(body) {
  const { heart_rate, spo2, respiratory_rate, temperature_c, weight_kg } = body || {};
  if (heart_rate != null && heart_rate !== '' && (Number(heart_rate) < 0 || Number(heart_rate) > 400)) {
    return 'heart_rate out of range';
  }
  if (spo2 != null && spo2 !== '' && (Number(spo2) < 0 || Number(spo2) > 100)) {
    return 'spo2 must be 0–100';
  }
  if (
    respiratory_rate != null &&
    respiratory_rate !== '' &&
    (Number(respiratory_rate) < 0 || Number(respiratory_rate) > 120)
  ) {
    return 'respiratory_rate out of range';
  }
  if (
    temperature_c != null &&
    temperature_c !== '' &&
    (Number(temperature_c) < 30 || Number(temperature_c) > 45)
  ) {
    return 'temperature_c out of plausible range';
  }
  if (weight_kg != null && weight_kg !== '' && (Number(weight_kg) < 0 || Number(weight_kg) > 500)) {
    return 'weight_kg out of range';
  }
  return null;
}

async function assertPatientInCompany(client, companyId, patientId) {
  const r = await client.query(
    `SELECT 1 FROM patients WHERE id = $1 AND company_id = $2`,
    [patientId, companyId]
  );
  return r.rows.length > 0;
}

/** Null clears assignment; non-null must be owner or company doctor. */
async function assertAssignedDoctor(client, companyId, doctorUserId) {
  if (doctorUserId == null || doctorUserId === '') return { ok: true };
  if (!(await isCompanyDoctorOrOwner(client, companyId, doctorUserId))) {
    return { ok: false, error: 'assigned_doctor_id must be a company doctor or owner' };
  }
  return { ok: true };
}

router.get('/', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT ${APPOINTMENT_SELECT}, p.full_name AS patient_name, doc.full_name AS assigned_doctor_name
       FROM appointments a
       INNER JOIN patients p ON p.id = a.patient_id AND p.company_id = a.company_id
       LEFT JOIN users doc ON doc.id = a.assigned_doctor_id
       WHERE a.company_id = $1
       ORDER BY a.appointment_date ASC`,
      [req.company.id]
    );
    return res.json({ appointments: r.rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to list appointments' });
  }
});

/**
 * Calendar feed for UI.
 * GET /api/appointments/calendar
 */
router.get('/calendar', async (req, res) => {
  const { doctor_id, patient_id, start_date, end_date, date_range } = req.query || {};
  try {
    let start = start_date;
    let end = end_date;
    if ((!start || !end) && date_range) {
      const parts = String(date_range).split(',').map((s) => s.trim());
      if (parts.length === 2) {
        start = parts[0];
        end = parts[1];
      }
    }

    // Default to current month.
    if (!start || !end) {
      const now = new Date();
      const y = now.getFullYear();
      const m = now.getMonth();
      const first = new Date(y, m, 1, 0, 0, 0, 0);
      const next = new Date(y, m + 1, 1, 0, 0, 0, 0);
      start = first.toISOString();
      end = next.toISOString();
    }

    const r = await pool.query(
      `SELECT
         a.id,
         a.patient_id,
         a.assigned_doctor_id AS doctor_id,
         a.appointment_date,
         a.status::text AS status,
         a.notes,
         p.full_name AS patient_name,
         doc.full_name AS doctor_name
       FROM appointments a
       INNER JOIN patients p ON p.id = a.patient_id AND p.company_id = a.company_id
       LEFT JOIN users doc ON doc.id = a.assigned_doctor_id
       WHERE a.company_id = $1
         AND ($2::uuid IS NULL OR a.assigned_doctor_id = $2)
         AND ($3::uuid IS NULL OR a.patient_id = $3)
         AND a.appointment_date >= $4::timestamptz
         AND a.appointment_date <  $5::timestamptz
       ORDER BY a.appointment_date ASC`,
      [req.company.id, doctor_id || null, patient_id || null, start, end]
    );

    return res.json({ appointments: r.rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to load calendar' });
  }
});

/**
 * Full visit context: appointment, patient demographics, prescriptions and lab orders for this visit.
 * All rows scoped by company_id (multi-tenant).
 */
router.get('/:id', async (req, res) => {
  try {
    const a = await pool.query(
      `SELECT ${APPOINTMENT_SELECT}, p.full_name AS patient_name, doc.full_name AS assigned_doctor_name
       FROM appointments a
       INNER JOIN patients p ON p.id = a.patient_id AND p.company_id = a.company_id
       LEFT JOIN users doc ON doc.id = a.assigned_doctor_id
       WHERE a.id = $1 AND a.company_id = $2`,
      [req.params.id, req.company.id]
    );
    if (!a.rows.length) return res.status(404).json({ error: 'Not found' });
    const appointment = a.rows[0];

    const [patient, prescriptions, labOrders] = await Promise.all([
      pool.query(
        `SELECT ${PATIENT_DETAIL_SELECT} FROM patients WHERE id = $1 AND company_id = $2`,
        [appointment.patient_id, req.company.id]
      ),
      pool.query(
        `SELECT ${RX_DETAIL}
         FROM prescriptions pr
         INNER JOIN patients p ON p.id = pr.patient_id AND p.company_id = pr.company_id
         INNER JOIN users u ON u.id = pr.doctor_id
         WHERE pr.company_id = $1 AND pr.appointment_id = $2
         ORDER BY pr.created_at ASC`,
        [req.company.id, req.params.id]
      ),
      pool.query(
        `SELECT ${LAB_DETAIL}
         FROM lab_orders lo
         INNER JOIN patients p ON p.id = lo.patient_id AND p.company_id = lo.company_id
         INNER JOIN users u ON u.id = lo.doctor_id
         WHERE lo.company_id = $1 AND lo.appointment_id = $2
         ORDER BY lo.created_at ASC`,
        [req.company.id, req.params.id]
      ),
    ]);

    return res.json({
      appointment,
      patient: patient.rows[0] || null,
      prescriptions: prescriptions.rows,
      lab_orders: labOrders.rows,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to load appointment' });
  }
});

router.post('/', async (req, res) => {
  const body = req.body || {};
  const { patient_id, appointment_date, status, notes, assigned_doctor_id, doctor_id } = body;
  const verr = validateVitals(body);
  if (verr) return res.status(400).json({ error: verr });

  if (!patient_id || !appointment_date) {
    return res.status(400).json({ error: 'patient_id and appointment_date are required' });
  }
  const st = status && STATUSES.has(status) ? status : 'scheduled';

  const blood_pressure = optTrim(body.blood_pressure ?? null, 30);
  const heart_rate = optSmallInt(body.heart_rate ?? null);
  const spo2 = optSmallInt(body.spo2 ?? null);
  const temperature_c = optDecimal(body.temperature_c ?? null);
  const respiratory_rate = optSmallInt(body.respiratory_rate ?? null);
  const weight_kg = optDecimal(body.weight_kg ?? null);

  const doctorId =
    (assigned_doctor_id === undefined || assigned_doctor_id === '')
      ? doctor_id === undefined || doctor_id === ''
        ? null
        : doctor_id
      : assigned_doctor_id;

  const actorRole = await getActorClinicalRole(req.company.id, req.user.id);
  if (!mayCreateAppointment(actorRole, req.user.id, doctorId)) {
    return res.status(403).json({ error: 'Appointment create access required' });
  }

  // Doctors can only create appointments assigned to themselves.
  const finalDoctorId = actorRole === 'doctor' && doctorId == null ? req.user.id : doctorId;

  const client = await pool.connect();
  try {
    if (!(await assertPatientInCompany(client, req.company.id, patient_id))) {
      return res.status(400).json({ error: 'Invalid patient_id' });
    }
    const dchk = await assertAssignedDoctor(client, req.company.id, finalDoctorId);
    if (!dchk.ok) return res.status(400).json({ error: dchk.error });

    const r = await client.query(
      `INSERT INTO appointments (
         company_id, patient_id, assigned_doctor_id, appointment_date, status, notes,
         blood_pressure, heart_rate, spo2, temperature_c, respiratory_rate, weight_kg
       )
       VALUES ($1, $2, $3, $4::timestamptz, $5::appointment_status, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id, company_id, patient_id, assigned_doctor_id, appointment_date, status::text, notes, created_at,
         blood_pressure, heart_rate, spo2, temperature_c, respiratory_rate, weight_kg`,
      [
        req.company.id,
        patient_id,
        finalDoctorId,
        appointment_date,
        st,
        notes != null ? String(notes) : null,
        blood_pressure,
        heart_rate,
        spo2,
        temperature_c,
        respiratory_rate,
        weight_kg,
      ]
    );
    const row = r.rows[0];
    const pn = await client.query(
      `SELECT full_name FROM patients WHERE id = $1 AND company_id = $2`,
      [patient_id, req.company.id]
    );
    const dn = await client.query(
      `SELECT full_name FROM users WHERE id = $1`,
      [row.assigned_doctor_id]
    );
    return res.status(201).json({
      appointment: {
        ...row,
        patient_name: pn.rows[0]?.full_name,
        assigned_doctor_name: dn.rows[0]?.full_name ?? null,
      },
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to create appointment' });
  } finally {
    client.release();
  }
});

router.put('/:id', async (req, res) => {
  const body = req.body || {};
  const verr = validateVitals(body);
  if (verr) return res.status(400).json({ error: verr });

  if (body.status !== undefined && body.status !== null && !STATUSES.has(body.status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  const client = await pool.connect();
  try {
    const cur = await client.query(
      `SELECT * FROM appointments WHERE id = $1 AND company_id = $2`,
      [req.params.id, req.company.id]
    );
    if (!cur.rows.length) return res.status(404).json({ error: 'Not found' });
    const row = cur.rows[0];

    const actorRole = await getActorClinicalRole(req.company.id, req.user.id);
    if (!mayMutateAppointment(actorRole, req.user.id, row.assigned_doctor_id)) {
      return res.status(403).json({ error: 'Appointment update access required' });
    }
    if (
      actorRole === 'doctor' &&
      (body.assigned_doctor_id !== undefined || body.doctor_id !== undefined)
    ) {
      const assignedDoctorInput =
        body.assigned_doctor_id !== undefined ? body.assigned_doctor_id : body.doctor_id;
      const nextDoctor =
        assignedDoctorInput === null || assignedDoctorInput === '' ? null : assignedDoctorInput;
      if (nextDoctor !== req.user.id) {
        return res.status(403).json({ error: 'Doctors cannot reassign appointments' });
      }
    }

    const nextPatient = body.patient_id !== undefined ? body.patient_id : row.patient_id;
    if (body.patient_id !== undefined && !(await assertPatientInCompany(client, req.company.id, nextPatient))) {
      return res.status(400).json({ error: 'Invalid patient_id' });
    }

    const nextStatus = body.status !== undefined ? body.status : row.status;
    const nextDate = body.appointment_date !== undefined ? body.appointment_date : row.appointment_date;
    const nextNotes =
      body.notes !== undefined ? (body.notes != null ? String(body.notes) : null) : row.notes;

    let nextDoctor = row.assigned_doctor_id;
    if (body.assigned_doctor_id !== undefined || body.doctor_id !== undefined) {
      const assignedDoctorInput =
        body.assigned_doctor_id !== undefined ? body.assigned_doctor_id : body.doctor_id;
      nextDoctor =
        assignedDoctorInput === null || assignedDoctorInput === '' ? null : assignedDoctorInput;
      const dchk = await assertAssignedDoctor(client, req.company.id, nextDoctor);
      if (!dchk.ok) return res.status(400).json({ error: dchk.error });
    }

    const nextBp =
      body.blood_pressure !== undefined ? optTrim(body.blood_pressure, 30) : row.blood_pressure;
    const nextHr = body.heart_rate !== undefined ? optSmallInt(body.heart_rate) : row.heart_rate;
    const nextSpo2 = body.spo2 !== undefined ? optSmallInt(body.spo2) : row.spo2;
    const nextTemp =
      body.temperature_c !== undefined ? optDecimal(body.temperature_c) : row.temperature_c;
    const nextRr =
      body.respiratory_rate !== undefined ? optSmallInt(body.respiratory_rate) : row.respiratory_rate;
    const nextW = body.weight_kg !== undefined ? optDecimal(body.weight_kg) : row.weight_kg;

    const r = await client.query(
      `UPDATE appointments
       SET patient_id = $1, assigned_doctor_id = $2, appointment_date = $3::timestamptz, status = $4::appointment_status, notes = $5,
           blood_pressure = $6, heart_rate = $7, spo2 = $8, temperature_c = $9, respiratory_rate = $10, weight_kg = $11
       WHERE id = $12 AND company_id = $13
       RETURNING id, company_id, patient_id, assigned_doctor_id, appointment_date, status::text, notes, created_at,
         blood_pressure, heart_rate, spo2, temperature_c, respiratory_rate, weight_kg`,
      [
        nextPatient,
        nextDoctor,
        nextDate,
        nextStatus,
        nextNotes,
        nextBp,
        nextHr,
        nextSpo2,
        nextTemp,
        nextRr,
        nextW,
        req.params.id,
        req.company.id,
      ]
    );
    const pn = await client.query(
      `SELECT full_name FROM patients WHERE id = $1 AND company_id = $2`,
      [r.rows[0].patient_id, req.company.id]
    );
    const dn = await client.query(`SELECT full_name FROM users WHERE id = $1`, [r.rows[0].assigned_doctor_id]);
    return res.json({
      appointment: {
        ...r.rows[0],
        patient_name: pn.rows[0]?.full_name,
        assigned_doctor_name: dn.rows[0]?.full_name ?? null,
      },
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to update appointment' });
  } finally {
    client.release();
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const client = await pool.connect();
    try {
      const cur = await client.query(
        `SELECT assigned_doctor_id FROM appointments WHERE id = $1 AND company_id = $2`,
        [req.params.id, req.company.id]
      );
      if (!cur.rows.length) return res.status(404).json({ error: 'Not found' });

      const actorRole = await getActorClinicalRole(req.company.id, req.user.id);
      if (!mayMutateAppointment(actorRole, req.user.id, cur.rows[0].assigned_doctor_id)) {
        return res.status(403).json({ error: 'Appointment delete access required' });
      }

      await client.query(`DELETE FROM appointments WHERE id = $1 AND company_id = $2`, [
        req.params.id,
        req.company.id,
      ]);
      return res.json({ ok: true });
    } finally {
      client.release();
    }
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to delete appointment' });
  }
});

export default router;
