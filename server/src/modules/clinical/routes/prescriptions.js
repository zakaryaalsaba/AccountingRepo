import { Router } from 'express';
import { pool } from '../../../db.js';
import { authRequired } from '../../../middleware/auth.js';
import { companyContext } from '../../../middleware/companyContext.js';
import {
  getActorClinicalRole,
  mayCreatePrescriptionLab,
  mayMutatePrescriptionLab,
  isCompanyDoctorOrOwner,
} from '../services/clinicalAccess.js';

const router = Router();
router.use(authRequired, companyContext);

const RX_SELECT = `pr.id, pr.company_id, pr.appointment_id, pr.doctor_id, pr.patient_id,
  pr.medication_name, pr.dosage, pr.instructions, pr.service_fee, pr.created_at,
  p.full_name AS patient_name, u.full_name AS doctor_name`;

async function assertAppointmentPatient(client, companyId, appointmentId, patientId) {
  const r = await client.query(
    `SELECT patient_id FROM appointments WHERE id = $1 AND company_id = $2`,
    [appointmentId, companyId]
  );
  if (!r.rows.length) return { ok: false, error: 'Invalid appointment_id' };
  if (r.rows[0].patient_id !== patientId) {
    return { ok: false, error: 'patient_id must match the appointment patient' };
  }
  return { ok: true };
}

