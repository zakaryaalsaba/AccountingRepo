-- Bank/Treasury master expansion + opening metadata

ALTER TABLE bank_accounts
  ADD COLUMN IF NOT EXISTS gl_account_id UUID REFERENCES accounts (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS iban VARCHAR(64),
  ADD COLUMN IF NOT EXISTS swift_code VARCHAR(32),
  ADD COLUMN IF NOT EXISTS branch_name VARCHAR(255),
  ADD COLUMN IF NOT EXISTS account_owner_name VARCHAR(255),
  ADD COLUMN IF NOT EXISTS opening_date DATE,
  ADD COLUMN IF NOT EXISTS opening_reference VARCHAR(120),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_bank_accounts_company_gl
  ON bank_accounts (company_id, gl_account_id);

CREATE TABLE IF NOT EXISTS treasury_safes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  code VARCHAR(60),
  currency_code VARCHAR(10) NOT NULL DEFAULT 'SAR',
  gl_account_id UUID REFERENCES accounts (id) ON DELETE SET NULL,
  opening_balance NUMERIC(18,2) NOT NULL DEFAULT 0,
  opening_date DATE,
  opening_reference VARCHAR(120),
  custodian_name VARCHAR(255),
  location_text VARCHAR(255),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, code),
  UNIQUE (company_id, name)
);

CREATE INDEX IF NOT EXISTS idx_treasury_safes_company
  ON treasury_safes (company_id, is_active, created_at DESC);
