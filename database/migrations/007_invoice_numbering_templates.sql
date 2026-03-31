CREATE TABLE IF NOT EXISTS invoice_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  name VARCHAR(120) NOT NULL,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  layout JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, name)
);

CREATE INDEX IF NOT EXISTS idx_invoice_templates_company ON invoice_templates (company_id);

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS invoice_number VARCHAR(80),
  ADD COLUMN IF NOT EXISTS invoice_template_id UUID REFERENCES invoice_templates (id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_invoices_company_number
  ON invoices (company_id, invoice_number)
  WHERE invoice_number IS NOT NULL;
