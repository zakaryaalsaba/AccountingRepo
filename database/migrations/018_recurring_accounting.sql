DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'recurring_template_type') THEN
    CREATE TYPE recurring_template_type AS ENUM ('invoice', 'bill', 'journal', 'accrual', 'prepayment');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'recurrence_frequency') THEN
    CREATE TYPE recurrence_frequency AS ENUM ('daily', 'weekly', 'monthly', 'quarterly', 'yearly');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS recurring_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  type recurring_template_type NOT NULL,
  name VARCHAR(255) NOT NULL,
  frequency recurrence_frequency NOT NULL DEFAULT 'monthly',
  interval_count INTEGER NOT NULL DEFAULT 1 CHECK (interval_count > 0),
  start_date DATE NOT NULL,
  end_date DATE,
  next_run_date DATE NOT NULL,
  auto_post BOOLEAN NOT NULL DEFAULT FALSE,
  auto_reverse BOOLEAN NOT NULL DEFAULT FALSE,
  reverse_after_days INTEGER NOT NULL DEFAULT 1 CHECK (reverse_after_days >= 0),
  payload JSONB NOT NULL DEFAULT '{}',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  last_run_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_recurring_templates_company_next_run
  ON recurring_templates (company_id, is_active, next_run_date);

CREATE TABLE IF NOT EXISTS recurring_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  template_id UUID NOT NULL REFERENCES recurring_templates (id) ON DELETE CASCADE,
  run_date DATE NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'posted',
  result_transaction_id UUID REFERENCES transactions (id) ON DELETE SET NULL,
  result_record_id UUID,
  reverse_transaction_id UUID REFERENCES transactions (id) ON DELETE SET NULL,
  message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_recurring_runs_company_template
  ON recurring_runs (company_id, template_id, run_date DESC);

CREATE TABLE IF NOT EXISTS journal_auto_reversals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  source_transaction_id UUID NOT NULL REFERENCES transactions (id) ON DELETE CASCADE,
  reverse_on_date DATE NOT NULL,
  reversed_transaction_id UUID REFERENCES transactions (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_transaction_id)
);

CREATE INDEX IF NOT EXISTS idx_journal_auto_reversals_company_date
  ON journal_auto_reversals (company_id, reverse_on_date, reversed_transaction_id);
