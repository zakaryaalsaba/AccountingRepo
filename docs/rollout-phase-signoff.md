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

## Production rollout checklist (per company)

1. **Database:** Apply migrations in order (`scripts/run-prod-migrations.sh` or managed DB job). DocSign is separate (`scripts/run-document-signing-all.sh` if needed).
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
