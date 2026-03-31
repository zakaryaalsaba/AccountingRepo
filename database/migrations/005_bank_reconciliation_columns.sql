ALTER TABLE bank_statement_lines
  ADD COLUMN IF NOT EXISTS reconciled_transaction_id UUID REFERENCES transactions (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reconciled_by UUID REFERENCES users (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reconciled_at TIMESTAMPTZ;
