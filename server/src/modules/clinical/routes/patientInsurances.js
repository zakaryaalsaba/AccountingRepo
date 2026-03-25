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
      `SELECT pi.id, pi.company_id, pi.patient_id, pi.provider_id, pi.policy_number,
              pi.coverage_percentage, pi.is_primary, pi.created_at,
              pr.name AS provider_name
       FROM patient_insurances pi
       INNER JOIN insurance_providers pr
         ON pr.id = pi.provider_id AND pr.company_id = pi.company_id
       WHERE pi.company_id = $1 AND pi.patient_id = $2
       ORDER BY pi.is_primary DESC, pr.name ASC`,
      [req.company.id, patientId]
    );
    return res.json({ patient_insurances: r.rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to list patient insurances' });
  }
});

router.post('/', async (req, res) => {
  const { patient_id, provider_id, policy_number, coverage_percentage, is_primary } = req.body || {};
  if (!patient_id || !provider_id) {
    return res.status(400).json({ error: 'patient_id and provider_id are required' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const pOk = await client.query(
      `SELECT 1 FROM patients WHERE id = $1 AND company_id = $2`,
      [patient_id, req.company.id]
    );
    const prOk = await client.query(
      `SELECT 1 FROM insurance_providers WHERE id = $1 AND company_id = $2`,
      [provider_id, req.company.id]
    );
    if (!pOk.rows.length || !prOk.rows.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Invalid patient_id or provider_id' });
    }

    const primary = Boolean(is_primary);
    if (primary) {
      await client.query(
        `UPDATE patient_insurances SET is_primary = FALSE
         WHERE company_id = $1 AND patient_id = $2`,
        [req.company.id, patient_id]
      );
    }

    const cov =
      coverage_percentage !== undefined && coverage_percentage !== null && coverage_percentage !== ''
        ? Number(coverage_percentage)
        : null;
    if (cov != null && (Number.isNaN(cov) || cov < 0 || cov > 100)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'coverage_percentage must be between 0 and 100' });
    }

    const r = await client.query(
      `INSERT INTO patient_insurances (
         company_id, patient_id, provider_id, policy_number, coverage_percentage, is_primary
       )
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, company_id, patient_id, provider_id, policy_number, coverage_percentage, is_primary, created_at`,
      [
        req.company.id,
        patient_id,
        provider_id,
        policy_number != null ? String(policy_number).slice(0, 100) : null,
        cov,
        primary,
      ]
    );
    const row = r.rows[0];
    const pn = await client.query(`SELECT name FROM insurance_providers WHERE id = $1`, [provider_id]);
    await client.query('COMMIT');
    return res.status(201).json({
      patient_insurance: { ...row, provider_name: pn.rows[0]?.name },
    });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    return res.status(500).json({ error: 'Failed to create patient insurance' });
  } finally {
    client.release();
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const r = await pool.query(
      `DELETE FROM patient_insurances WHERE id = $1 AND company_id = $2 RETURNING id`,
      [req.params.id, req.company.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to delete patient insurance' });
  }
});

export default router;
