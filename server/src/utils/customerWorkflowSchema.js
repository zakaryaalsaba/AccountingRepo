import { pool } from '../db.js';

let cachedReminderTable = null;

export async function customerRemindersTableExists() {
  if (cachedReminderTable !== null) return cachedReminderTable;
  try {
    const r = await pool.query(
      `SELECT 1
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = 'customer_reminders'
       LIMIT 1`
    );
    cachedReminderTable = r.rows.length > 0;
    return cachedReminderTable;
  } catch {
    cachedReminderTable = false;
    return false;
  }
}

export function customerWorkflowSchemaHint() {
  return 'Run: psql $DATABASE_URL -f database/migrations/022_customer_statements_reminders.sql';
}

