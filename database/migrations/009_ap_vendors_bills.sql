CREATE TABLE IF NOT EXISTS vendors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255),
  phone VARCHAR(50),
  tax_id VARCHAR(100),
  payment_terms_days INTEGER NOT NULL DEFAULT 0 CHECK (payment_terms_days >= 0),
  notes TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vendors_company ON vendors (company_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_vendors_company_name
  ON vendors (company_id, lower(name));

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'bill_status') THEN
    CREATE TYPE bill_status AS ENUM ('draft', 'unpaid', 'partially_paid', 'paid');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS bills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  vendor_id UUID NOT NULL REFERENCES vendors (id) ON DELETE RESTRICT,
  bill_number VARCHAR(80),
  description TEXT,
  bill_date DATE NOT NULL,
  due_date DATE NOT NULL,
  expense_account_id UUID NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,
  total_amount NUMERIC(18,2) NOT NULL CHECK (total_amount >= 0),
  paid_amount NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),
  status bill_status NOT NULL DEFAULT 'unpaid',
  posting_transaction_id UUID REFERENCES transactions (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bills_company ON bills (company_id);
CREATE INDEX IF NOT EXISTS idx_bills_company_due ON bills (company_id, due_date);
CREATE UNIQUE INDEX IF NOT EXISTS uq_bills_company_number
  ON bills (company_id, bill_number)
  WHERE bill_number IS NOT NULL;

CREATE TABLE IF NOT EXISTS bill_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  bill_id UUID NOT NULL REFERENCES bills (id) ON DELETE CASCADE,
  payment_date DATE NOT NULL,
  amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  method payment_method NOT NULL DEFAULT 'cash',
  reference VARCHAR(255),
  payment_transaction_id UUID REFERENCES transactions (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bill_payments_company ON bill_payments (company_id);
CREATE INDEX IF NOT EXISTS idx_bill_payments_bill ON bill_payments (bill_id);
