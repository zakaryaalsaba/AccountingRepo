# Accounting Parity Gap List (Post Screenshot Re-Review)

This checklist is a second-pass gap list after re-reviewing the reference screenshots in `/Users/zakaryaalsaba/Desktop/screenAccounting`.

Notes:
- `tasksRealAccounting.md` is mostly completed.
- This file captures remaining parity items that are still missing or only partially implemented in UX/flow.
- All items must remain multi-company aware (`company_id` scoped).

---

## 1) Fiscal Year UI Parity (Remaining)

- [ ] Build a dedicated fiscal-year management screen (list + modal form) matching screenshot workflow.
- [ ] Add Arabic and English fiscal year name fields in the UI form with validation.
- [ ] Add explicit `active` and `closed` toggles in the fiscal-year form (not only backend status handling).
- [ ] Add in-screen actions for fiscal years: edit, close, reopen, set active.

## 2) Chart of Accounts UX Parity (Remaining)

- [ ] Add row action dropdown for account list (edit, move account, delete) like the screenshot context menu.
- [ ] Add account form fields for parent/root selection and financial statement mapping in one screen.
- [ ] Add "show suspended/disabled accounts" and bulk account tools in the account list.
- [ ] Add account move/re-parent flow with safeguards and audit logs.

## 3) Voucher Entry Parity (Family-Specific Screens)

- [ ] Build separate rich forms for receipt/payment/transfer (currently mostly consolidated/generalized flows).
- [ ] Add full header controls from screenshot patterns: branch, counterparty class, currency rate, due date, linked document references.
- [ ] Add family-specific line grids and totals sections that mirror real voucher layouts.
- [ ] Add family-specific print preview and posting status controls directly from form screens.

## 4) Bank and Treasury Masters (UI Depth)

- [ ] Build full bank master form with operational fields seen in screenshots (branch, IBAN/SWIFT-like info, account owner, opening metadata).
- [ ] Add treasury/safe master pages with create/edit/list workflows in frontend navigation.
- [ ] Add bank account opening balance wizard with posting date control and audit trail.

## 5) Cheque Workflows (Operational Screens)

- [ ] Add dedicated "beginning cheques/opening cheques" entry screen for migration/start-of-period setup.
- [ ] Add cheque-issued and cheque-received operational forms with batch line entry parity.
- [ ] Add cheque state transition actions directly from UI tables (collect, clear, bounce, replace, cancel).
- [ ] Add cheque-linked voucher tracing UI (drill to journal/voucher lines).

## 6) Bank Settlement UX Completion

- [ ] Add interactive settlement page with two-pane matching (bank lines vs book lines) similar to screenshot behavior.
- [ ] Add explicit difference analysis panel and suggested adjustment entries in the same screen.
- [ ] Add reconciliation printout controls (preview/print/export) from settlement view.

## 7) Report Library UI Parity (Large Gap)

- [ ] Build report menu pages for all implemented backend reports (many exist in API but not exposed in UI).
- [ ] Add dedicated screens for project balance, service return reports, cheque history, treasury movements, and branch code summary.
- [ ] Add advanced report filters matching screenshot style (account type, level, branch, card/project codes, date windows).
- [ ] Add consistent print/export buttons on each report page.
- [ ] Add report favorites/shortcuts panel similar to screenshot side report navigation.

## 8) Credit Card / Card Statement Reports

- [ ] Add credit-card statement tracking screens (reference screenshots include card-focused report views).
- [ ] Add card-level filters and settlement status indicators in reports.
- [ ] Add card expense and payable linkage drilldown from card reports.

## 9) Workflow and Approvals UI Completion

- [ ] Build a dedicated approvals inbox page (pending/rejected/approved) for makers and checkers.
- [ ] Add approval actions directly from document detail pages (approve/reject with reason).
- [ ] Add lock-state indicators and editable-state banners on locked/approved documents.

## 10) Final Consistency Pass

- [ ] Ensure all newly added parity screens are fully bilingual (Arabic/English) and RTL/LTR correct.
- [ ] Ensure all parity pages support mobile responsiveness without losing table usability.
- [ ] Add end-to-end smoke tests covering the new UI routes and critical actions.

---

## Suggested Execution Order

- [ ] Phase A: Fiscal year + accounts UI parity.
- [ ] Phase B: Voucher family dedicated forms + bank/treasury masters.
- [ ] Phase C: Cheque opening/operations + settlement UX.
- [ ] Phase D: Full report library UI + card statement reports.
- [ ] Phase E: Approvals inbox + final localization/mobile/test pass.
