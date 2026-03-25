-- Payments, allocations, invoice payer + balances (multi-tenant via company_id).
-- Recommended: apply 001_invoice_gl_postings.sql first (invoice ↔ journal link columns).

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  CREATE TYPE payment_method AS ENUM ('cash', 'card', 'bank_transfer', 'insurance');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE invoice_payer_type AS ENUM ('customer', 'patient', 'insurance');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TYPE invoice_status ADD VALUE 'partially_paid';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- Invoices: payer + totals (keeps legacy `amount` in sync with total_amount)
-- ---------------------------------------------------------------------------
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS payer_type invoice_payer_type NOT NULL DEFAULT 'customer',
  ADD COLUMN IF NOT EXISTS payer_id INTEGER,
  ADD COLUMN IF NOT EXISTS total_amount NUMERIC(18, 2),
  ADD COLUMN IF NOT EXISTS paid_amount NUMERIC(18, 2);

UPDATE invoices SET total_amount = amount WHERE total_amount IS NULL;
ALTER TABLE invoices ALTER COLUMN total_amount SET NOT NULL;

UPDATE invoices SET paid_amount = 0 WHERE paid_amount IS NULL;
ALTER TABLE invoices ALTER COLUMN paid_amount SET NOT NULL;
ALTER TABLE invoices ALTER COLUMN paid_amount SET DEFAULT 0;

-- Backfill paid_amount from legacy status
UPDATE invoices SET paid_amount = total_amount WHERE status::text = 'paid';

-- Align legacy amount column with total_amount
UPDATE invoices SET amount = total_amount WHERE amount IS DISTINCT FROM total_amount;

CREATE OR REPLACE FUNCTION invoices_sync_amount_from_total()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.total_amount IS NULL THEN
    NEW.total_amount := COALESCE(NEW.amount, 0);
  END IF;
  NEW.amount := NEW.total_amount;
  IF NEW.paid_amount IS NULL THEN
    NEW.paid_amount := 0;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_invoices_sync_amount ON invoices;
CREATE TRIGGER trg_invoices_sync_amount
  BEFORE INSERT OR UPDATE OF total_amount, amount, paid_amount ON invoices
  FOR EACH ROW
  EXECUTE PROCEDURE invoices_sync_amount_from_total();

-- ---------------------------------------------------------------------------
-- Payments
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  amount NUMERIC(18, 2) NOT NULL CHECK (amount > 0),
  payment_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  method payment_method NOT NULL,
  reference VARCHAR(255),
  notes TEXT,
  receipt_transaction_id UUID REFERENCES transactions (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payments_company ON payments (company_id);
CREATE INDEX IF NOT EXISTS idx_payments_company_date ON payments (company_id, payment_date DESC);

-- ---------------------------------------------------------------------------
-- Payment allocations (company_id for strict tenant filtering)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payment_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  payment_id UUID NOT NULL REFERENCES payments (id) ON DELETE CASCADE,
  invoice_id UUID NOT NULL REFERENCES invoices (id) ON DELETE CASCADE,
  amount_applied NUMERIC(18, 2) NOT NULL CHECK (amount_applied > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_allocations_payment ON payment_allocations (payment_id);
CREATE INDEX IF NOT EXISTS idx_payment_allocations_invoice ON payment_allocations (invoice_id);
CREATE INDEX IF NOT EXISTS idx_payment_allocations_company ON payment_allocations (company_id);
