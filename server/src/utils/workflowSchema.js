import { query } from '../db.js';

let cache = null;

export async function workflowTablesExist() {
  if (cache !== null) return cache;
  const r = await query(
    `SELECT COUNT(*)::int AS c
     FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name IN (
         'workflow_approval_rules',
         'role_action_limits',
         'workflow_approval_requests',
         'workflow_entity_locks',
         'approval_notifications'
       )`
  );
  cache = r.rows[0]?.c === 5;
  return cache;
}

export function workflowSchemaHint() {
  return 'Run: psql $DATABASE_URL -f database/migrations/034_workflow_controls.sql';
}
