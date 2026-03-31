-- Accounting SaaS — PostgreSQL schema
-- Multi-tenant: all business data scoped by company_id (except users).

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------------------------------------------------------------------------
-- Users (no company_id — global identity)
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  full_name VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Companies
-- ---------------------------------------------------------------------------
CREATE TABLE companies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  owner_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  industry VARCHAR(100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_companies_owner ON companies (owner_id);

-- Future RBAC: users invited to a company with a role (owner remains on companies.owner_id)
CREATE TABLE company_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role VARCHAR(50) NOT NULL DEFAULT 'accountant',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, user_id)
);

CREATE INDEX idx_company_members_user ON company_members (user_id);
CREATE INDEX idx_company_members_company ON company_members (company_id);

CREATE TABLE staff_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  role_name VARCHAR(100) NOT NULL,
  permissions JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, role_name)
);

CREATE INDEX idx_staff_roles_company ON staff_roles (company_id);

CREATE TABLE company_member_staff_roles (
  company_member_id UUID NOT NULL REFERENCES company_members (id) ON DELETE CASCADE,
  staff_role_id UUID NOT NULL REFERENCES staff_roles (id) ON DELETE CASCADE,
  PRIMARY KEY (company_member_id, staff_role_id)
);

CREATE INDEX idx_cm_staff_roles_role ON company_member_staff_roles (staff_role_id);

-- ---------------------------------------------------------------------------
-- Period closing / locking
-- ---------------------------------------------------------------------------
CREATE TABLE accounting_period_locks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  is_closed BOOLEAN NOT NULL DEFAULT TRUE,
  note TEXT,
  closed_by UUID REFERENCES users (id) ON DELETE SET NULL,
  closed_at TIMESTAMPTZ,
  reopened_by UUID REFERENCES users (id) ON DELETE SET NULL,
  reopened_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (period_start <= period_end),
  UNIQUE (company_id, period_start, period_end)
);

CREATE INDEX idx_period_locks_company_range
  ON accounting_period_locks (company_id, period_start, period_end);
CREATE INDEX idx_period_locks_company_closed
  ON accounting_period_locks (company_id, is_closed);

-- ---------------------------------------------------------------------------
-- Chart of accounts
-- ---------------------------------------------------------------------------
CREATE TYPE account_type AS ENUM (
  'ASSET',
  'LIABILITY',
  'EQUITY',
  'REVENUE',
  'EXPENSE'
);

CREATE TABLE accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  -- Legacy code kept for backwards compatibility with existing reports/services.
  code VARCHAR(50) NOT NULL,
  account_code VARCHAR(50) NOT NULL,
  level INTEGER NOT NULL CHECK (level BETWEEN 1 AND 5),
  name VARCHAR(255) NOT NULL,
  type account_type NOT NULL,
  parent_id UUID REFERENCES accounts (id) ON DELETE SET NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, code),
  UNIQUE (company_id, account_code)
);

CREATE INDEX idx_accounts_company ON accounts (company_id);

-- ---------------------------------------------------------------------------
-- Double-entry journal
-- ---------------------------------------------------------------------------
CREATE TABLE transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  entry_date DATE NOT NULL,
  description TEXT,
  reference VARCHAR(100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_transactions_company_date ON transactions (company_id, entry_date);

CREATE TABLE transaction_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID NOT NULL REFERENCES transactions (id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,
  debit NUMERIC(18, 2) NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit NUMERIC(18, 2) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  CONSTRAINT chk_line_debit_xor_credit CHECK (
    (debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0)
  )
);

CREATE INDEX idx_transaction_lines_tx ON transaction_lines (transaction_id);
CREATE INDEX idx_transaction_lines_account ON transaction_lines (account_id);

CREATE TYPE dimension_type AS ENUM ('cost_center', 'project', 'department', 'custom');

CREATE TABLE dimensions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  type dimension_type NOT NULL,
  code VARCHAR(60),
  name VARCHAR(255) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, type, code)
);

