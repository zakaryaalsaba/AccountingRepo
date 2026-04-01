-- Customer/Vendor statement confirmation workflow

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'statement_party_type') THEN
    CREATE TYPE statement_party_type AS ENUM ('customer', 'vendor');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'statement_confirmation_status') THEN
    CREATE TYPE statement_confirmation_status AS ENUM ('sent', 'acknowledged', 'disputed');
  END IF;
END$$;

CREATE TABLE IF NOT EXISTS statement_confirmations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  party_type statement_party_type NOT NULL,
  party_id VARCHAR(120) NOT NULL,
  period_from DATE NOT NULL,
  period_to DATE NOT NULL,
  status statement_confirmation_status NOT NULL DEFAULT 'sent',
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  acknowledged_at TIMESTAMPTZ,
  disputed_at TIMESTAMPTZ,
  notes TEXT,
  created_by UUID REFERENCES users (id) ON DELETE SET NULL,
  updated_by UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_statement_confirmations_company_party
  ON statement_confirmations (company_id, party_type, party_id, period_from, period_to);
