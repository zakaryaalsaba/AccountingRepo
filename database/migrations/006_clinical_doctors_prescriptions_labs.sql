-- Doctors (profiles per company), prescriptions, lab orders. Billing prep: service_fee / test_fee.

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS assigned_doctor_id UUID REFERENCES users (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_appointments_assigned_doctor ON appointments (assigned_doctor_id);

CREATE TABLE IF NOT EXISTS doctor_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  specialization VARCHAR(255),
  license_number VARCHAR(100),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_doctor_profiles_company ON doctor_profiles (company_id);
CREATE INDEX IF NOT EXISTS idx_doctor_profiles_user ON doctor_profiles (user_id);

CREATE TABLE IF NOT EXISTS prescriptions (
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

CREATE INDEX IF NOT EXISTS idx_prescriptions_company ON prescriptions (company_id);
CREATE INDEX IF NOT EXISTS idx_prescriptions_patient ON prescriptions (patient_id);
CREATE INDEX IF NOT EXISTS idx_prescriptions_doctor ON prescriptions (doctor_id);
CREATE INDEX IF NOT EXISTS idx_prescriptions_appointment ON prescriptions (appointment_id);

DO $$
BEGIN
  CREATE TYPE lab_order_status AS ENUM ('ordered', 'completed', 'canceled');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS lab_orders (
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

CREATE INDEX IF NOT EXISTS idx_lab_orders_company ON lab_orders (company_id);
CREATE INDEX IF NOT EXISTS idx_lab_orders_patient ON lab_orders (patient_id);
CREATE INDEX IF NOT EXISTS idx_lab_orders_doctor ON lab_orders (doctor_id);
CREATE INDEX IF NOT EXISTS idx_lab_orders_appointment ON lab_orders (appointment_id);