CREATE INDEX idx_dimensions_company_type ON dimensions (company_id, type, is_active);

CREATE TABLE transaction_line_dimensions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  transaction_line_id UUID NOT NULL REFERENCES transaction_lines (id) ON DELETE CASCADE,
  dimension_id UUID NOT NULL REFERENCES dimensions (id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (transaction_line_id, dimension_id)
);

CREATE INDEX idx_tld_company_dimension ON transaction_line_dimensions (company_id, dimension_id);

-- ---------------------------------------------------------------------------
-- Invoices
-- ---------------------------------------------------------------------------
CREATE TYPE invoice_status AS ENUM ('draft', 'unpaid', 'partially_paid', 'paid');
CREATE TYPE invoice_payer_type AS ENUM ('customer', 'patient', 'insurance');

CREATE TABLE invoice_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  name VARCHAR(120) NOT NULL,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  layout JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, name)
);

CREATE INDEX idx_invoice_templates_company ON invoice_templates (company_id);

CREATE TABLE invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  customer_name VARCHAR(255) NOT NULL,
  invoice_number VARCHAR(80),
  invoice_template_id UUID REFERENCES invoice_templates (id) ON DELETE SET NULL,
  amount NUMERIC(18, 2) NOT NULL CHECK (amount >= 0),
  subtotal_amount NUMERIC(18, 2) NOT NULL DEFAULT 0,
  tax_amount NUMERIC(18, 2) NOT NULL DEFAULT 0,
  tax_inclusive BOOLEAN NOT NULL DEFAULT FALSE,
  tax_rate_id UUID,
  total_amount NUMERIC(18, 2) NOT NULL CHECK (total_amount >= 0),
  paid_amount NUMERIC(18, 2) NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),
  payer_type invoice_payer_type NOT NULL DEFAULT 'customer',
  payer_id INTEGER,
  status invoice_status NOT NULL DEFAULT 'unpaid',
  invoice_date DATE NOT NULL,
  sale_transaction_id UUID REFERENCES transactions (id) ON DELETE SET NULL,
  payment_transaction_id UUID REFERENCES transactions (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_invoices_company ON invoices (company_id);
CREATE INDEX idx_invoices_sale_tx ON invoices (sale_transaction_id);
CREATE INDEX idx_invoices_payment_tx ON invoices (payment_transaction_id);
CREATE UNIQUE INDEX uq_invoices_company_number ON invoices (company_id, invoice_number) WHERE invoice_number IS NOT NULL;

CREATE TABLE invoice_credit_notes (
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

CREATE INDEX idx_invoice_credit_notes_company ON invoice_credit_notes (company_id, invoice_id);

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

CREATE TRIGGER trg_invoices_sync_amount
  BEFORE INSERT OR UPDATE OF total_amount, amount, paid_amount ON invoices
  FOR EACH ROW
  EXECUTE PROCEDURE invoices_sync_amount_from_total();

-- ---------------------------------------------------------------------------
-- Payments & allocations (clinical-ready payer on invoices only)
-- ---------------------------------------------------------------------------
CREATE TYPE payment_method AS ENUM ('cash', 'card', 'bank_transfer', 'insurance');

CREATE TABLE payments (
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

CREATE INDEX idx_payments_company ON payments (company_id);
CREATE INDEX idx_payments_company_date ON payments (company_id, payment_date DESC);

CREATE TABLE payment_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  payment_id UUID NOT NULL REFERENCES payments (id) ON DELETE CASCADE,
  invoice_id UUID NOT NULL REFERENCES invoices (id) ON DELETE CASCADE,
  amount_applied NUMERIC(18, 2) NOT NULL CHECK (amount_applied > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_payment_allocations_payment ON payment_allocations (payment_id);
CREATE INDEX idx_payment_allocations_invoice ON payment_allocations (invoice_id);
CREATE INDEX idx_payment_allocations_company ON payment_allocations (company_id);

-- ---------------------------------------------------------------------------
-- Accounts payable (vendors, bills, bill payments)
-- ---------------------------------------------------------------------------
CREATE TABLE vendors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255),
  phone VARCHAR(50),
  tax_id VARCHAR(100),
  payment_terms_days INTEGER NOT NULL DEFAULT 0 CHECK (payment_terms_days >= 0),
  currency_code VARCHAR(10),
  notes TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_vendors_company ON vendors (company_id);
CREATE UNIQUE INDEX uq_vendors_company_name ON vendors (company_id, lower(name));

CREATE TYPE bill_status AS ENUM ('draft', 'unpaid', 'partially_paid', 'paid');
CREATE TYPE expense_payment_method AS ENUM ('cash', 'card', 'bank_transfer', 'payable');
CREATE TYPE inventory_valuation_method AS ENUM ('average', 'fifo');
CREATE TYPE inventory_tracking_method AS ENUM ('periodic', 'perpetual');
CREATE TYPE inventory_movement_type AS ENUM ('purchase', 'sale', 'adjust_in', 'adjust_out');

CREATE TABLE bills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  vendor_id UUID NOT NULL REFERENCES vendors (id) ON DELETE RESTRICT,
  bill_number VARCHAR(80),
  description TEXT,
  bill_date DATE NOT NULL,
  due_date DATE NOT NULL,
  expense_account_id UUID NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,
  subtotal_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  tax_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  tax_inclusive BOOLEAN NOT NULL DEFAULT FALSE,
  tax_rate_id UUID,
  total_amount NUMERIC(18,2) NOT NULL CHECK (total_amount >= 0),
  paid_amount NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),
  status bill_status NOT NULL DEFAULT 'unpaid',
  posting_transaction_id UUID REFERENCES transactions (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_bills_company ON bills (company_id);
CREATE INDEX idx_bills_company_due ON bills (company_id, due_date);
CREATE UNIQUE INDEX uq_bills_company_number
  ON bills (company_id, bill_number)
  WHERE bill_number IS NOT NULL;

CREATE TABLE bill_payments (
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

CREATE INDEX idx_bill_payments_company ON bill_payments (company_id);
CREATE INDEX idx_bill_payments_bill ON bill_payments (bill_id);

CREATE TABLE bill_credits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  bill_id UUID NOT NULL REFERENCES bills (id) ON DELETE CASCADE,
  credit_date DATE NOT NULL,
  amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  reason TEXT,
  is_refund BOOLEAN NOT NULL DEFAULT FALSE,
  credit_transaction_id UUID REFERENCES transactions (id) ON DELETE SET NULL,
  refund_transaction_id UUID REFERENCES transactions (id) ON DELETE SET NULL,
  created_by UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_bill_credits_company_bill ON bill_credits (company_id, bill_id);

-- ---------------------------------------------------------------------------
-- Expenses (linked to expense-type account)
-- ---------------------------------------------------------------------------
CREATE TABLE expenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,
  amount NUMERIC(18, 2) NOT NULL CHECK (amount > 0),
  vendor_name VARCHAR(255),
  payment_method expense_payment_method NOT NULL DEFAULT 'cash',
  receipt_reference VARCHAR(255),
  receipt_attachment_url TEXT,
  ocr_raw_text TEXT,
  description TEXT,
  expense_date DATE NOT NULL,
  posting_transaction_id UUID REFERENCES transactions (id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_expenses_company ON expenses (company_id);
CREATE INDEX idx_expenses_account ON expenses (account_id);
CREATE INDEX idx_expenses_posting_tx ON expenses (posting_transaction_id);

-- ---------------------------------------------------------------------------
-- Fixed assets
-- ---------------------------------------------------------------------------
CREATE TABLE fixed_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  asset_code VARCHAR(80),
  name VARCHAR(255) NOT NULL,
  acquisition_date DATE NOT NULL,
  acquisition_cost NUMERIC(18,2) NOT NULL CHECK (acquisition_cost > 0),
  useful_life_months INTEGER NOT NULL CHECK (useful_life_months > 0),
  residual_value NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (residual_value >= 0),
  depreciation_method VARCHAR(20) NOT NULL DEFAULT 'straight_line',
  asset_account_id UUID NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,
  accumulated_depr_account_id UUID NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,
  depreciation_expense_account_id UUID NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,
  disposal_date DATE,
  disposal_proceeds NUMERIC(18,2),
  is_disposed BOOLEAN NOT NULL DEFAULT FALSE,
  acquisition_transaction_id UUID REFERENCES transactions (id) ON DELETE SET NULL,
  disposal_transaction_id UUID REFERENCES transactions (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, asset_code)
);

CREATE INDEX idx_fixed_assets_company ON fixed_assets (company_id);
CREATE INDEX idx_fixed_assets_disposed ON fixed_assets (company_id, is_disposed);

CREATE TABLE fixed_asset_depreciation_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  asset_id UUID NOT NULL REFERENCES fixed_assets (id) ON DELETE CASCADE,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  transaction_id UUID REFERENCES transactions (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (asset_id, period_start, period_end)
);

CREATE INDEX idx_fa_depr_company_period ON fixed_asset_depreciation_entries (company_id, period_start, period_end);

-- ---------------------------------------------------------------------------
-- Inventory accounting
-- ---------------------------------------------------------------------------
CREATE TABLE inventory_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  sku VARCHAR(80),
  name VARCHAR(255) NOT NULL,
  unit VARCHAR(40) NOT NULL DEFAULT 'unit',
  inventory_account_id UUID NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,
  cogs_account_id UUID NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,
  revenue_account_id UUID REFERENCES accounts (id) ON DELETE RESTRICT,
  valuation_method inventory_valuation_method NOT NULL DEFAULT 'average',
  tracking_method inventory_tracking_method NOT NULL DEFAULT 'perpetual',
  on_hand_qty NUMERIC(18,4) NOT NULL DEFAULT 0,
  avg_cost NUMERIC(18,6) NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, sku)
);

CREATE INDEX idx_inventory_items_company ON inventory_items (company_id);

CREATE TABLE inventory_movements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  item_id UUID NOT NULL REFERENCES inventory_items (id) ON DELETE CASCADE,
  movement_type inventory_movement_type NOT NULL,
  movement_date DATE NOT NULL,
  quantity NUMERIC(18,4) NOT NULL CHECK (quantity > 0),
  unit_cost NUMERIC(18,6),
  reference VARCHAR(120),
  note TEXT,
  transaction_id UUID REFERENCES transactions (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_inventory_movements_company_date ON inventory_movements (company_id, movement_date);
CREATE INDEX idx_inventory_movements_item ON inventory_movements (item_id);

CREATE TABLE inventory_fifo_layers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  item_id UUID NOT NULL REFERENCES inventory_items (id) ON DELETE CASCADE,
  source_movement_id UUID NOT NULL REFERENCES inventory_movements (id) ON DELETE CASCADE,
  layer_date DATE NOT NULL,
  remaining_qty NUMERIC(18,4) NOT NULL CHECK (remaining_qty >= 0),
  unit_cost NUMERIC(18,6) NOT NULL CHECK (unit_cost >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_inventory_fifo_layers_item_date ON inventory_fifo_layers (item_id, layer_date, created_at);

-- ---------------------------------------------------------------------------
-- Tax engine
-- ---------------------------------------------------------------------------
CREATE TABLE tax_rates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  name VARCHAR(120) NOT NULL,
  rate_percent NUMERIC(7,4) NOT NULL CHECK (rate_percent >= 0),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, name)
);

CREATE INDEX idx_tax_rates_company ON tax_rates (company_id);

CREATE TABLE tax_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  name VARCHAR(120) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, name)
);

