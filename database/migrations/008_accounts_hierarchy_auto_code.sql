-- Hierarchical accounts with generated account_code and level (1..5).

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS account_code VARCHAR(50),
  ADD COLUMN IF NOT EXISTS level INTEGER;

-- Backfill from existing code for legacy rows.
UPDATE accounts
SET account_code = code
WHERE account_code IS NULL;

-- Compute level from parent chain (roots = 1).
WITH RECURSIVE tree AS (
  SELECT a.id, a.parent_id, 1 AS lvl
  FROM accounts a
  WHERE a.parent_id IS NULL
  UNION ALL
  SELECT c.id, c.parent_id, t.lvl + 1 AS lvl
  FROM accounts c
  JOIN tree t ON c.parent_id = t.id
  WHERE t.lvl < 5
)
UPDATE accounts a
SET level = t.lvl
FROM tree t
WHERE a.id = t.id AND a.level IS NULL;

-- Any orphan/cycle fallback row gets level=1 (safe default).
UPDATE accounts SET level = 1 WHERE level IS NULL;

-- Keep legacy code in sync with the generated account_code for older queries.
UPDATE accounts
SET code = account_code
WHERE code IS DISTINCT FROM account_code;

ALTER TABLE accounts
  ALTER COLUMN account_code SET NOT NULL,
  ALTER COLUMN level SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'accounts_level_range_chk'
  ) THEN
    ALTER TABLE accounts
      ADD CONSTRAINT accounts_level_range_chk CHECK (level BETWEEN 1 AND 5);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_company_account_code
  ON accounts (company_id, account_code);

