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
  code VARCHAR(50) NOT NULL,
  name VARCHAR(255) NOT NULL,
  type account_type NOT NULL,
  parent_id UUID REFERENCES accounts (id) ON DELETE SET NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, code)
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

CREATE TABLE invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  customer_name VARCHAR(255) NOT NULL,
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
