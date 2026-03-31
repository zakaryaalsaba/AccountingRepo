CREATE TABLE IF NOT EXISTS accounting_period_locks (
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

CREATE INDEX IF NOT EXISTS idx_period_locks_company_range
  ON accounting_period_locks (company_id, period_start, period_end);
CREATE INDEX IF NOT EXISTS idx_period_locks_company_closed
  ON accounting_period_locks (company_id, is_closed);
