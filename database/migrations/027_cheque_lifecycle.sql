-- Cheque lifecycle management

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'cheque_direction') THEN
    CREATE TYPE cheque_direction AS ENUM ('incoming', 'outgoing');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'cheque_status') THEN
    CREATE TYPE cheque_status AS ENUM (
      'received',
      'issued',
      'under_collection',
      'cleared',
      'bounced',
      'cancelled',
      'replaced'
    );
  END IF;
END$$;

CREATE TABLE IF NOT EXISTS cheques (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  cheque_number VARCHAR(120) NOT NULL,
  direction cheque_direction NOT NULL,
  status cheque_status NOT NULL,
  amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  currency_code VARCHAR(10),
  issue_date DATE NOT NULL,
  due_date DATE NOT NULL,
  counterparty_type VARCHAR(20),
  counterparty_id UUID,
  counterparty_name VARCHAR(255),
  source_account_id UUID REFERENCES accounts (id) ON DELETE SET NULL,
  clearing_account_id UUID REFERENCES accounts (id) ON DELETE SET NULL,
  cash_account_id UUID REFERENCES accounts (id) ON DELETE SET NULL,
  replacement_cheque_id UUID REFERENCES cheques (id) ON DELETE SET NULL,
  endorsement_to VARCHAR(255),
  latest_transaction_id UUID REFERENCES transactions (id) ON DELETE SET NULL,
  notes TEXT,
  created_by UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, cheque_number)
);

CREATE INDEX IF NOT EXISTS idx_cheques_company_status_due
  ON cheques (company_id, status, due_date, issue_date);
CREATE INDEX IF NOT EXISTS idx_cheques_company_counterparty
  ON cheques (company_id, counterparty_type, counterparty_id);
CREATE INDEX IF NOT EXISTS idx_cheques_company_accounts
  ON cheques (company_id, source_account_id, clearing_account_id, cash_account_id);

CREATE TABLE IF NOT EXISTS cheque_status_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  cheque_id UUID NOT NULL REFERENCES cheques (id) ON DELETE CASCADE,
  from_status cheque_status,
  to_status cheque_status NOT NULL,
  event_date DATE NOT NULL,
  reason TEXT,
  attachment_reference TEXT,
  transaction_id UUID REFERENCES transactions (id) ON DELETE SET NULL,
  created_by UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cheque_events_company_cheque_date
  ON cheque_status_events (company_id, cheque_id, event_date DESC, created_at DESC);
