DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'expense_payment_method') THEN
    CREATE TYPE expense_payment_method AS ENUM ('cash', 'card', 'bank_transfer', 'payable');
  END IF;
END $$;

ALTER TABLE expenses
  ADD COLUMN IF NOT EXISTS vendor_name VARCHAR(255),
  ADD COLUMN IF NOT EXISTS payment_method expense_payment_method NOT NULL DEFAULT 'cash',
  ADD COLUMN IF NOT EXISTS receipt_reference VARCHAR(255),
  ADD COLUMN IF NOT EXISTS receipt_attachment_url TEXT,
  ADD COLUMN IF NOT EXISTS ocr_raw_text TEXT,
  ADD COLUMN IF NOT EXISTS posting_transaction_id UUID REFERENCES transactions (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_expenses_posting_tx ON expenses (posting_transaction_id);
