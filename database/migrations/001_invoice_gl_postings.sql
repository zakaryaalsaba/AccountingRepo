-- Links invoices to auto-posted journal entries (sale: Dr AR / Cr Revenue; payment: Dr Cash / Cr AR).
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS sale_transaction_id UUID REFERENCES transactions (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS payment_transaction_id UUID REFERENCES transactions (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_invoices_sale_tx ON invoices (sale_transaction_id);
CREATE INDEX IF NOT EXISTS idx_invoices_payment_tx ON invoices (payment_transaction_id);
