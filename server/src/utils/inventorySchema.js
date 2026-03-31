import { pool } from '../db.js';

let cachedInventoryTables = null;

export async function inventoryTablesExist() {
  if (cachedInventoryTables !== null) return cachedInventoryTables;
  try {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS c
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN ('inventory_items', 'inventory_movements', 'inventory_fifo_layers')`
    );
    cachedInventoryTables = r.rows[0].c === 3;
    return cachedInventoryTables;
  } catch {
    cachedInventoryTables = false;
    return false;
  }
}

export function inventorySchemaHint() {
  return 'Run: psql $DATABASE_URL -f database/migrations/013_inventory_accounting.sql';
}

