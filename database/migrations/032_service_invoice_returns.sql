-- Service invoice and return workflows

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'service_invoice_status') THEN
    CREATE TYPE service_invoice_status AS ENUM ('draft', 'issued', 'partially_returned', 'returned');
  END IF;
END$$;

CREATE TABLE IF NOT EXISTS service_invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  customer_name VARCHAR(255) NOT NULL,
  invoice_number VARCHAR(80),
  invoice_date DATE NOT NULL,
  service_description TEXT,
  quantity NUMERIC(18,4) NOT NULL CHECK (quantity > 0),
  unit_price NUMERIC(18,4) NOT NULL CHECK (unit_price >= 0),
  subtotal_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  tax_rate_percent NUMERIC(8,4) NOT NULL DEFAULT 0,
  tax_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  total_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  returned_quantity NUMERIC(18,4) NOT NULL DEFAULT 0,
  returned_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  status service_invoice_status NOT NULL DEFAULT 'issued',
  project_id UUID REFERENCES projects (id) ON DELETE SET NULL,
  sale_transaction_id UUID REFERENCES transactions (id) ON DELETE SET NULL,
  created_by UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_service_invoices_company_date
  ON service_invoices (company_id, invoice_date DESC, status);

CREATE TABLE IF NOT EXISTS service_invoice_returns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  service_invoice_id UUID NOT NULL REFERENCES service_invoices (id) ON DELETE CASCADE,
  return_date DATE NOT NULL,
  return_quantity NUMERIC(18,4) NOT NULL CHECK (return_quantity > 0),
  return_subtotal NUMERIC(18,2) NOT NULL CHECK (return_subtotal >= 0),
  return_tax NUMERIC(18,2) NOT NULL DEFAULT 0,
  return_total NUMERIC(18,2) NOT NULL CHECK (return_total >= 0),
  reason TEXT,
  return_transaction_id UUID REFERENCES transactions (id) ON DELETE SET NULL,
  created_by UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_service_invoice_returns_company_invoice_date
  ON service_invoice_returns (company_id, service_invoice_id, return_date DESC);
