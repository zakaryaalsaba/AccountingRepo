-- Receipt / Payment / Transfer / Adjustment voucher families

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'voucher_family') THEN
    CREATE TYPE voucher_family AS ENUM ('receipt', 'payment', 'transfer', 'adjustment');
  END IF;
END$$;

CREATE TABLE IF NOT EXISTS vouchers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  family voucher_family NOT NULL,
  entry_date DATE NOT NULL,
  amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  currency_code VARCHAR(10),
  exchange_rate NUMERIC(18,8),
  settlement_base_amount NUMERIC(18,2),
  source_account_id UUID REFERENCES accounts (id) ON DELETE SET NULL,
  destination_account_id UUID REFERENCES accounts (id) ON DELETE SET NULL,
  reference VARCHAR(120),
  description TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'posted',
  transaction_id UUID REFERENCES transactions (id) ON DELETE SET NULL,
  created_by UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vouchers_company_family_date
  ON vouchers (company_id, family, entry_date DESC, created_at DESC);

CREATE TABLE IF NOT EXISTS receipt_invoice_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  voucher_id UUID NOT NULL REFERENCES vouchers (id) ON DELETE CASCADE,
  invoice_id UUID NOT NULL REFERENCES invoices (id) ON DELETE CASCADE,
  amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_receipt_alloc_voucher
  ON receipt_invoice_allocations (company_id, voucher_id);

CREATE TABLE IF NOT EXISTS receipt_customer_balances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  voucher_id UUID NOT NULL REFERENCES vouchers (id) ON DELETE CASCADE,
  customer_name VARCHAR(255) NOT NULL,
  balance_type VARCHAR(20) NOT NULL CHECK (balance_type IN ('advance', 'on_account')),
  amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_receipt_customer_balances_company
  ON receipt_customer_balances (company_id, customer_name, balance_type);

CREATE TABLE IF NOT EXISTS payment_bill_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  voucher_id UUID NOT NULL REFERENCES vouchers (id) ON DELETE CASCADE,
  bill_id UUID NOT NULL REFERENCES bills (id) ON DELETE CASCADE,
  amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_bill_alloc_voucher
  ON payment_bill_allocations (company_id, voucher_id);

CREATE TABLE IF NOT EXISTS vendor_prepayments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  voucher_id UUID NOT NULL REFERENCES vouchers (id) ON DELETE CASCADE,
  vendor_id UUID NOT NULL REFERENCES vendors (id) ON DELETE CASCADE,
  amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vendor_prepayments_company_vendor
  ON vendor_prepayments (company_id, vendor_id, created_at DESC);

CREATE TABLE IF NOT EXISTS payment_bill_credit_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  voucher_id UUID NOT NULL REFERENCES vouchers (id) ON DELETE CASCADE,
  bill_credit_id UUID NOT NULL REFERENCES bill_credits (id) ON DELETE CASCADE,
  amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_credit_alloc_voucher
  ON payment_bill_credit_allocations (company_id, voucher_id);
