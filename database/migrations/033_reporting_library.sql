-- Advanced reporting library support

CREATE TABLE IF NOT EXISTS report_saved_views (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  report_key VARCHAR(120) NOT NULL,
  name VARCHAR(180) NOT NULL,
  selected_columns JSONB NOT NULL DEFAULT '[]'::jsonb,
  filters_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_by UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, report_key, name)
);

CREATE INDEX IF NOT EXISTS idx_report_saved_views_company_key
  ON report_saved_views (company_id, report_key, created_at DESC);
