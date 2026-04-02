# Real Accounting Parity Tasks (Multi-Company Version)

This checklist is derived from the reference screenshots in `/Users/zakaryaalsaba/Desktop/screenAccounting`.

Important scope note:
- The reference system appears single-company.
- Our app is multi-tenant, so every task below must enforce strict `company_id` isolation and company-aware numbering/permissions.

---

## 1) Fiscal Year and Period Foundation

- [x] Build `fiscal_years` master (per company): year code, Arabic/English name, start date, end date, active flag, closed flag.
- [x] Add validation to prevent overlapping fiscal years within the same company.
- [x] Support opening balances process tied to selected fiscal year.
- [x] Add year status transitions: draft -> active -> closing -> closed.
- [x] Prevent posting to closed fiscal years (in addition to monthly period locks).
- [x] Add fiscal year switcher in UI for reports and voucher entry defaults.
- [x] Add API to clone chart/settings from prior fiscal year for same company.
- [x] Add "new fiscal year wizard" with checks (unposted docs, unbalanced suspense, open reconciliations).

## 2) Voucher Numbering and Document Sequences

- [x] Create company-scoped sequence engine by document type and fiscal year.
- [x] Support manual override with permission + audit trail (who/when/why).
- [x] Detect and report missing/duplicate voucher numbers.
- [x] Add prefix formats (e.g., JV-2026-000123) configurable per company.
- [x] Add branch/department-aware optional sequence dimensions.
- [x] Add "renumber draft-only" utility for safe cleanup before posting.

## 3) Journal Voucher Workbench (Advanced)

- [x] Build richer journal voucher form matching reference workflow (header + dynamic lines + totals + attachments).
- [x] Add line actions: insert row, duplicate row, remove row, row-level notes.
- [x] Add automatic balancing assistant (suggest counterpart line).
- [x] Add templates for frequent journal entries.
- [x] Add "save draft", "post", "reverse", "copy as new", "print".
- [x] Add partial edit rules: draft editable, posted restricted with reversal-only policy.
- [x] Add per-line dimension tagging (branch/project/service center) with required-field policy options.
- [x] Add voucher import from CSV with dry-run validation.

## 4) Receipt/Payment/Transfer Voucher Families

- [x] Standardize separate voucher families: receipt, payment, transfer, adjustment.
- [x] Add shared engine with family-specific rules and UX.
- [x] For receipts: allocate across invoices, advances, and on-account balances.
- [x] For payments: allocate across bills, prepayments, and credit notes.
- [x] For transfers: enforce source/destination treasury or bank account constraints.
- [x] Add support for foreign currency and exchange gain/loss auto-posting.
- [x] Add print layouts per voucher family in Arabic + English.

## 5) Cheque Lifecycle Management (Strong Gap vs Screens)

- [x] Add incoming cheque register (received cheques).
- [x] Add outgoing cheque register (issued cheques).
- [x] Implement full status flow: received/issued -> under collection -> cleared -> bounced -> cancelled -> replaced.
- [x] Support due-date tracking and calendar reminders.
- [x] Add cheque portfolio reports by status/date/account/customer/vendor.
- [x] Add cheque-specific accounting automation for each status transition.
- [x] Add replacement and endorsement flows with strict audit events.
- [x] Add attachment requirement for bounced/cancelled reasons.

## 6) Bank Settlement and Reconciliation Expansion

- [x] Extend bank reconciliation to support settlement batches and reference matching.
- [x] Add match strategies: exact amount/date, fuzzy date window, memo/ref number.
- [x] Add manual pairing UI with conflict warnings.
- [x] Add unresolved differences bucket and write-off workflows.
- [x] Add reconciliation statement print/export with opening/closing balances.
- [x] Add "reconciliation lock" to freeze approved month-end reconciliation.
- [x] Add reconciliation reviewer/approver role flow.
- [x] Add automatic bank fee and interest line suggestions.

## 7) Branch/Cost Center/Service Card Structure

- [x] Add `branches` master table (per company) with active/inactive status.
- [x] Add "service card" or "service center" master for operational profitability tracking.
- [x] Link transactions and vouchers to branch/service card dimensions.
- [x] Add required-dimension policies by account class (optional/mandatory).
- [x] Add branch-level trial balance and P&L slices.
- [x] Add service-center revenue/cost/profit rollups.

## 8) Project Accounting and Profitability

