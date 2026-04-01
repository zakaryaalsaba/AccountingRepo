-- E-sign subsystem: documents, recipients, signature placements, audit trail.
-- Maps to product spec tables: documents, recipients, signatures, audit_logs (prefixed esign_ for clarity).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'esign_document_status') THEN
    CREATE TYPE esign_document_status AS ENUM ('DRAFT', 'SENT', 'SIGNED');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'esign_recipient_status') THEN
    CREATE TYPE esign_recipient_status AS ENUM ('PENDING', 'SIGNED');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS esign_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  title VARCHAR(500) NOT NULL,
  file_url TEXT NOT NULL,
  owner_id UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  status esign_document_status NOT NULL DEFAULT 'DRAFT',
  placements_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_esign_documents_company ON esign_documents (company_id);
CREATE INDEX IF NOT EXISTS idx_esign_documents_company_status ON esign_documents (company_id, status);
CREATE INDEX IF NOT EXISTS idx_esign_documents_owner ON esign_documents (owner_id);

CREATE TABLE IF NOT EXISTS esign_recipients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  document_id UUID NOT NULL REFERENCES esign_documents (id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL,
  signing_order INTEGER NOT NULL DEFAULT 1 CHECK (signing_order >= 1),
  status esign_recipient_status NOT NULL DEFAULT 'PENDING',
  sign_token_hash VARCHAR(128),
  sign_token_expires_at TIMESTAMPTZ,
  signed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (document_id, email)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_esign_recipients_sign_token_hash
  ON esign_recipients (sign_token_hash)
  WHERE sign_token_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_esign_recipients_company ON esign_recipients (company_id);
CREATE INDEX IF NOT EXISTS idx_esign_recipients_document ON esign_recipients (company_id, document_id);
CREATE INDEX IF NOT EXISTS idx_esign_recipients_document_order ON esign_recipients (document_id, signing_order);

CREATE TABLE IF NOT EXISTS esign_signatures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  document_id UUID NOT NULL REFERENCES esign_documents (id) ON DELETE CASCADE,
  recipient_id UUID NOT NULL REFERENCES esign_recipients (id) ON DELETE CASCADE,
  page INTEGER NOT NULL CHECK (page >= 1),
  x NUMERIC(12, 4) NOT NULL,
  y NUMERIC(12, 4) NOT NULL,
  signature_data TEXT NOT NULL,
  signed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_esign_signatures_company ON esign_signatures (company_id);
CREATE INDEX IF NOT EXISTS idx_esign_signatures_document ON esign_signatures (company_id, document_id);
CREATE INDEX IF NOT EXISTS idx_esign_signatures_recipient ON esign_signatures (recipient_id);

CREATE TABLE IF NOT EXISTS esign_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  document_id UUID NOT NULL REFERENCES esign_documents (id) ON DELETE CASCADE,
  action VARCHAR(120) NOT NULL,
  actor VARCHAR(255) NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_esign_audit_logs_company ON esign_audit_logs (company_id);
CREATE INDEX IF NOT EXISTS idx_esign_audit_logs_document ON esign_audit_logs (company_id, document_id);
CREATE INDEX IF NOT EXISTS idx_esign_audit_logs_created ON esign_audit_logs (company_id, created_at DESC);
