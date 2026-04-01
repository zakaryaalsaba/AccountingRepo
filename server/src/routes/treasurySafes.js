import { Router } from 'express';
import { pool, query } from '../db.js';
import { authRequired } from '../middleware/auth.js';
import { companyContext } from '../middleware/companyContext.js';
import { writeAuditEvent } from '../utils/auditLog.js';

const router = Router();
router.use(authRequired, companyContext);

router.get('/', async (req, res) => {
  try {
    const r = await query(
      `SELECT *
       FROM treasury_safes
       WHERE company_id = $1
       ORDER BY created_at DESC`,
      [req.company.id]
    );
    return res.json({ safes: r.rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to list treasury safes' });
  }
});

router.post('/', async (req, res) => {
  try {
    const {
      name,
      code,
      currency_code,
      gl_account_id,
      opening_balance,
      opening_date,
      opening_reference,
      custodian_name,
      location_text,
      is_active = true,
    } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' });
    const ins = await query(
      `INSERT INTO treasury_safes (
         company_id, name, code, currency_code, gl_account_id, opening_balance, opening_date,
         opening_reference, custodian_name, location_text, is_active
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [
        req.company.id,
        String(name).trim(),
        code ? String(code).trim() : null,
        currency_code ? String(currency_code).trim().toUpperCase() : 'SAR',
        gl_account_id || null,
        Number(opening_balance || 0),
        opening_date || null,
        opening_reference ? String(opening_reference).trim() : null,
        custodian_name ? String(custodian_name).trim() : null,
        location_text ? String(location_text).trim() : null,
        Boolean(is_active),
      ]
    );
    return res.status(201).json({ safe: ins.rows[0] });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to create treasury safe' });
  }
});

router.patch('/:id', async (req, res) => {
  try {
    const cur = await query(
      `SELECT * FROM treasury_safes WHERE id = $1 AND company_id = $2`,
      [req.params.id, req.company.id]
    );
    if (!cur.rows.length) return res.status(404).json({ error: 'Safe not found' });
    const row = cur.rows[0];
    const b = req.body || {};
    const up = await query(
      `UPDATE treasury_safes
       SET name = $1,
           code = $2,
           currency_code = $3,
           gl_account_id = $4,
           opening_balance = $5,
           opening_date = $6,
           opening_reference = $7,
           custodian_name = $8,
           location_text = $9,
           is_active = $10,
           updated_at = NOW()
       WHERE id = $11 AND company_id = $12
       RETURNING *`,
      [
        b.name !== undefined ? String(b.name).trim() : row.name,
        b.code !== undefined ? (b.code ? String(b.code).trim() : null) : row.code,
        b.currency_code !== undefined ? String(b.currency_code).trim().toUpperCase() : row.currency_code,
        b.gl_account_id !== undefined ? (b.gl_account_id || null) : row.gl_account_id,
        b.opening_balance !== undefined ? Number(b.opening_balance) : row.opening_balance,
        b.opening_date !== undefined ? (b.opening_date || null) : row.opening_date,
        b.opening_reference !== undefined ? (b.opening_reference ? String(b.opening_reference).trim() : null) : row.opening_reference,
        b.custodian_name !== undefined ? (b.custodian_name ? String(b.custodian_name).trim() : null) : row.custodian_name,
        b.location_text !== undefined ? (b.location_text ? String(b.location_text).trim() : null) : row.location_text,
        b.is_active !== undefined ? Boolean(b.is_active) : row.is_active,
        req.params.id,
        req.company.id,
      ]
    );
    return res.json({ safe: up.rows[0] });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to update treasury safe' });
  }
});

router.post('/:id/opening-balance/post', async (req, res) => {
  const client = await pool.connect();
  try {
    const { entry_date, offset_account_id } = req.body || {};
    if (!entry_date || !offset_account_id) {
      return res.status(400).json({ error: 'entry_date and offset_account_id are required' });
    }
    await client.query('BEGIN');
    const s = await client.query(
      `SELECT * FROM treasury_safes WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [req.params.id, req.company.id]
    );
    if (!s.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Safe not found' });
    }
    const safe = s.rows[0];
    if (!safe.gl_account_id) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Safe GL account is required before posting opening balance' });
    }
    const amt = Number(safe.opening_balance || 0);
    if (amt === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Opening balance is zero' });
    }
    const tx = await client.query(
      `INSERT INTO transactions (company_id, entry_date, description, reference)
       VALUES ($1,$2,$3,$4)
       RETURNING *`,
      [req.company.id, entry_date, `Opening balance - safe ${safe.name}`, safe.opening_reference || `SAFE-OPEN-${safe.id.slice(0, 8)}`]
    );
    if (amt > 0) {
      await client.query(
        `INSERT INTO transaction_lines (transaction_id, account_id, debit, credit)
         VALUES ($1,$2,$3,0),($1,$4,0,$3)`,
        [tx.rows[0].id, safe.gl_account_id, Math.abs(amt), offset_account_id]
      );
    } else {
      await client.query(
        `INSERT INTO transaction_lines (transaction_id, account_id, debit, credit)
         VALUES ($1,$2,0,$3),($1,$4,$3,0)`,
        [tx.rows[0].id, safe.gl_account_id, Math.abs(amt), offset_account_id]
      );
    }
    await client.query('COMMIT');
    await writeAuditEvent({
      companyId: req.company.id,
      actorUserId: req.user.id,
      eventType: 'treasury_safe.opening_balance_posted',
      entityType: 'treasury_safe',
      entityId: safe.id,
      details: { transaction_id: tx.rows[0].id, entry_date },
    });
    return res.status(201).json({ transaction: tx.rows[0] });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    return res.status(500).json({ error: 'Failed to post safe opening balance' });
  } finally {
    client.release();
  }
});

export default router;
