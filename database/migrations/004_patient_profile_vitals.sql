-- Patient profile: contact + blood group + latest vital signs (per patient row).

ALTER TABLE patients
  ADD COLUMN IF NOT EXISTS email VARCHAR(255),
  ADD COLUMN IF NOT EXISTS blood_group VARCHAR(30),
  ADD COLUMN IF NOT EXISTS blood_pressure VARCHAR(30),
  ADD COLUMN IF NOT EXISTS heart_rate SMALLINT,
  ADD COLUMN IF NOT EXISTS spo2 SMALLINT,
  ADD COLUMN IF NOT EXISTS temperature_c NUMERIC(5, 2),
  ADD COLUMN IF NOT EXISTS respiratory_rate SMALLINT,
  ADD COLUMN IF NOT EXISTS weight_kg NUMERIC(7, 2);

COMMENT ON COLUMN patients.blood_pressure IS 'e.g. 100/67 (mmHg implied in UI)';
COMMENT ON COLUMN patients.heart_rate IS 'Beats per minute';
COMMENT ON COLUMN patients.spo2 IS 'Oxygen saturation %';
COMMENT ON COLUMN patients.temperature_c IS 'Body temperature °C';
COMMENT ON COLUMN patients.respiratory_rate IS 'Breaths per minute';
COMMENT ON COLUMN patients.weight_kg IS 'Weight in kg';
