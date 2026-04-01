-- Workflow controls, approvals, role limits, notifications

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'workflow_approval_status') THEN
    CREATE TYPE workflow_approval_status AS ENUM ('pending', 'approved', 'rejected');
  END IF;
END$$;

CREATE TABLE IF NOT EXISTS workflow_approval_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  doc_type VARCHAR(80) NOT NULL,
  min_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  approver_roles JSONB NOT NULL DEFAULT '["owner","admin"]'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_workflow_approval_rules_company_doc
  ON workflow_approval_rules (company_id, doc_type, is_active, min_amount DESC);

CREATE TABLE IF NOT EXISTS role_action_limits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  role VARCHAR(40) NOT NULL,
  action_key VARCHAR(120) NOT NULL,
  max_amount NUMERIC(18,2) NOT NULL CHECK (max_amount >= 0),
  created_by UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, role, action_key)
);

CREATE TABLE IF NOT EXISTS workflow_approval_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  doc_type VARCHAR(80) NOT NULL,
  entity_id VARCHAR(120) NOT NULL,
  amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  status workflow_approval_status NOT NULL DEFAULT 'pending',
  requested_by UUID REFERENCES users (id) ON DELETE SET NULL,
  approved_by UUID REFERENCES users (id) ON DELETE SET NULL,
  note TEXT,
  attachment_reference TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_workflow_approval_requests_company_doc_entity
  ON workflow_approval_requests (company_id, doc_type, entity_id, status, requested_at DESC);

CREATE TABLE IF NOT EXISTS workflow_entity_locks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  doc_type VARCHAR(80) NOT NULL,
  entity_id VARCHAR(120) NOT NULL,
  approval_request_id UUID REFERENCES workflow_approval_requests (id) ON DELETE SET NULL,
  locked_by UUID REFERENCES users (id) ON DELETE SET NULL,
  locked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, doc_type, entity_id)
);

CREATE TABLE IF NOT EXISTS approval_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  recipient_role VARCHAR(40),
  recipient_user_id UUID REFERENCES users (id) ON DELETE SET NULL,
  notification_type VARCHAR(80) NOT NULL,
  title VARCHAR(255) NOT NULL,
  body TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  read_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_approval_notifications_company_read
  ON approval_notifications (company_id, is_read, created_at DESC);