CREATE TABLE tax_group_rates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  tax_group_id UUID NOT NULL REFERENCES tax_groups (id) ON DELETE CASCADE,
  tax_rate_id UUID NOT NULL REFERENCES tax_rates (id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tax_group_id, tax_rate_id)
);

-- ---------------------------------------------------------------------------
-- Multi-currency
-- ---------------------------------------------------------------------------
CREATE TABLE company_currencies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  currency_code VARCHAR(10) NOT NULL,
  is_base BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, currency_code)
);

CREATE INDEX idx_company_currencies_company ON company_currencies (company_id);
CREATE UNIQUE INDEX uq_company_base_currency ON company_currencies (company_id) WHERE is_base = TRUE;

CREATE TABLE exchange_rates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  rate_date DATE NOT NULL,
  from_currency VARCHAR(10) NOT NULL,
  to_currency VARCHAR(10) NOT NULL,
  rate NUMERIC(18,8) NOT NULL CHECK (rate > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, rate_date, from_currency, to_currency)
);

CREATE INDEX idx_exchange_rates_company_pair_date
  ON exchange_rates (company_id, from_currency, to_currency, rate_date DESC);

-- ---------------------------------------------------------------------------
-- Budgets & variance
-- ---------------------------------------------------------------------------
CREATE TABLE budgets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  name VARCHAR(120) NOT NULL,
  fiscal_year INTEGER NOT NULL CHECK (fiscal_year >= 2000),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, name, fiscal_year)
);

