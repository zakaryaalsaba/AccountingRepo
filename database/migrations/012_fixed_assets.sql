CREATE TABLE IF NOT EXISTS fixed_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  asset_code VARCHAR(80),
  name VARCHAR(255) NOT NULL,
  acquisition_date DATE NOT NULL,
  acquisition_cost NUMERIC(18,2) NOT NULL CHECK (acquisition_cost > 0),
  useful_life_months INTEGER NOT NULL CHECK (useful_life_months > 0),
  residual_value NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (residual_value >= 0),
  depreciation_method VARCHAR(20) NOT NULL DEFAULT 'straight_line',
  asset_account_id UUID NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,
  accumulated_depr_account_id UUID NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,
  depreciation_expense_account_id UUID NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,
  disposal_date DATE,
  disposal_proceeds NUMERIC(18,2),
  is_disposed BOOLEAN NOT NULL DEFAULT FALSE,
  acquisition_transaction_id UUID REFERENCES transactions (id) ON DELETE SET NULL,
  disposal_transaction_id UUID REFERENCES transactions (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, asset_code)
);

CREATE INDEX IF NOT EXISTS idx_fixed_assets_company ON fixed_assets (company_id);
CREATE INDEX IF NOT EXISTS idx_fixed_assets_disposed ON fixed_assets (company_id, is_disposed);

CREATE TABLE IF NOT EXISTS fixed_asset_depreciation_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  asset_id UUID NOT NULL REFERENCES fixed_assets (id) ON DELETE CASCADE,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  transaction_id UUID REFERENCES transactions (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (asset_id, period_start, period_end)
);

CREATE INDEX IF NOT EXISTS idx_fa_depr_company_period
  ON fixed_asset_depreciation_entries (company_id, period_start, period_end);
