-- Frequent journal entry templates (company-scoped)

CREATE TABLE IF NOT EXISTS journal_entry_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  name VARCHAR(150) NOT NULL,
  description TEXT,
  lines_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, name)
);

CREATE INDEX IF NOT EXISTS idx_journal_entry_templates_company
  ON journal_entry_templates (company_id, created_at DESC);