- [x] Add `projects` master (status, customer, dates, manager, budget).
- [x] Track project-level revenues, costs, advances, and retention.
- [x] Support project-linked vouchers and invoices.
- [x] Add WIP handling options for long-running projects.
- [x] Add project balance and profitability reports (as seen in reference).
- [x] Add project variance vs budget and margin KPIs.

## 9) Customer and Vendor Statement Depth

- [x] Upgrade customer statement options: by period, branch, currency, include opening, include unposted.
- [x] Upgrade vendor statement options with settlement aging and payment references.
- [x] Add "account statement detailed card" style report with running balance.
- [x] Add customer/vendor transaction drilldown from statement rows.
- [x] Add statement confirmation workflow (sent/acknowledged/disputed).

## 10) Service Invoice and Return Workflows

- [x] Add dedicated service invoice workflow (distinct from product-focused flows).
- [x] Add service return invoice workflow with clear link to original document.
- [x] Support partial return quantities/values and tax recalculation.
- [x] Add controls preventing over-return against original invoice.
- [x] Add profitability impact tracking for service returns.

## 11) Advanced Reporting Library (Parity-Oriented)

- [x] Build report catalog grouped by: treasury, cheques, cards, projects, services, branches.
- [x] Add account card report variants (summary vs detailed vs grouped).
- [x] Add treasury movement reports (by safe/bank/branch/date/user).
- [x] Add cheque movement and status history reports.
- [x] Add branch code summary reports.
- [x] Add service return invoice reports.
- [x] Add customizable report columns and saved report views.
- [x] Add server-side pagination and totals for large report datasets.

## 12) Print, Export, and Document Outputs

- [x] Provide printable Arabic RTL templates matching voucher/report families.
- [x] Add PDF output with official layout: logo, signatures, stamps, footer metadata.
- [x] Add Excel export with typed columns and totals.
- [x] Add print preview with page-break aware tables.
- [x] Add watermark states (draft, cancelled, reversed).

## 13) Workflow, Controls, and Approvals

- [x] Expand approvals by document type and amount thresholds.
- [x] Add maker-checker flow for sensitive operations (cheques, year-close, bulk posting).
- [x] Add per-role limits (post up to amount X, approve up to amount Y).
- [x] Add mandatory reason and attachment for cancellation/reversal.
- [x] Add lock after approval to prevent silent edits.
- [x] Add notification center for pending approvals and rejected documents.

## 14) Audit and Compliance Enhancements

- [x] Extend audit events to include before/after snapshots for key entities.
- [x] Add immutable timeline per voucher (create/edit/post/approve/print/export).
- [x] Add "who printed/exported" tracking for sensitive reports.
- [x] Add sequence integrity and gap-monitor jobs.
- [x] Add suspicious activity checks (mass edits, backdated posts, weekend postings).

## 15) Multi-Company Adaptation Rules (Mandatory for Every New Feature)

- [x] Ensure all new tables include `company_id` + indexed company/date keys.
- [x] Ensure all API list/get/mutate routes enforce company-scoped access checks.
- [x] Scope numbering sequences per company (and fiscal year).
- [x] Scope branch/project/service masters per company.
- [x] Ensure reports never aggregate across companies unless explicitly requested by super-admin tooling.
- [x] Add tests to verify cross-company data cannot be read or mutated.
- [x] Ensure cache keys and background jobs include company context.

## 16) UX and Performance for Heavy Accounting Screens

- [x] Build "power entry" keyboard navigation for voucher lines.
- [x] Add account search by code/name/alias with quick-select.
- [x] Add sticky totals/footer on long line-entry forms.
- [x] Add fast filters and saved search presets in reports.
- [x] Add virtualized tables for very large reports.
- [x] Add optimistic draft saving with recovery after refresh.

## 17) Data Migration and Rollout Plan

- [x] Create migrations for fiscal years, branches, projects, cheques, and settlement entities.
- [x] Add backfill scripts for existing vouchers (sequence/fiscal year mapping).
- [x] Add feature flags to release module-by-module safely.
- [x] Add production runbook for enabling each module per company.
- [x] Add smoke and integration tests covering new end-to-end flows.

---

## Suggested Implementation Order — **DONE** (sign-off: `docs/rollout-phase-signoff.md`)

- [x] Phase 1: Fiscal year + sequence engine + advanced voucher foundation.
- [x] Phase 2: Cheque lifecycle + bank settlement/reconciliation expansion.
- [x] Phase 3: Branch/service/project profitability dimensions and reports.
- [x] Phase 4: Service return invoices, statement depth, and print/export parity.
- [x] Phase 5: Workflow controls, audit hardening, and performance tuning.

