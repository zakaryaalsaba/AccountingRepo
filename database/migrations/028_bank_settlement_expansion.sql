-- Bank settlement and reconciliation expansion

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'reconciliation_lock_status') THEN
    CREATE TYPE reconciliation_lock_status AS ENUM ('draft', 'submitted', 'approved', 'reopened');
  END IF;
END$$;

CREATE TABLE IF NOT EXISTS bank_settlement_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  bank_account_id UUID NOT NULL REFERENCES bank_accounts (id) ON DELETE CASCADE,
  batch_date DATE NOT NULL,
  reference VARCHAR(120),
  notes TEXT,
  status VARCHAR(30) NOT NULL DEFAULT 'open',
  created_by UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_settlement_batches_company_bank_date
  ON bank_settlement_batches (company_id, bank_account_id, batch_date DESC);

CREATE TABLE IF NOT EXISTS bank_settlement_batch_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  batch_id UUID NOT NULL REFERENCES bank_settlement_batches (id) ON DELETE CASCADE,
  statement_line_id UUID NOT NULL REFERENCES bank_statement_lines (id) ON DELETE CASCADE,
  transaction_id UUID REFERENCES transactions (id) ON DELETE SET NULL,
  settled_amount NUMERIC(18,2) NOT NULL CHECK (settled_amount >= 0),
  status VARCHAR(20) NOT NULL DEFAULT 'matched',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_settlement_batch_lines_company_batch
  ON bank_settlement_batch_lines (company_id, batch_id);

CREATE TABLE IF NOT EXISTS reconciliation_locks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  bank_account_id UUID NOT NULL REFERENCES bank_accounts (id) ON DELETE CASCADE,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  status reconciliation_lock_status NOT NULL DEFAULT 'draft',
  submitted_by UUID REFERENCES users (id) ON DELETE SET NULL,
  submitted_at TIMESTAMPTZ,
  approved_by UUID REFERENCES users (id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ,
  reopened_by UUID REFERENCES users (id) ON DELETE SET NULL,
  reopened_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (period_start <= period_end),
  UNIQUE (company_id, bank_account_id, period_start, period_end)
);

CREATE INDEX IF NOT EXISTS idx_reconciliation_locks_company_bank_period
  ON reconciliation_locks (company_id, bank_account_id, period_start, period_end);
