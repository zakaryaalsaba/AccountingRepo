import { Router } from 'express';
import { query } from '../db.js';
import { authRequired } from '../middleware/auth.js';
import { companyContext } from '../middleware/companyContext.js';
import { attachAuthorization, requirePermission } from '../middleware/authorization.js';
import {
  journalEntryTemplatesSchemaHint,
  journalEntryTemplatesTableExists,
} from '../utils/journalTemplatesSchema.js';

const router = Router();
router.use(authRequired, companyContext);
router.use(attachAuthorization);

router.use(async (_req, res, next) => {
  if (await journalEntryTemplatesTableExists()) return next();
  return res.status(503).json({
    error: 'Journal entry templates schema not installed.',
    hint: journalEntryTemplatesSchemaHint(),
  });
});

router.get('/', async (req, res) => {
  try {
    const r = await query(
      `SELECT *
       FROM journal_entry_templates
       WHERE company_id = $1
       ORDER BY name ASC, created_at DESC`,
      [req.company.id]
    );
    return res.json({ templates: r.rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to list journal templates' });
  }
});

router.post('/', async (req, res) => {
  return requirePermission('transactions.create')(req, res, async () => {
    try {
      const { name, description = null, lines = [] } = req.body || {};
      if (!name || !String(name).trim()) {
        return res.status(400).json({ error: 'name is required' });
      }
      if (!Array.isArray(lines) || !lines.length) {
        return res.status(400).json({ error: 'lines must be a non-empty array' });
      }
      const normalized = lines.map((ln) => ({
        account_id: ln.account_id || null,
        debit: Number(ln.debit || 0),
        credit: Number(ln.credit || 0),
        note: ln.note ? String(ln.note) : null,
      }));
      const ins = await query(
        `INSERT INTO journal_entry_templates (
           company_id, name, description, lines_json, created_by
         )
         VALUES ($1,$2,$3,$4::jsonb,$5)
         RETURNING *`,
        [
          req.company.id,
          String(name).trim(),
          description ? String(description) : null,
          JSON.stringify(normalized),
          req.user.id,
        ]
      );
      return res.status(201).json({ template: ins.rows[0] });
    } catch (e) {
      if (e.code === '23505') {
        return res.status(409).json({ error: 'Template name already exists' });
      }
      console.error(e);
      return res.status(500).json({ error: 'Failed to create journal template' });
    }
  });
});

router.delete('/:id', async (req, res) => {
  return requirePermission('transactions.delete')(req, res, async () => {
    try {
      const del = await query(
        `DELETE FROM journal_entry_templates
         WHERE id = $1 AND company_id = $2
         RETURNING id`,
        [req.params.id, req.company.id]
      );
      if (!del.rows.length) return res.status(404).json({ error: 'Template not found' });
      return res.json({ ok: true });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Failed to delete journal template' });
    }
  });
});

export default router;
