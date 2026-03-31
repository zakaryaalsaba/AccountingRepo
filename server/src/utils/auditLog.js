import { query } from '../db.js';
import { auditTablesExist } from './auditSchema.js';

export async function writeAuditEvent({
  companyId,
  actorUserId = null,
  eventType,
  entityType,
  entityId = null,
  details = {},
}) {
  if (!(await auditTablesExist())) return;
  await query(
    `INSERT INTO audit_events (company_id, actor_user_id, event_type, entity_type, entity_id, details)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
    [companyId, actorUserId, eventType, entityType, entityId, JSON.stringify(details || {})]
  );
}

