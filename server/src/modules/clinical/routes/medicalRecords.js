import { Router } from 'express';
import { pool } from '../../../db.js';
import { authRequired } from '../../../middleware/auth.js';
import { companyContext } from '../../../middleware/companyContext.js';

const router = Router();
router.use(authRequired, companyContext);

router.get('/', async (req, res) => {
  const patientId = req.query.patient_id;
  if (!patientId) {
    return res.status(400).json({ error: 'Query parameter patient_id is required' });
  }
  try {
    const ok = await pool.query(
      `SELECT 1 FROM patients WHERE id = $1 AND company_id = $2`,
      [patientId, req.company.id]
    );
    if (!ok.rows.length) return res.status(404).json({ error: 'Patient not found' });

    const r = await pool.query(
      `SELECT id, company_id, patient_id, diagnosis, treatment, notes, created_at
       FROM medical_records
       WHERE company_id = $1 AND patient_id = $2
       ORDER BY created_at DESC`,
      [req.company.id, patientId]
    );
    return res.json({ medical_records: r.rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to list medical records' });
  }
});

router.post('/', async (req, res) => {
  const { patient_id, diagnosis, treatment, notes } = req.body || {};
  if (!patient_id) return res.status(400).json({ error: 'patient_id is required' });
  try {
    const ok = await pool.query(
      `SELECT 1 FROM patients WHERE id = $1 AND company_id = $2`,
      [patient_id, req.company.id]
    );
    if (!ok.rows.length) return res.status(400).json({ error: 'Invalid patient_id' });

    const r = await pool.query(
      `INSERT INTO medical_records (company_id, patient_id, diagnosis, treatment, notes)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, company_id, patient_id, diagnosis, treatment, notes, created_at`,
      [
        req.company.id,
        patient_id,
        diagnosis != null ? String(diagnosis) : null,
        treatment != null ? String(treatment) : null,
        notes != null ? String(notes) : null,
      ]
    );
    return res.status(201).json({ medical_record: r.rows[0] });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to create medical record' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const r = await pool.query(
      `DELETE FROM medical_records WHERE id = $1 AND company_id = $2 RETURNING id`,
      [req.params.id, req.company.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to delete medical record' });
  }
});

export default router;