CREATE INDEX idx_budgets_company_year ON budgets (company_id, fiscal_year);

CREATE TABLE budget_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  budget_id UUID NOT NULL REFERENCES budgets (id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,
  month SMALLINT NOT NULL CHECK (month BETWEEN 1 AND 12),
  amount NUMERIC(18,2) NOT NULL CHECK (amount >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (budget_id, account_id, month)
);

CREATE INDEX idx_budget_lines_company_budget ON budget_lines (company_id, budget_id, month);

-- ---------------------------------------------------------------------------
-- Recurring & scheduled accounting
-- ---------------------------------------------------------------------------
CREATE TYPE recurring_template_type AS ENUM ('invoice', 'bill', 'journal', 'accrual', 'prepayment');
CREATE TYPE recurrence_frequency AS ENUM ('daily', 'weekly', 'monthly', 'quarterly', 'yearly');

CREATE TABLE recurring_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  type recurring_template_type NOT NULL,
  name VARCHAR(255) NOT NULL,
  frequency recurrence_frequency NOT NULL DEFAULT 'monthly',
  interval_count INTEGER NOT NULL DEFAULT 1 CHECK (interval_count > 0),
  start_date DATE NOT NULL,
  end_date DATE,
  next_run_date DATE NOT NULL,
  auto_post BOOLEAN NOT NULL DEFAULT FALSE,
  auto_reverse BOOLEAN NOT NULL DEFAULT FALSE,
  reverse_after_days INTEGER NOT NULL DEFAULT 1 CHECK (reverse_after_days >= 0),
  payload JSONB NOT NULL DEFAULT '{}',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  last_run_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_recurring_templates_company_next_run
  ON recurring_templates (company_id, is_active, next_run_date);

CREATE TABLE recurring_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  template_id UUID NOT NULL REFERENCES recurring_templates (id) ON DELETE CASCADE,
  run_date DATE NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'posted',
  result_transaction_id UUID REFERENCES transactions (id) ON DELETE SET NULL,
  result_record_id UUID,
  reverse_transaction_id UUID REFERENCES transactions (id) ON DELETE SET NULL,
  message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_recurring_runs_company_template ON recurring_runs (company_id, template_id, run_date DESC);

CREATE TABLE journal_auto_reversals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  source_transaction_id UUID NOT NULL REFERENCES transactions (id) ON DELETE CASCADE,
  reverse_on_date DATE NOT NULL,
  reversed_transaction_id UUID REFERENCES transactions (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_transaction_id)
);

