import { Router } from 'express';
import { pool } from '../../../db.js';
import { authRequired } from '../../../middleware/auth.js';
import { companyContext } from '../../../middleware/companyContext.js';

const router = Router();
router.use(authRequired, companyContext);

const PATIENT_SELECT = `id, company_id, full_name, phone, email, date_of_birth, blood_group, gender::text, notes,
  blood_pressure, heart_rate, spo2, temperature_c, respiratory_rate, weight_kg, created_at`;

function optTrim(v, maxLen) {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  return String(v).trim().slice(0, maxLen);
}

/** undefined = omit (keep DB), null = clear */
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

function validateVitals(body, forError) {
  const { heart_rate, spo2, respiratory_rate, temperature_c, weight_kg } = body || {};
  if (heart_rate != null && heart_rate !== '' && (Number(heart_rate) < 0 || Number(heart_rate) > 400)) {
    return forError('heart_rate out of range');
  }
  if (spo2 != null && spo2 !== '' && (Number(spo2) < 0 || Number(spo2) > 100)) {
    return forError('spo2 must be 0–100');
  }
  if (respiratory_rate != null && respiratory_rate !== '' && (Number(respiratory_rate) < 0 || Number(respiratory_rate) > 120)) {
    return forError('respiratory_rate out of range');
  }
  if (temperature_c != null && temperature_c !== '' && (Number(temperature_c) < 30 || Number(temperature_c) > 45)) {
    return forError('temperature_c out of plausible range');
  }
  if (weight_kg != null && weight_kg !== '' && (Number(weight_kg) < 0 || Number(weight_kg) > 500)) {
    return forError('weight_kg out of range');
  }
  return null;
}

router.get('/', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT ${PATIENT_SELECT}
       FROM patients
       WHERE company_id = $1
       ORDER BY full_name ASC`,
      [req.company.id]
    );
    return res.json({ patients: r.rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to list patients' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT ${PATIENT_SELECT}
       FROM patients
       WHERE id = $1 AND company_id = $2`,
      [req.params.id, req.company.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    return res.json({ patient: r.rows[0] });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to load patient' });
  }
});

router.post('/', async (req, res) => {
  const body = req.body || {};
  const { full_name, phone, date_of_birth, gender, notes } = body;
  const ve = validateVitals(body, (m) => m);
  if (ve) return res.status(400).json({ error: ve });

  if (!full_name || !String(full_name).trim()) {
    return res.status(400).json({ error: 'full_name is required' });
  }
  if (gender != null && gender !== '' && gender !== 'male' && gender !== 'female') {
    return res.status(400).json({ error: 'gender must be male or female' });
  }

  const email = optTrim(body.email ?? null, 255);
  const blood_group = optTrim(body.blood_group ?? null, 30);
  const blood_pressure = optTrim(body.blood_pressure ?? null, 30);
  const heart_rate = optSmallInt(body.heart_rate ?? null);
  const spo2 = optSmallInt(body.spo2 ?? null);
  const temperature_c = optDecimal(body.temperature_c ?? null);
  const respiratory_rate = optSmallInt(body.respiratory_rate ?? null);
  const weight_kg = optDecimal(body.weight_kg ?? null);

  try {
    const r = await pool.query(
      `INSERT INTO patients (
         company_id, full_name, phone, email, date_of_birth, blood_group, gender, notes,
         blood_pressure, heart_rate, spo2, temperature_c, respiratory_rate, weight_kg
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7::patient_gender, $8, $9, $10, $11, $12, $13, $14)
       RETURNING ${PATIENT_SELECT}`,
      [
        req.company.id,
        String(full_name).trim(),
        phone != null ? String(phone).slice(0, 50) : null,
        email,
        date_of_birth || null,
        blood_group,
        gender || null,
        notes != null ? String(notes) : null,
        blood_pressure,
        heart_rate,
        spo2,
        temperature_c,
        respiratory_rate,
        weight_kg,
      ]
    );
    return res.status(201).json({ patient: r.rows[0] });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to create patient' });
  }
});

router.put('/:id', async (req, res) => {
  const body = req.body || {};
  const ve = validateVitals(body, (m) => m);
  if (ve) return res.status(400).json({ error: ve });

  if (body.gender != null && body.gender !== '' && body.gender !== 'male' && body.gender !== 'female') {
    return res.status(400).json({ error: 'gender must be male or female' });
  }

  try {
    const cur = await pool.query(
      `SELECT * FROM patients WHERE id = $1 AND company_id = $2`,
      [req.params.id, req.company.id]
    );
    if (!cur.rows.length) return res.status(404).json({ error: 'Not found' });
    const row = cur.rows[0];

    const nextName = body.full_name !== undefined ? String(body.full_name).trim() : row.full_name;
    if (!nextName) return res.status(400).json({ error: 'full_name is required' });

    const nextPhone =
      body.phone !== undefined ? (body.phone != null && body.phone !== '' ? String(body.phone).slice(0, 50) : null) : row.phone;
    const nextEmail = body.email !== undefined ? optTrim(body.email, 255) : row.email;
    const nextDob = body.date_of_birth !== undefined ? body.date_of_birth || null : row.date_of_birth;
    const nextBloodGroup = body.blood_group !== undefined ? optTrim(body.blood_group, 30) : row.blood_group;
    const nextGender = body.gender !== undefined ? body.gender || null : row.gender;
    const nextNotes = body.notes !== undefined ? (body.notes != null ? String(body.notes) : null) : row.notes;

    const nextBp = body.blood_pressure !== undefined ? optTrim(body.blood_pressure, 30) : row.blood_pressure;
    const nextHr = body.heart_rate !== undefined ? optSmallInt(body.heart_rate) : row.heart_rate;
    const nextSpo2 = body.spo2 !== undefined ? optSmallInt(body.spo2) : row.spo2;
    const nextTemp =
      body.temperature_c !== undefined ? optDecimal(body.temperature_c) : row.temperature_c;
    const nextRr =
      body.respiratory_rate !== undefined ? optSmallInt(body.respiratory_rate) : row.respiratory_rate;
    const nextW =
      body.weight_kg !== undefined ? optDecimal(body.weight_kg) : row.weight_kg;

    const r = await pool.query(
      `UPDATE patients
       SET full_name = $1, phone = $2, email = $3, date_of_birth = $4, blood_group = $5,
           gender = $6::patient_gender, notes = $7,
           blood_pressure = $8, heart_rate = $9, spo2 = $10, temperature_c = $11,
           respiratory_rate = $12, weight_kg = $13
       WHERE id = $14 AND company_id = $15
       RETURNING ${PATIENT_SELECT}`,
      [
        nextName,
        nextPhone,
        nextEmail,
        nextDob,
        nextBloodGroup,
        nextGender,
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
    return res.json({ patient: r.rows[0] });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to update patient' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const r = await pool.query(
      `DELETE FROM patients WHERE id = $1 AND company_id = $2 RETURNING id`,
      [req.params.id, req.company.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to delete patient' });
  }
});

export default router;
