CREATE TABLE IF NOT EXISTS customer_reminders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  customer_id BIGINT NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  reminder_date DATE NOT NULL,
  channel VARCHAR(30) NOT NULL DEFAULT 'email',
  subject VARCHAR(255),
  message TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'queued',
  sent_at TIMESTAMPTZ,
  created_by UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_customer_reminders_company_customer
  ON customer_reminders (company_id, customer_id, reminder_date DESC);
