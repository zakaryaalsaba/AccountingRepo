-- Branch/Cost center/Service card structure

ALTER TYPE dimension_type ADD VALUE IF NOT EXISTS 'branch';
ALTER TYPE dimension_type ADD VALUE IF NOT EXISTS 'service_center';

CREATE TABLE IF NOT EXISTS branches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  code VARCHAR(60),
  name VARCHAR(255) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, code),
  UNIQUE (company_id, name)
);

CREATE INDEX IF NOT EXISTS idx_branches_company_active
  ON branches (company_id, is_active, code);

CREATE TABLE IF NOT EXISTS service_cards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  code VARCHAR(60),
  name VARCHAR(255) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, code),
  UNIQUE (company_id, name)
);

CREATE INDEX IF NOT EXISTS idx_service_cards_company_active
  ON service_cards (company_id, is_active, code);

CREATE TABLE IF NOT EXISTS account_class_dimension_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  account_type account_type NOT NULL,
  mode VARCHAR(20) NOT NULL DEFAULT 'optional' CHECK (mode IN ('optional', 'required_any', 'required_types')),
  required_types JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, account_type)
);

CREATE INDEX IF NOT EXISTS idx_account_class_policies_company_type
  ON account_class_dimension_policies (company_id, account_type);

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS branch_id UUID REFERENCES branches (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS service_card_id UUID REFERENCES service_cards (id) ON DELETE SET NULL;

ALTER TABLE vouchers
  ADD COLUMN IF NOT EXISTS branch_id UUID REFERENCES branches (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS service_card_id UUID REFERENCES service_cards (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_transactions_company_branch_date
  ON transactions (company_id, branch_id, entry_date);
CREATE INDEX IF NOT EXISTS idx_transactions_company_service_date
  ON transactions (company_id, service_card_id, entry_date);
CREATE INDEX IF NOT EXISTS idx_vouchers_company_branch_date
  ON vouchers (company_id, branch_id, entry_date);
CREATE INDEX IF NOT EXISTS idx_vouchers_company_service_date
  ON vouchers (company_id, service_card_id, entry_date);
