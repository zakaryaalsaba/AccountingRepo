#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${API_BASE_URL:-}" || -z "${API_TOKEN:-}" || -z "${COMPANY_ID:-}" ]]; then
  echo "ERROR: API_BASE_URL, API_TOKEN, COMPANY_ID are required."
  exit 1
fi

MODULES=(
  "projects"
  "service_invoices"
  "workflow_controls"
  "audit_compliance"
)

for module in "${MODULES[@]}"; do
  echo "Enabling module: $module"
  curl -sS -X POST "${API_BASE_URL}/api/enterprise/feature-flags/upsert" \
    -H "Authorization: Bearer ${API_TOKEN}" \
    -H "X-Company-Id: ${COMPANY_ID}" \
    -H "Content-Type: application/json" \
    --data "{\"module_key\":\"${module}\",\"is_enabled\":true,\"rollout_stage\":\"ga\",\"note\":\"prod rollout\"}" >/dev/null
done

echo "Verifying module flags"
curl -sS "${API_BASE_URL}/api/enterprise/feature-flags" \
  -H "Authorization: Bearer ${API_TOKEN}" \
  -H "X-Company-Id: ${COMPANY_ID}" \
  -H "Content-Type: application/json"

echo
echo "Rollout script completed."
