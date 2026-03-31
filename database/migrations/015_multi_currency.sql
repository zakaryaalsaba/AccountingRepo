CREATE TABLE IF NOT EXISTS company_currencies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  currency_code VARCHAR(10) NOT NULL,
  is_base BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, currency_code)
);

CREATE INDEX IF NOT EXISTS idx_company_currencies_company ON company_currencies (company_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_company_base_currency
  ON company_currencies (company_id)
  WHERE is_base = TRUE;

CREATE TABLE IF NOT EXISTS exchange_rates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  rate_date DATE NOT NULL,
  from_currency VARCHAR(10) NOT NULL,
  to_currency VARCHAR(10) NOT NULL,
  rate NUMERIC(18,8) NOT NULL CHECK (rate > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, rate_date, from_currency, to_currency)
);

CREATE INDEX IF NOT EXISTS idx_exchange_rates_company_pair_date
  ON exchange_rates (company_id, from_currency, to_currency, rate_date DESC);

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS currency_code VARCHAR(10);

ALTER TABLE vendors
  ADD COLUMN IF NOT EXISTS currency_code VARCHAR(10);

ALTER TABLE bank_accounts
  ADD COLUMN IF NOT EXISTS currency_code VARCHAR(10) DEFAULT 'SAR';
