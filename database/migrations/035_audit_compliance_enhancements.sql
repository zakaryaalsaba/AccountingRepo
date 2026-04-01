-- Audit and compliance enhancements

CREATE TABLE IF NOT EXISTS audit_monitor_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  job_type VARCHAR(80) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'completed',
  result_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_audit_monitor_jobs_company_type
  ON audit_monitor_jobs (company_id, job_type, started_at DESC);
