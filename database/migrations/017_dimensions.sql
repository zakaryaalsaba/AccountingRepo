DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'dimension_type') THEN
    CREATE TYPE dimension_type AS ENUM ('cost_center', 'project', 'department', 'custom');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS dimensions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  type dimension_type NOT NULL,
  code VARCHAR(60),
  name VARCHAR(255) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, type, code)
);

CREATE INDEX IF NOT EXISTS idx_dimensions_company_type ON dimensions (company_id, type, is_active);

CREATE TABLE IF NOT EXISTS transaction_line_dimensions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  transaction_line_id UUID NOT NULL REFERENCES transaction_lines (id) ON DELETE CASCADE,
  dimension_id UUID NOT NULL REFERENCES dimensions (id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (transaction_line_id, dimension_id)
);

CREATE INDEX IF NOT EXISTS idx_tld_company_dimension ON transaction_line_dimensions (company_id, dimension_id);
