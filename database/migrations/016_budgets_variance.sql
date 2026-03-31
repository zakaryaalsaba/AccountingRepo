CREATE TABLE IF NOT EXISTS budgets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  name VARCHAR(120) NOT NULL,
  fiscal_year INTEGER NOT NULL CHECK (fiscal_year >= 2000),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, name, fiscal_year)
);

CREATE INDEX IF NOT EXISTS idx_budgets_company_year ON budgets (company_id, fiscal_year);

CREATE TABLE IF NOT EXISTS budget_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  budget_id UUID NOT NULL REFERENCES budgets (id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,
  month SMALLINT NOT NULL CHECK (month BETWEEN 1 AND 12),
  amount NUMERIC(18,2) NOT NULL CHECK (amount >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (budget_id, account_id, month)
);

CREATE INDEX IF NOT EXISTS idx_budget_lines_company_budget ON budget_lines (company_id, budget_id, month);