CREATE INDEX idx_journal_auto_reversals_company_date
  ON journal_auto_reversals (company_id, reverse_on_date, reversed_transaction_id);

-- ---------------------------------------------------------------------------
-- Document management & auditability
-- ---------------------------------------------------------------------------
CREATE TYPE approval_status AS ENUM ('pending', 'approved', 'rejected');

CREATE TABLE document_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  entity_type VARCHAR(50) NOT NULL,
  entity_id UUID NOT NULL,
  file_name VARCHAR(255) NOT NULL,
  file_url TEXT NOT NULL,
  mime_type VARCHAR(120),
  file_size_bytes BIGINT,
  uploaded_by UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_document_attachments_company_entity
  ON document_attachments (company_id, entity_type, entity_id);

CREATE TABLE audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  actor_user_id UUID REFERENCES users (id) ON DELETE SET NULL,
  event_type VARCHAR(120) NOT NULL,
  entity_type VARCHAR(50) NOT NULL,
  entity_id UUID,
  details JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_events_company_created ON audit_events (company_id, created_at DESC);

CREATE TABLE journal_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  transaction_id UUID NOT NULL REFERENCES transactions (id) ON DELETE CASCADE,
  requested_by UUID REFERENCES users (id) ON DELETE SET NULL,
  approved_by UUID REFERENCES users (id) ON DELETE SET NULL,
  status approval_status NOT NULL DEFAULT 'pending',
  note TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at TIMESTAMPTZ,
  UNIQUE (transaction_id)
);

