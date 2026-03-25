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

const LAB_STATUSES = new Set(['ordered', 'completed', 'canceled']);

const LAB_SELECT = `lo.id, lo.company_id, lo.appointment_id, lo.doctor_id, lo.patient_id,
  lo.test_name, lo.instructions, lo.status::text, lo.results, lo.test_fee, lo.created_at,
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

/** Normalize client results payload for JSONB (object or string → stored as JSON). */
function normalizeResults(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'object') return value;
  return { text: String(value) };
}

router.get('/', async (req, res) => {
  const patientId = req.query.patient_id || null;
  const doctorId = req.query.doctor_id || null;
  try {
    const r = await pool.query(
      `SELECT ${LAB_SELECT}
       FROM lab_orders lo
       INNER JOIN patients p ON p.id = lo.patient_id AND p.company_id = lo.company_id
       INNER JOIN users u ON u.id = lo.doctor_id
       WHERE lo.company_id = $1
         AND ($2::uuid IS NULL OR lo.patient_id = $2)
         AND ($3::uuid IS NULL OR lo.doctor_id = $3)
       ORDER BY lo.created_at DESC`,
      [req.company.id, patientId, doctorId]
    );
    return res.json({ lab_orders: r.rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to list lab orders' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT ${LAB_SELECT}
       FROM lab_orders lo
       INNER JOIN patients p ON p.id = lo.patient_id AND p.company_id = lo.company_id
       INNER JOIN users u ON u.id = lo.doctor_id
       WHERE lo.id = $1 AND lo.company_id = $2`,
      [req.params.id, req.company.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    return res.json({ lab_order: r.rows[0] });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to load lab order' });
  }
});

router.post('/', async (req, res) => {
  const body = req.body || {};
  const { appointment_id, doctor_id, patient_id, test_name, instructions, status, test_fee, results } = body;

  if (!appointment_id || !doctor_id || !patient_id || !test_name) {
    return res.status(400).json({
      error: 'appointment_id, doctor_id, patient_id, and test_name are required',
    });
  }

  const st = status && LAB_STATUSES.has(status) ? status : 'ordered';
  const actorRole = await getActorClinicalRole(req.company.id, req.user.id);
  if (!mayCreatePrescriptionLab(actorRole, req.user.id, doctor_id)) {
    return res.status(403).json({ error: 'Only company admins/owners or the ordering doctor may create' });
  }

  const client = await pool.connect();
  try {
    if (!(await isCompanyDoctorOrOwner(client, req.company.id, doctor_id))) {
      return res.status(400).json({ error: 'doctor_id must be a company doctor or owner' });
    }
    const ap = await assertAppointmentPatient(client, req.company.id, appointment_id, patient_id);
    if (!ap.ok) return res.status(400).json({ error: ap.error });

    const fee =
      test_fee !== undefined && test_fee !== null && test_fee !== '' ? Number(test_fee) : null;
    if (fee != null && (Number.isNaN(fee) || fee < 0)) {
      return res.status(400).json({ error: 'Invalid test_fee' });
    }

    const resJson = normalizeResults(results);

    const ins = await client.query(
      `INSERT INTO lab_orders (
         company_id, appointment_id, doctor_id, patient_id, test_name, instructions, status, results, test_fee
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7::lab_order_status, $8::jsonb, $9)
       RETURNING id`,
      [
        req.company.id,
        appointment_id,
        doctor_id,
        patient_id,
        String(test_name).slice(0, 255),
        instructions != null ? String(instructions) : null,
        st,
        resJson ? JSON.stringify(resJson) : null,
        fee,
      ]
    );
    const out = await client.query(
      `SELECT ${LAB_SELECT}
       FROM lab_orders lo
       INNER JOIN patients p ON p.id = lo.patient_id AND p.company_id = lo.company_id
       INNER JOIN users u ON u.id = lo.doctor_id
       WHERE lo.id = $1`,
      [ins.rows[0].id]
    );
    return res.status(201).json({ lab_order: out.rows[0] });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to create lab order' });
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
      `SELECT * FROM lab_orders WHERE id = $1 AND company_id = $2`,
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
        return res.status(403).json({ error: 'Only admins may reassign ordering doctor' });
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

    let nextStatus = row.status;
    if (body.status !== undefined) {
      if (!LAB_STATUSES.has(body.status)) return res.status(400).json({ error: 'Invalid status' });
      nextStatus = body.status;
    }

    const nextName =
      body.test_name !== undefined ? String(body.test_name).slice(0, 255) : row.test_name;
    if (!nextName) return res.status(400).json({ error: 'test_name is required' });

    const nextInstr =
      body.instructions !== undefined
        ? body.instructions != null
          ? String(body.instructions)
          : null
        : row.instructions;

    let nextResults = row.results;
    if (body.results !== undefined) {
      nextResults = normalizeResults(body.results);
    }

    let nextFee = row.test_fee;
    if (body.test_fee !== undefined) {
      if (body.test_fee === null || body.test_fee === '') nextFee = null;
      else {
        const f = Number(body.test_fee);
        if (Number.isNaN(f) || f < 0) return res.status(400).json({ error: 'Invalid test_fee' });
        nextFee = f;
      }
    }

    await client.query(
      `UPDATE lab_orders
       SET appointment_id = $1, doctor_id = $2, patient_id = $3, test_name = $4,
           instructions = $5, status = $6::lab_order_status, results = $7::jsonb, test_fee = $8
       WHERE id = $9 AND company_id = $10`,
      [
        nextAppt,
        nextDoctor,
        nextPatient,
        nextName,
        nextInstr,
        nextStatus,
        nextResults ? JSON.stringify(nextResults) : null,
        nextFee,
        req.params.id,
        req.company.id,
      ]
    );

    const out = await client.query(
      `SELECT ${LAB_SELECT}
       FROM lab_orders lo
       INNER JOIN patients p ON p.id = lo.patient_id AND p.company_id = lo.company_id
       INNER JOIN users u ON u.id = lo.doctor_id
       WHERE lo.id = $1`,
      [req.params.id]
    );
    return res.json({ lab_order: out.rows[0] });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to update lab order' });
  } finally {
    client.release();
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const cur = await pool.query(
      `SELECT doctor_id FROM lab_orders WHERE id = $1 AND company_id = $2`,
      [req.params.id, req.company.id]
    );
    if (!cur.rows.length) return res.status(404).json({ error: 'Not found' });
    const actorRole = await getActorClinicalRole(req.company.id, req.user.id);
    if (!mayMutatePrescriptionLab(actorRole, req.user.id, cur.rows[0].doctor_id)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    await pool.query(`DELETE FROM lab_orders WHERE id = $1 AND company_id = $2`, [
      req.params.id,
      req.company.id,
    ]);
    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to delete lab order' });
  }
});

export default router;
