-- Vital signs recorded per visit (appointment), not only on the patient row.

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS blood_pressure VARCHAR(30),
  ADD COLUMN IF NOT EXISTS heart_rate SMALLINT,
  ADD COLUMN IF NOT EXISTS spo2 SMALLINT,
  ADD COLUMN IF NOT EXISTS temperature_c NUMERIC(5, 2),
  ADD COLUMN IF NOT EXISTS respiratory_rate SMALLINT,
  ADD COLUMN IF NOT EXISTS weight_kg NUMERIC(7, 2);