CREATE INDEX idx_journal_approvals_company_status
  ON journal_approvals (company_id, status, requested_at DESC);

-- ---------------------------------------------------------------------------
-- Integrations
-- ---------------------------------------------------------------------------
CREATE TABLE integration_connections (
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

CREATE INDEX idx_integration_connections_company_provider
  ON integration_connections (company_id, provider, status);

CREATE TABLE payment_gateway_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  connection_id UUID REFERENCES integration_connections (id) ON DELETE SET NULL,
  event_type VARCHAR(120) NOT NULL,
  external_id VARCHAR(120),
  payload JSONB NOT NULL DEFAULT '{}',
  processed BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_payment_gateway_events_company
  ON payment_gateway_events (company_id, processed, created_at DESC);

CREATE TABLE ecommerce_sales_syncs (
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

CREATE INDEX idx_ecommerce_sales_syncs_company_date
  ON ecommerce_sales_syncs (company_id, order_date DESC);

-- ---------------------------------------------------------------------------
-- Enterprise readiness
-- ---------------------------------------------------------------------------
CREATE TYPE job_status AS ENUM ('queued', 'running', 'done', 'failed');

CREATE TABLE background_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID REFERENCES companies (id) ON DELETE CASCADE,
  queue_name VARCHAR(80) NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  status job_status NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  run_after TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_at TIMESTAMPTZ,
  locked_by VARCHAR(120),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_background_jobs_queue_status_run_after
  ON background_jobs (queue_name, status, run_after, created_at);

CREATE TABLE webhook_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  name VARCHAR(120) NOT NULL,
  target_url TEXT NOT NULL,
  secret VARCHAR(255),
  event_filter TEXT[] NOT NULL DEFAULT '{}',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_webhook_subscriptions_company_active ON webhook_subscriptions (company_id, is_active);

CREATE TABLE webhook_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  subscription_id UUID NOT NULL REFERENCES webhook_subscriptions (id) ON DELETE CASCADE,
  event_type VARCHAR(120) NOT NULL,
  event_payload JSONB NOT NULL DEFAULT '{}',
  status VARCHAR(20) NOT NULL DEFAULT 'queued',
  response_status INTEGER,
  response_body TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at TIMESTAMPTZ
);

CREATE INDEX idx_webhook_deliveries_company_status ON webhook_deliveries (company_id, status, created_at DESC);

CREATE TABLE backup_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID REFERENCES companies (id) ON DELETE SET NULL,
  storage_uri TEXT NOT NULL,
  checksum_sha256 VARCHAR(128),
  snapshot_metadata JSONB NOT NULL DEFAULT '{}',
  status VARCHAR(20) NOT NULL DEFAULT 'created',
  created_by UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_backup_records_company_created ON backup_records (company_id, created_at DESC);

CREATE TABLE restore_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID REFERENCES companies (id) ON DELETE SET NULL,
  backup_id UUID NOT NULL REFERENCES backup_records (id) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL DEFAULT 'requested',
  requested_by UUID REFERENCES users (id) ON DELETE SET NULL,
  approved_by UUID REFERENCES users (id) ON DELETE SET NULL,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX idx_restore_requests_company_status ON restore_requests (company_id, status, created_at DESC);

CREATE INDEX idx_transactions_company_created ON transactions (company_id, created_at DESC);
CREATE INDEX idx_invoices_company_status_date ON invoices (company_id, status, invoice_date DESC);
CREATE INDEX idx_bills_company_status_date ON bills (company_id, status, bill_date DESC);

-- ---------------------------------------------------------------------------
-- Bank accounts & statement imports (foundation for reconciliation)
-- ---------------------------------------------------------------------------
CREATE TABLE bank_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  bank_name VARCHAR(255),
  account_number_masked VARCHAR(64),
  currency_code VARCHAR(10) NOT NULL DEFAULT 'SAR',
  opening_balance NUMERIC(18,2) NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_bank_accounts_company ON bank_accounts (company_id);

CREATE TABLE bank_statement_imports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  bank_account_id UUID NOT NULL REFERENCES bank_accounts (id) ON DELETE CASCADE,
  source_name VARCHAR(255),
  rows_count INTEGER NOT NULL DEFAULT 0,
  imported_by UUID REFERENCES users (id) ON DELETE SET NULL,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_bank_stmt_imports_company ON bank_statement_imports (company_id);

CREATE TABLE bank_statement_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  bank_account_id UUID NOT NULL REFERENCES bank_accounts (id) ON DELETE CASCADE,
  import_id UUID REFERENCES bank_statement_imports (id) ON DELETE SET NULL,
  statement_date DATE NOT NULL,
  description TEXT,
  reference VARCHAR(255),
  amount NUMERIC(18,2) NOT NULL,
  running_balance NUMERIC(18,2),
  is_reconciled BOOLEAN NOT NULL DEFAULT FALSE,
  reconciled_transaction_id UUID REFERENCES transactions (id) ON DELETE SET NULL,
  reconciled_by UUID REFERENCES users (id) ON DELETE SET NULL,
  reconciled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_bank_stmt_lines_company_date
  ON bank_statement_lines (company_id, bank_account_id, statement_date DESC);

-- ---------------------------------------------------------------------------
-- Customer master data (AR foundation)
-- ---------------------------------------------------------------------------
CREATE TABLE customers (
  id BIGSERIAL PRIMARY KEY,
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255),
  phone VARCHAR(50),
  tax_id VARCHAR(100),
  payment_terms_days INTEGER NOT NULL DEFAULT 0,
  currency_code VARCHAR(10),
  credit_limit NUMERIC(18,2) NOT NULL DEFAULT 0,
  notes TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_customers_company ON customers (company_id, is_active);

CREATE TABLE customer_reminders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  customer_id BIGINT NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  reminder_date DATE NOT NULL,
  channel VARCHAR(30) NOT NULL DEFAULT 'email',
  subject VARCHAR(255),
  message TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'queued',
  sent_at TIMESTAMPTZ,
  created_by UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_customer_reminders_company_customer
  ON customer_reminders (company_id, customer_id, reminder_date DESC);

-- ---------------------------------------------------------------------------
-- Clinical (MVP)
-- ---------------------------------------------------------------------------
CREATE TYPE patient_gender AS ENUM ('male', 'female');
CREATE TYPE appointment_status AS ENUM ('scheduled', 'completed', 'cancelled');

CREATE TABLE patients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  full_name VARCHAR(255) NOT NULL,
  phone VARCHAR(50),
  email VARCHAR(255),
  date_of_birth DATE,
  blood_group VARCHAR(30),
  gender patient_gender,
  notes TEXT,
  blood_pressure VARCHAR(30),
  heart_rate SMALLINT,
  spo2 SMALLINT,
  temperature_c NUMERIC(5, 2),
  respiratory_rate SMALLINT,
  weight_kg NUMERIC(7, 2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_patients_company ON patients (company_id);
CREATE INDEX idx_patients_company_name ON patients (company_id, full_name);

CREATE TABLE appointments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  patient_id UUID NOT NULL REFERENCES patients (id) ON DELETE CASCADE,
  assigned_doctor_id UUID REFERENCES users (id) ON DELETE SET NULL,
  appointment_date TIMESTAMPTZ NOT NULL,
  status appointment_status NOT NULL DEFAULT 'scheduled',
  notes TEXT,
  blood_pressure VARCHAR(30),
  heart_rate SMALLINT,
  spo2 SMALLINT,
  temperature_c NUMERIC(5, 2),
  respiratory_rate SMALLINT,
  weight_kg NUMERIC(7, 2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_appointments_company ON appointments (company_id);
CREATE INDEX idx_appointments_company_date ON appointments (company_id, appointment_date);
CREATE INDEX idx_appointments_patient ON appointments (patient_id);
CREATE INDEX idx_appointments_assigned_doctor ON appointments (assigned_doctor_id);

CREATE TABLE doctor_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  specialization VARCHAR(255),
  license_number VARCHAR(100),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, user_id)
);

CREATE INDEX idx_doctor_profiles_company ON doctor_profiles (company_id);
CREATE INDEX idx_doctor_profiles_user ON doctor_profiles (user_id);

CREATE TABLE prescriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  appointment_id UUID NOT NULL REFERENCES appointments (id) ON DELETE CASCADE,
  doctor_id UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  patient_id UUID NOT NULL REFERENCES patients (id) ON DELETE CASCADE,
  medication_name VARCHAR(255) NOT NULL,
  dosage VARCHAR(255),
  instructions TEXT,
  service_fee NUMERIC(12, 2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_prescriptions_company ON prescriptions (company_id);
CREATE INDEX idx_prescriptions_patient ON prescriptions (patient_id);
CREATE INDEX idx_prescriptions_doctor ON prescriptions (doctor_id);
CREATE INDEX idx_prescriptions_appointment ON prescriptions (appointment_id);

CREATE TYPE lab_order_status AS ENUM ('ordered', 'completed', 'canceled');

CREATE TABLE lab_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  appointment_id UUID NOT NULL REFERENCES appointments (id) ON DELETE CASCADE,
  doctor_id UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  patient_id UUID NOT NULL REFERENCES patients (id) ON DELETE CASCADE,
  test_name VARCHAR(255) NOT NULL,
  instructions TEXT,
  status lab_order_status NOT NULL DEFAULT 'ordered',
  results JSONB,
  test_fee NUMERIC(12, 2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_lab_orders_company ON lab_orders (company_id);
CREATE INDEX idx_lab_orders_patient ON lab_orders (patient_id);
CREATE INDEX idx_lab_orders_doctor ON lab_orders (doctor_id);
CREATE INDEX idx_lab_orders_appointment ON lab_orders (appointment_id);

CREATE TABLE medical_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  patient_id UUID NOT NULL REFERENCES patients (id) ON DELETE CASCADE,
  diagnosis TEXT,
  treatment TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_medical_records_company ON medical_records (company_id);
CREATE INDEX idx_medical_records_patient ON medical_records (patient_id);

CREATE TABLE insurance_providers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  contact_info TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_insurance_providers_company ON insurance_providers (company_id);

CREATE TABLE patient_insurances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  patient_id UUID NOT NULL REFERENCES patients (id) ON DELETE CASCADE,
  provider_id UUID NOT NULL REFERENCES insurance_providers (id) ON DELETE RESTRICT,
  policy_number VARCHAR(100),
  coverage_percentage NUMERIC(5, 2) CHECK (
    coverage_percentage IS NULL
    OR (coverage_percentage >= 0 AND coverage_percentage <= 100)
  ),
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_patient_insurances_company ON patient_insurances (company_id);
CREATE INDEX idx_patient_insurances_patient ON patient_insurances (patient_id);
CREATE INDEX idx_patient_insurances_provider ON patient_insurances (provider_id);
