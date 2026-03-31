#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="/Users/zakaryaalsaba/Desktop/AccountingRepo"
DB_URL_LOCAL="${DB_URL_LOCAL:-postgresql://postgres:postgres@localhost:5433/accounting_saas}"

echo "==> Starting local Postgres (docker compose)"
docker compose -f "$ROOT_DIR/docker-compose.yml" up -d

echo "==> Applying full schema"
psql "$DB_URL_LOCAL" -f "$ROOT_DIR/database/schema.sql"

echo "==> Applying all migrations (idempotent where supported)"
for f in "$ROOT_DIR"/database/migrations/*.sql; do
  echo "Applying: $f"
  psql "$DB_URL_LOCAL" -f "$f"
done

echo "==> Installing server dependencies"
npm --prefix "$ROOT_DIR/server" install

echo "==> Installing client dependencies"
npm --prefix "$ROOT_DIR/client" install

echo "==> Building client"
npm --prefix "$ROOT_DIR/client" run build

cat <<'EOF'

Done.
Next:
1) API: npm --prefix "/Users/zakaryaalsaba/Desktop/AccountingRepo/server" run dev
2) UI:  npm --prefix "/Users/zakaryaalsaba/Desktop/AccountingRepo/client" run dev

Optional:
- Seed demo data:
  SEED_COMPANY_ID=<company-uuid> npm --prefix "/Users/zakaryaalsaba/Desktop/AccountingRepo/server" run seed:demo

EOF