router.get('/', async (req, res) => {
  const patientId = req.query.patient_id || null;
  const doctorId = req.query.doctor_id || null;
  try {
    const r = await pool.query(
      `SELECT ${RX_SELECT}
       FROM prescriptions pr
       INNER JOIN patients p ON p.id = pr.patient_id AND p.company_id = pr.company_id
       INNER JOIN users u ON u.id = pr.doctor_id
       WHERE pr.company_id = $1
         AND ($2::uuid IS NULL OR pr.patient_id = $2)
         AND ($3::uuid IS NULL OR pr.doctor_id = $3)
       ORDER BY pr.created_at DESC`,
      [req.company.id, patientId, doctorId]
    );
    return res.json({ prescriptions: r.rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to list prescriptions' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT ${RX_SELECT}
       FROM prescriptions pr
       INNER JOIN patients p ON p.id = pr.patient_id AND p.company_id = pr.company_id
       INNER JOIN users u ON u.id = pr.doctor_id
       WHERE pr.id = $1 AND pr.company_id = $2`,
      [req.params.id, req.company.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    return res.json({ prescription: r.rows[0] });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to load prescription' });
  }
});

router.post('/', async (req, res) => {
  const body = req.body || {};
  const {
    appointment_id,
    doctor_id,
    patient_id,
    medication_name,
    dosage,
    instructions,
    service_fee,
  } = body;

  if (!appointment_id || !doctor_id || !patient_id || !medication_name) {
    return res.status(400).json({
      error: 'appointment_id, doctor_id, patient_id, and medication_name are required',
    });
  }

  const actorRole = await getActorClinicalRole(req.company.id, req.user.id);
  if (!mayCreatePrescriptionLab(actorRole, req.user.id, doctor_id)) {
    return res.status(403).json({ error: 'Only company admins/owners or the prescribing doctor may create' });
  }

  const client = await pool.connect();
  try {
    if (!(await isCompanyDoctorOrOwner(client, req.company.id, doctor_id))) {
      return res.status(400).json({ error: 'doctor_id must be a company doctor or owner' });
    }
    const ap = await assertAppointmentPatient(client, req.company.id, appointment_id, patient_id);
    if (!ap.ok) {
      return res.status(400).json({ error: ap.error });
    }

    const fee =
      service_fee !== undefined && service_fee !== null && service_fee !== ''
        ? Number(service_fee)
        : null;
    if (fee != null && (Number.isNaN(fee) || fee < 0)) {
      return res.status(400).json({ error: 'Invalid service_fee' });
    }

    const ins = await client.query(
      `INSERT INTO prescriptions (
         company_id, appointment_id, doctor_id, patient_id, medication_name, dosage, instructions, service_fee
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        req.company.id,
        appointment_id,
        doctor_id,
        patient_id,
        String(medication_name).slice(0, 255),
        dosage != null ? String(dosage).slice(0, 255) : null,
        instructions != null ? String(instructions) : null,
        fee,
      ]
    );
    const out = await client.query(
      `SELECT ${RX_SELECT}
       FROM prescriptions pr
       INNER JOIN patients p ON p.id = pr.patient_id AND p.company_id = pr.company_id
       INNER JOIN users u ON u.id = pr.doctor_id
       WHERE pr.id = $1`,
      [ins.rows[0].id]
    );
    return res.status(201).json({ prescription: out.rows[0] });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to create prescription' });
  } finally {
    client.release();
  }
});

router.put('/:id', async (req, res) => {
  const body = req.body || {};
  const actorRole = await getActorClinicalRole(req.company.id, req.user.id);

  const client = await pool.connect();
  try {
    const cur = await client.query(
      `SELECT * FROM prescriptions WHERE id = $1 AND company_id = $2`,
      [req.params.id, req.company.id]
    );
    if (!cur.rows.length) return res.status(404).json({ error: 'Not found' });
    const row = cur.rows[0];

    if (!mayMutatePrescriptionLab(actorRole, req.user.id, row.doctor_id)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    let nextDoctor = row.doctor_id;
    if (body.doctor_id !== undefined && body.doctor_id !== row.doctor_id) {
      if (actorRole !== 'owner' && actorRole !== 'admin') {
        return res.status(403).json({ error: 'Only admins may reassign prescribing doctor' });
      }
      if (!(await isCompanyDoctorOrOwner(client, req.company.id, body.doctor_id))) {
        return res.status(400).json({ error: 'Invalid doctor_id' });
      }
      nextDoctor = body.doctor_id;
    }

    let nextAppt = row.appointment_id;
    let nextPatient = row.patient_id;
    if (body.appointment_id !== undefined) nextAppt = body.appointment_id;
    if (body.patient_id !== undefined) nextPatient = body.patient_id;

    const ap = await assertAppointmentPatient(client, req.company.id, nextAppt, nextPatient);
    if (!ap.ok) return res.status(400).json({ error: ap.error });

    const nextMed =
      body.medication_name !== undefined
        ? String(body.medication_name).slice(0, 255)
        : row.medication_name;
    if (!nextMed) return res.status(400).json({ error: 'medication_name is required' });

    const nextDosage =
      body.dosage !== undefined ? (body.dosage != null ? String(body.dosage).slice(0, 255) : null) : row.dosage;
    const nextInstr =
      body.instructions !== undefined
        ? body.instructions != null
          ? String(body.instructions)
          : null
        : row.instructions;

    let nextFee = row.service_fee;
    if (body.service_fee !== undefined) {
      if (body.service_fee === null || body.service_fee === '') nextFee = null;
      else {
        const f = Number(body.service_fee);
        if (Number.isNaN(f) || f < 0) return res.status(400).json({ error: 'Invalid service_fee' });
        nextFee = f;
      }
    }

    await client.query(
      `UPDATE prescriptions
       SET appointment_id = $1, doctor_id = $2, patient_id = $3, medication_name = $4,
           dosage = $5, instructions = $6, service_fee = $7
       WHERE id = $8 AND company_id = $9`,
      [nextAppt, nextDoctor, nextPatient, nextMed, nextDosage, nextInstr, nextFee, req.params.id, req.company.id]
    );

    const out = await client.query(
      `SELECT ${RX_SELECT}
       FROM prescriptions pr
       INNER JOIN patients p ON p.id = pr.patient_id AND p.company_id = pr.company_id
       INNER JOIN users u ON u.id = pr.doctor_id
       WHERE pr.id = $1`,
      [req.params.id]
    );
    return res.json({ prescription: out.rows[0] });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to update prescription' });
  } finally {
    client.release();
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const cur = await pool.query(
      `SELECT doctor_id FROM prescriptions WHERE id = $1 AND company_id = $2`,
      [req.params.id, req.company.id]
    );
    if (!cur.rows.length) return res.status(404).json({ error: 'Not found' });
    const actorRole = await getActorClinicalRole(req.company.id, req.user.id);
    if (!mayMutatePrescriptionLab(actorRole, req.user.id, cur.rows[0].doctor_id)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    await pool.query(`DELETE FROM prescriptions WHERE id = $1 AND company_id = $2`, [
      req.params.id,
      req.company.id,
    ]);
    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to delete prescription' });
  }
});

export default router;
