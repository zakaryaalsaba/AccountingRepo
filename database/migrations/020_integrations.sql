CREATE TABLE IF NOT EXISTS integration_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  provider VARCHAR(60) NOT NULL,
  name VARCHAR(120) NOT NULL,
  settings JSONB NOT NULL DEFAULT '{}',
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  last_synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_integration_connections_company_provider
  ON integration_connections (company_id, provider, status);

CREATE TABLE IF NOT EXISTS payment_gateway_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  connection_id UUID REFERENCES integration_connections (id) ON DELETE SET NULL,
  event_type VARCHAR(120) NOT NULL,
  external_id VARCHAR(120),
  payload JSONB NOT NULL DEFAULT '{}',
  processed BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_gateway_events_company
  ON payment_gateway_events (company_id, processed, created_at DESC);

CREATE TABLE IF NOT EXISTS ecommerce_sales_syncs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  connection_id UUID REFERENCES integration_connections (id) ON DELETE SET NULL,
  external_order_id VARCHAR(120) NOT NULL,
  order_date DATE NOT NULL,
  customer_name VARCHAR(255),
  amount NUMERIC(18,2) NOT NULL CHECK (amount >= 0),
  currency_code VARCHAR(10),
  payload JSONB NOT NULL DEFAULT '{}',
  imported_transaction_id UUID REFERENCES transactions (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, external_order_id)
);

CREATE INDEX IF NOT EXISTS idx_ecommerce_sales_syncs_company_date
  ON ecommerce_sales_syncs (company_id, order_date DESC);
