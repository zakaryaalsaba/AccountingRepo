CREATE TABLE IF NOT EXISTS invoice_credit_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  invoice_id UUID NOT NULL REFERENCES invoices (id) ON DELETE CASCADE,
  credit_date DATE NOT NULL,
  amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  reason TEXT,
  is_refund BOOLEAN NOT NULL DEFAULT FALSE,
  credit_transaction_id UUID REFERENCES transactions (id) ON DELETE SET NULL,
  refund_transaction_id UUID REFERENCES transactions (id) ON DELETE SET NULL,
  created_by UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_invoice_credit_notes_company
  ON invoice_credit_notes (company_id, invoice_id);
