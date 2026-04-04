# Rollout phase sign-off (real accounting parity)

This document closes the **Suggested Implementation Order** in `tasksRealAccounting.md`. Each phase maps to completed work in that file (sections 1–16 plus migration/rollout §17). Use it for production enablement and audit trail.

## Phase summary

| Phase | Scope | Primary evidence in repo |
|-------|--------|---------------------------|
| **1** | Fiscal year + sequence engine + advanced voucher foundation | `tasksRealAccounting.md` §1–3; migrations `023`–`026`; fiscal/sequence/voucher APIs and UI |
| **2** | Cheque lifecycle + bank settlement / reconciliation | §5–6; migrations `027`–`028`; cheque and settlement routes + screens |
| **3** | Branch / service / project profitability | §7–8; migration `029`–`030`; branch/service/project reports |
| **4** | Service returns, statement depth, print/export | §9–12; migrations `031`–`033`; statements, service invoices/returns, print/export |
| **5** | Workflow, audit, performance | §13–16; migrations `034`–`035`; approvals, audit jobs, UI performance patterns |

## Database scripts — what is required?

| Situation | Required? | What to run |
|-----------|-----------|-------------|
| **New environment** (empty DB) | **Yes** | Load base schema **or** apply every file under `database/migrations/*.sql` in order. Easiest: `bash scripts/run-prod-migrations.sh` (after `DATABASE_URL` is set). |
| **Existing prod/staging** already migrated to current repo | **No** | Re-running idempotent migrations is usually harmless (many use `IF NOT EXISTS`); skip if you know the DB is at head. |
| **You deployed new code that adds migrations** | **Yes** | Apply **only new** files in order, or run `bash scripts/run-prod-migrations.sh` once (applies all, idempotent where written that way). |

**Primary script (recommended):** `scripts/run-prod-migrations.sh`

- Applies **all** `database/migrations/*.sql` in sorted filename order (includes parity phases **023–037**, **038–039** e-sign, etc.).
- Creates a `pg_dump` backup first unless `SKIP_BACKUP=1`.

**E-sign only** (if you ever need DDL without re-running the full set): `bash scripts/run-document-signing-all.sh` — runs `038` + `039` only. Not needed if you already ran the full migration script.

**Optional broader bundle** (migrations + real-accounting subset + voucher backfill + optional API feature flags): `bash scripts/run-prod-master-all.sh` — use when your runbook calls for that full sequence; not strictly required if you only needed schema parity.

**Backfill (data, not DDL):** `server/scripts/backfillVoucherReferences.mjs` — only when your rollout plan says to fix voucher references after migrations.

---

## Production rollout checklist (per company)

1. **Database:** Run the row that matches your situation in the table above (usually `scripts/run-prod-migrations.sh` once per environment upgrade).
2. **Feature flags:** Enable modules per company via `/api/enterprise/feature-flags` (or `company_feature_flags`). See `scripts/prod-module-rollout.sh` for an example batch.
3. **App env:** `DATABASE_URL`, `JWT_SECRET`, optional `DOCUMENTS_MODULE_ENABLED`, `ESIGN_*` for e-sign.
4. **Smoke:** Health check, login, one voucher post, one report, documents list (if module on).

## Sign-off record (fill in per environment)

| Phase | Staging signed off | Production signed off | Notes |
|-------|--------------------|------------------------|-------|
| 1 | ☐ date / owner | ☐ date / owner | |
| 2 | ☐ | ☐ | |
| 3 | ☐ | ☐ | |
| 4 | ☐ | ☐ | |
| 5 | ☐ | ☐ | |

---

**Status:** Implementation phases 1–5 are treated as **complete** in code and schema as of the parity task completion; this file is the formal rollout/sign-off anchor.
