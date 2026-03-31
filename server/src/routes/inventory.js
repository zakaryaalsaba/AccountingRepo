import { Router } from 'express';
import { pool, query } from '../db.js';
import { authRequired } from '../middleware/auth.js';
import { companyContext } from '../middleware/companyContext.js';
import { assertDateOpen } from '../utils/periodLocks.js';
import { inventorySchemaHint, inventoryTablesExist } from '../utils/inventorySchema.js';

const router = Router();
router.use(authRequired, companyContext);

const IN_CODE = new Set(['purchase', 'adjust_in']);
const OUT_CODE = new Set(['sale', 'adjust_out']);

function r4(n) {
  return Math.round(Number(n) * 10000) / 10000;
}
function r6(n) {
  return Math.round(Number(n) * 1000000) / 1000000;
}

router.use(async (_req, res, next) => {
  if (!(await inventoryTablesExist())) {
    return res.status(503).json({ error: 'Inventory schema not installed.', hint: inventorySchemaHint() });
  }
  return next();
});

router.get('/items', async (req, res) => {
  try {
    const r = await query(
      `SELECT *
       FROM inventory_items
       WHERE company_id = $1
       ORDER BY name ASC`,
      [req.company.id]
    );
    return res.json({ items: r.rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to list inventory items' });
  }
});

router.post('/items', async (req, res) => {
  try {
    const {
      sku,
      name,
      unit = 'unit',
      inventory_account_id,
      cogs_account_id,
      revenue_account_id = null,
      valuation_method = 'average',
      tracking_method = 'perpetual',
    } = req.body || {};
    if (!name || !inventory_account_id || !cogs_account_id) {
      return res.status(400).json({ error: 'name, inventory_account_id, cogs_account_id are required' });
    }
    const acc = await query(
      `SELECT id
       FROM accounts
       WHERE company_id = $1 AND is_active = TRUE AND id = ANY($2::uuid[])`,
      [req.company.id, [inventory_account_id, cogs_account_id, revenue_account_id].filter(Boolean)]
    );
    if (acc.rows.length !== [inventory_account_id, cogs_account_id, revenue_account_id].filter(Boolean).length) {
      return res.status(400).json({ error: 'One or more inventory accounts are invalid' });
    }
    const ins = await query(
      `INSERT INTO inventory_items (
         company_id, sku, name, unit, inventory_account_id, cogs_account_id, revenue_account_id,
         valuation_method, tracking_method
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::inventory_valuation_method,$9::inventory_tracking_method)
       RETURNING *`,
      [
        req.company.id,
        sku ? String(sku).trim() : null,
        String(name).trim(),
        String(unit || 'unit').trim(),
        inventory_account_id,
        cogs_account_id,
        revenue_account_id,
        valuation_method,
        tracking_method,
      ]
    );
    return res.status(201).json({ item: ins.rows[0] });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to create inventory item' });
  }
});

router.patch('/items/:id', async (req, res) => {
  try {
    const cur = await query(
      `SELECT * FROM inventory_items WHERE id = $1 AND company_id = $2`,
      [req.params.id, req.company.id]
    );
    if (!cur.rows.length) return res.status(404).json({ error: 'Not found' });
    const row = cur.rows[0];
    const b = req.body || {};
    const upd = await query(
      `UPDATE inventory_items
       SET name = $1,
           unit = $2,
           valuation_method = $3::inventory_valuation_method,
           tracking_method = $4::inventory_tracking_method,
           is_active = $5,
           updated_at = NOW()
       WHERE id = $6 AND company_id = $7
       RETURNING *`,
      [
        b.name !== undefined ? String(b.name).trim() : row.name,
        b.unit !== undefined ? String(b.unit).trim() : row.unit,
        b.valuation_method !== undefined ? b.valuation_method : row.valuation_method,
        b.tracking_method !== undefined ? b.tracking_method : row.tracking_method,
        b.is_active !== undefined ? Boolean(b.is_active) : row.is_active,
        req.params.id,
        req.company.id,
      ]
    );
    return res.json({ item: upd.rows[0] });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to update inventory item' });
  }
});

router.get('/movements', async (req, res) => {
  try {
    const { item_id } = req.query;
    const params = [req.company.id];
    let sql = `SELECT m.*, i.sku, i.name
               FROM inventory_movements m
               JOIN inventory_items i ON i.id = m.item_id
               WHERE m.company_id = $1`;
    if (item_id) {
      params.push(item_id);
      sql += ` AND m.item_id = $2`;
    }
    sql += ` ORDER BY m.movement_date DESC, m.created_at DESC`;
    const r = await query(sql, params);
    return res.json({ movements: r.rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to list inventory movements' });
  }
});

router.post('/movements', async (req, res) => {
  const { item_id, movement_type, movement_date, quantity, unit_cost, reference, note } = req.body || {};
  const qty = r4(quantity);
  if (!item_id || !movement_type || !movement_date || !qty || qty <= 0) {
    return res.status(400).json({ error: 'item_id, movement_type, movement_date, positive quantity required' });
  }
  const client = await pool.connect();
  try {
    await assertDateOpen(req.company.id, movement_date, client);
    await client.query('BEGIN');
    const itemRes = await client.query(
      `SELECT * FROM inventory_items WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [item_id, req.company.id]
    );
    if (!itemRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Inventory item not found' });
    }
    const item = itemRes.rows[0];
    const inbound = IN_CODE.has(movement_type);
    const outbound = OUT_CODE.has(movement_type);
    if (!inbound && !outbound) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Invalid movement_type' });
    }
    if (inbound && (!unit_cost || Number(unit_cost) <= 0)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Inbound movements require positive unit_cost' });
    }
    if (outbound && Number(item.on_hand_qty) < qty) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Insufficient stock quantity' });
    }

    let effectiveCost = 0;
    if (inbound) {
      effectiveCost = r6(unit_cost);
    } else if (item.valuation_method === 'average') {
      effectiveCost = r6(item.avg_cost);
    } else {
      let remaining = qty;
      let totalCost = 0;
      const layers = await client.query(
        `SELECT *
         FROM inventory_fifo_layers
         WHERE company_id = $1 AND item_id = $2 AND remaining_qty > 0
         ORDER BY layer_date ASC, created_at ASC
         FOR UPDATE`,
        [req.company.id, item.id]
      );
      for (const layer of layers.rows) {
        if (remaining <= 0) break;
        const take = Math.min(Number(layer.remaining_qty), remaining);
        totalCost += take * Number(layer.unit_cost);
        remaining -= take;
        await client.query(
          `UPDATE inventory_fifo_layers
           SET remaining_qty = $1
           WHERE id = $2 AND company_id = $3`,
          [r4(Number(layer.remaining_qty) - take), layer.id, req.company.id]
        );
      }
      if (remaining > 0.0001) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'FIFO layers are insufficient for this stock-out' });
      }
      effectiveCost = r6(totalCost / qty);
    }

    const mov = await client.query(
      `INSERT INTO inventory_movements (
         company_id, item_id, movement_type, movement_date, quantity, unit_cost, reference, note
       )
       VALUES ($1,$2,$3::inventory_movement_type,$4::date,$5,$6,$7,$8)
       RETURNING *`,
      [
        req.company.id,
        item.id,
        movement_type,
        movement_date,
        qty,
        effectiveCost > 0 ? effectiveCost : null,
        reference ? String(reference).trim() : null,
        note ? String(note) : null,
      ]
    );
    const movement = mov.rows[0];

    if (inbound && item.valuation_method === 'fifo') {
      await client.query(
        `INSERT INTO inventory_fifo_layers (company_id, item_id, source_movement_id, layer_date, remaining_qty, unit_cost)
         VALUES ($1,$2,$3,$4::date,$5,$6)`,
        [req.company.id, item.id, movement.id, movement_date, qty, effectiveCost]
      );
    }

    const signedQty = inbound ? qty : -qty;
    const newQty = r4(Number(item.on_hand_qty) + signedQty);
    let newAvg = Number(item.avg_cost);
    if (item.valuation_method === 'average') {
      if (inbound) {
        const oldValue = Number(item.on_hand_qty) * Number(item.avg_cost);
        const addValue = qty * effectiveCost;
        newAvg = newQty > 0 ? r6((oldValue + addValue) / newQty) : 0;
      } else if (newQty <= 0) {
        newAvg = 0;
      }
    }
    await client.query(
      `UPDATE inventory_items
       SET on_hand_qty = $1, avg_cost = $2, updated_at = NOW()
       WHERE id = $3 AND company_id = $4`,
      [newQty, newAvg, item.id, req.company.id]
    );

    let cogsTxId = null;
    if (movement_type === 'sale' && item.tracking_method === 'perpetual') {
      const totalCost = r6(qty * effectiveCost);
      if (totalCost > 0) {
        const tx = await client.query(
          `INSERT INTO transactions (company_id, entry_date, description, reference)
           VALUES ($1,$2::date,$3,$4) RETURNING id`,
          [
            req.company.id,
            movement_date,
            `COGS for ${item.name}`,
            `INV-COGS-${movement.id.slice(0, 8)}`,
          ]
        );
        cogsTxId = tx.rows[0].id;
        await client.query(
          `INSERT INTO transaction_lines (transaction_id, account_id, debit, credit) VALUES ($1,$2,$3,0)`,
          [cogsTxId, item.cogs_account_id, totalCost]
        );
        await client.query(
          `INSERT INTO transaction_lines (transaction_id, account_id, debit, credit) VALUES ($1,$2,0,$3)`,
          [cogsTxId, item.inventory_account_id, totalCost]
        );
        await client.query(
          `UPDATE inventory_movements
           SET transaction_id = $1
           WHERE id = $2 AND company_id = $3`,
          [cogsTxId, movement.id, req.company.id]
        );
      }
    }

    const out = await client.query(`SELECT * FROM inventory_items WHERE id = $1 AND company_id = $2`, [
      item.id,
      req.company.id,
    ]);
    await client.query('COMMIT');
    return res.status(201).json({ movement: { ...movement, transaction_id: cogsTxId }, item: out.rows[0] });
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.status === 400) return res.status(400).json({ error: e.message });
    console.error(e);
    return res.status(500).json({ error: 'Failed to post inventory movement' });
  } finally {
    client.release();
  }
});

router.get('/valuation', async (req, res) => {
  try {
    const items = await query(
      `SELECT *
       FROM inventory_items
       WHERE company_id = $1 AND is_active = TRUE
       ORDER BY name ASC`,
      [req.company.id]
    );
    const lines = [];
    let total = 0;
    for (const item of items.rows) {
      let unitCost = Number(item.avg_cost);
      if (item.valuation_method === 'fifo') {
        const l = await query(
          `SELECT COALESCE(SUM(remaining_qty * unit_cost), 0)::numeric(18,6) AS total_value,
                  COALESCE(SUM(remaining_qty), 0)::numeric(18,4) AS total_qty
           FROM inventory_fifo_layers
           WHERE company_id = $1 AND item_id = $2`,
          [req.company.id, item.id]
        );
        const qty = Number(l.rows[0].total_qty);
        unitCost = qty > 0 ? Number(l.rows[0].total_value) / qty : 0;
      }
      const value = r6(Number(item.on_hand_qty) * unitCost);
      total += value;
      lines.push({
        item_id: item.id,
        sku: item.sku,
        name: item.name,
        valuation_method: item.valuation_method,
        quantity: r4(item.on_hand_qty),
        unit_cost: r6(unitCost),
        value,
      });
    }
    return res.json({ total_value: r6(total), lines });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to build inventory valuation report' });
  }
});

export default router;

