-- Future-ready links from accounting / clinical rows to signed documents (taskDocSign §10).
-- Nullable FKs only — no API or UI wiring yet. Safe on existing DBs (IF NOT EXISTS).

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS esign_document_id UUID REFERENCES esign_documents (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_invoices_esign_document
  ON invoices (esign_document_id)
  WHERE esign_document_id IS NOT NULL;

ALTER TABLE medical_records
  ADD COLUMN IF NOT EXISTS esign_document_id UUID REFERENCES esign_documents (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_medical_records_esign_document
  ON medical_records (esign_document_id)
  WHERE esign_document_id IS NOT NULL;
