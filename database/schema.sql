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
  notes TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_vendors_company ON vendors (company_id);
CREATE UNIQUE INDEX uq_vendors_company_name ON vendors (company_id, lower(name));

CREATE TYPE bill_status AS ENUM ('draft', 'unpaid', 'partially_paid', 'paid');

CREATE TABLE bills (
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

-- ---------------------------------------------------------------------------
-- Expenses (linked to expense-type account)
-- ---------------------------------------------------------------------------
CREATE TABLE expenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,
  amount NUMERIC(18, 2) NOT NULL CHECK (amount > 0),
  description TEXT,
  expense_date DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_expenses_company ON expenses (company_id);
CREATE INDEX idx_expenses_account ON expenses (account_id);

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
  credit_limit NUMERIC(18,2) NOT NULL DEFAULT 0,
  notes TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_customers_company ON customers (company_id, is_active);

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
