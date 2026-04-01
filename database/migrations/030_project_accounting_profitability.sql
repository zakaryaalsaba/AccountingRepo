-- Project accounting and profitability

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'project_status') THEN
    CREATE TYPE project_status AS ENUM ('draft', 'active', 'on_hold', 'completed', 'cancelled');
  END IF;
END$$;

CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  code VARCHAR(60),
  name VARCHAR(255) NOT NULL,
  status project_status NOT NULL DEFAULT 'draft',
  customer_id UUID REFERENCES customers (id) ON DELETE SET NULL,
  manager_name VARCHAR(255),
  start_date DATE,
  end_date DATE,
  budget_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  retention_percent NUMERIC(8,4) NOT NULL DEFAULT 0 CHECK (retention_percent >= 0 AND retention_percent <= 100),
  wip_mode VARCHAR(20) NOT NULL DEFAULT 'none' CHECK (wip_mode IN ('none', 'capitalize_cost', 'recognize_progress')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  notes TEXT,
  created_by UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, code),
  UNIQUE (company_id, name)
);

CREATE INDEX IF NOT EXISTS idx_projects_company_status
  ON projects (company_id, status, is_active, start_date);

CREATE TABLE IF NOT EXISTS project_wip_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  entry_date DATE NOT NULL,
  amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  wip_type VARCHAR(20) NOT NULL CHECK (wip_type IN ('capitalize', 'release')),
  reference VARCHAR(120),
  notes TEXT,
  transaction_id UUID REFERENCES transactions (id) ON DELETE SET NULL,
  created_by UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_project_wip_entries_company_project_date
  ON project_wip_entries (company_id, project_id, entry_date DESC);

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects (id) ON DELETE SET NULL;

ALTER TABLE vouchers
  ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects (id) ON DELETE SET NULL;

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_transactions_company_project_date
  ON transactions (company_id, project_id, entry_date);
CREATE INDEX IF NOT EXISTS idx_vouchers_company_project_date
  ON vouchers (company_id, project_id, entry_date);
CREATE INDEX IF NOT EXISTS idx_invoices_company_project_date
  ON invoices (company_id, project_id, invoice_date);
