-- Phase 1 foundation: fiscal years, document sequences, voucher status hooks

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type WHERE typname = 'transaction_status'
  ) THEN
    CREATE TYPE transaction_status AS ENUM ('draft', 'posted', 'reversed');
  END IF;
END$$;

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS status transaction_status NOT NULL DEFAULT 'posted',
  ADD COLUMN IF NOT EXISTS posted_by UUID REFERENCES users (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS posted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reversed_transaction_id UUID REFERENCES transactions (id) ON DELETE SET NULL;

UPDATE transactions
SET posted_at = COALESCE(posted_at, created_at)
WHERE status = 'posted' AND posted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_transactions_company_status_date
  ON transactions (company_id, status, entry_date DESC, created_at DESC);

CREATE TABLE IF NOT EXISTS fiscal_years (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  year_code INTEGER NOT NULL CHECK (year_code BETWEEN 2000 AND 3000),
  name_ar VARCHAR(120),
  name_en VARCHAR(120),
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT FALSE,
  is_closed BOOLEAN NOT NULL DEFAULT FALSE,
  closed_at TIMESTAMPTZ,
  closed_by UUID REFERENCES users (id) ON DELETE SET NULL,
  created_by UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (start_date <= end_date),
  UNIQUE (company_id, year_code)
);

CREATE INDEX IF NOT EXISTS idx_fiscal_years_company_dates
  ON fiscal_years (company_id, start_date, end_date);
CREATE INDEX IF NOT EXISTS idx_fiscal_years_company_active
  ON fiscal_years (company_id, is_active, is_closed);

CREATE OR REPLACE FUNCTION fiscal_years_prevent_overlap()
RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM fiscal_years fy
    WHERE fy.company_id = NEW.company_id
      AND fy.id <> COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid)
      AND fy.start_date <= NEW.end_date
      AND NEW.start_date <= fy.end_date
  ) THEN
    RAISE EXCEPTION 'Fiscal year range overlaps existing fiscal year for this company';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_fiscal_years_no_overlap ON fiscal_years;
CREATE TRIGGER trg_fiscal_years_no_overlap
  BEFORE INSERT OR UPDATE OF start_date, end_date, company_id
  ON fiscal_years
  FOR EACH ROW
  EXECUTE PROCEDURE fiscal_years_prevent_overlap();

CREATE TABLE IF NOT EXISTS document_sequences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  doc_type VARCHAR(80) NOT NULL,
  fiscal_year_id UUID REFERENCES fiscal_years (id) ON DELETE SET NULL,
  prefix VARCHAR(40),
  suffix VARCHAR(20),
  padding INTEGER NOT NULL DEFAULT 6 CHECK (padding BETWEEN 1 AND 12),
  last_number BIGINT NOT NULL DEFAULT 0 CHECK (last_number >= 0),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, doc_type, fiscal_year_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_document_sequences_company_doc_default
  ON document_sequences (company_id, doc_type)
  WHERE fiscal_year_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_document_sequences_company_doc
  ON document_sequences (company_id, doc_type, is_active);

CREATE OR REPLACE FUNCTION next_document_number(
  p_company_id UUID,
  p_doc_type TEXT,
  p_fiscal_year_id UUID DEFAULT NULL
)
RETURNS TEXT AS $$
DECLARE
  seq_row document_sequences%ROWTYPE;
  n BIGINT;
BEGIN
  IF p_fiscal_year_id IS NULL THEN
    SELECT *
    INTO seq_row
    FROM document_sequences
    WHERE company_id = p_company_id
      AND doc_type = p_doc_type
      AND fiscal_year_id IS NULL
      AND is_active = TRUE
    ORDER BY updated_at DESC
    LIMIT 1
    FOR UPDATE;
  ELSE
    SELECT *
    INTO seq_row
    FROM document_sequences
    WHERE company_id = p_company_id
      AND doc_type = p_doc_type
      AND fiscal_year_id = p_fiscal_year_id
      AND is_active = TRUE
    ORDER BY updated_at DESC
    LIMIT 1
    FOR UPDATE;
  END IF;

  IF seq_row.id IS NULL THEN
    RAISE EXCEPTION 'No active sequence configured for doc_type %', p_doc_type;
  END IF;

  n := seq_row.last_number + 1;

  UPDATE document_sequences
  SET last_number = n,
      updated_at = NOW()
  WHERE id = seq_row.id;

  RETURN COALESCE(seq_row.prefix, '')
    || lpad(n::text, seq_row.padding, '0')
    || COALESCE(seq_row.suffix, '');
END;
$$ LANGUAGE plpgsql;
