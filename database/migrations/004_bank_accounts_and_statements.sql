CREATE TABLE IF NOT EXISTS bank_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  bank_name VARCHAR(255),
  account_number_masked VARCHAR(64),
  currency_code VARCHAR(10) NOT NULL DEFAULT 'SAR',
  opening_balance NUMERIC(18,2) NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bank_accounts_company ON bank_accounts (company_id);

CREATE TABLE IF NOT EXISTS bank_statement_imports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  bank_account_id UUID NOT NULL REFERENCES bank_accounts (id) ON DELETE CASCADE,
  source_name VARCHAR(255),
  rows_count INTEGER NOT NULL DEFAULT 0,
  imported_by UUID REFERENCES users (id) ON DELETE SET NULL,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bank_stmt_imports_company ON bank_statement_imports (company_id);

CREATE TABLE IF NOT EXISTS bank_statement_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  bank_account_id UUID NOT NULL REFERENCES bank_accounts (id) ON DELETE CASCADE,
  import_id UUID REFERENCES bank_statement_imports (id) ON DELETE SET NULL,
  statement_date DATE NOT NULL,
  description TEXT,
  reference VARCHAR(255),
  amount NUMERIC(18,2) NOT NULL,
  running_balance NUMERIC(18,2),
  is_reconciled BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bank_stmt_lines_company_date
  ON bank_statement_lines (company_id, bank_account_id, statement_date DESC);
