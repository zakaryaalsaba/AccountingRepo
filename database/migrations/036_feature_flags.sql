-- Feature flags for module-by-module rollout

CREATE TABLE IF NOT EXISTS company_feature_flags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  module_key VARCHAR(120) NOT NULL,
  is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  rollout_stage VARCHAR(40) NOT NULL DEFAULT 'ga',
  note TEXT,
  updated_by UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, module_key)
);

CREATE INDEX IF NOT EXISTS idx_company_feature_flags_company_module
  ON company_feature_flags (company_id, module_key, is_enabled);
