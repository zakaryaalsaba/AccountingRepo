-- Clinical module (MVP). Multi-tenant: every table includes company_id.

DO $$
BEGIN
  CREATE TYPE patient_gender AS ENUM ('male', 'female');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE appointment_status AS ENUM ('scheduled', 'completed', 'cancelled');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS patients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  full_name VARCHAR(255) NOT NULL,
  phone VARCHAR(50),
  date_of_birth DATE,
  gender patient_gender,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_patients_company ON patients (company_id);
CREATE INDEX IF NOT EXISTS idx_patients_company_name ON patients (company_id, full_name);

CREATE TABLE IF NOT EXISTS appointments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  patient_id UUID NOT NULL REFERENCES patients (id) ON DELETE CASCADE,
  appointment_date TIMESTAMPTZ NOT NULL,
  status appointment_status NOT NULL DEFAULT 'scheduled',
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_appointments_company ON appointments (company_id);
CREATE INDEX IF NOT EXISTS idx_appointments_company_date ON appointments (company_id, appointment_date);
CREATE INDEX IF NOT EXISTS idx_appointments_patient ON appointments (patient_id);

CREATE TABLE IF NOT EXISTS medical_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  patient_id UUID NOT NULL REFERENCES patients (id) ON DELETE CASCADE,
  diagnosis TEXT,
  treatment TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_medical_records_company ON medical_records (company_id);
CREATE INDEX IF NOT EXISTS idx_medical_records_patient ON medical_records (patient_id);

CREATE TABLE IF NOT EXISTS insurance_providers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  contact_info TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_insurance_providers_company ON insurance_providers (company_id);

CREATE TABLE IF NOT EXISTS patient_insurances (
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

CREATE INDEX IF NOT EXISTS idx_patient_insurances_company ON patient_insurances (company_id);
CREATE INDEX IF NOT EXISTS idx_patient_insurances_patient ON patient_insurances (patient_id);
CREATE INDEX IF NOT EXISTS idx_patient_insurances_provider ON patient_insurances (provider_id);
