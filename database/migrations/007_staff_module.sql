-- Staff roles (per-company custom RBAC) and membership ↔ role assignments.
-- Deactivate staff via company_members.is_active (owner cannot be deactivated here).

ALTER TABLE company_members
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;

CREATE TABLE IF NOT EXISTS staff_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  role_name VARCHAR(100) NOT NULL,
  permissions JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, role_name)
);

CREATE INDEX IF NOT EXISTS idx_staff_roles_company ON staff_roles (company_id);

-- Many-to-many: one company member can hold multiple custom roles (e.g. "Reception" + "Billing").
CREATE TABLE IF NOT EXISTS company_member_staff_roles (
  company_member_id UUID NOT NULL REFERENCES company_members (id) ON DELETE CASCADE,
  staff_role_id UUID NOT NULL REFERENCES staff_roles (id) ON DELETE CASCADE,
  PRIMARY KEY (company_member_id, staff_role_id)
);

CREATE INDEX IF NOT EXISTS idx_cm_staff_roles_role ON company_member_staff_roles (staff_role_id);
