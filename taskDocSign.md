# Document Signing Module (DocuSign-like) — Task List

Subsystem inside the existing multi-tenant SaaS. Reuse: same database, `users`, JWT, `company_id` isolation. Do not duplicate auth or create a separate app.

> **Stack alignment (decision):** This repository uses **PostgreSQL + SQL migrations + `pg`** (`server/src/db.js`). The documents module will **not** introduce Prisma; schema lives in `database/migrations/` and `database/schema.sql`, matching the rest of the platform.

---

## 0) Discovery & conventions — **DONE**

- [x] Confirm how `company_id` and JWT are applied today (middleware, route patterns).
- [x] Decide ORM path: Prisma introduction vs SQL migrations only (consistency with existing `server/`).
- [x] Define module path: `server/src/modules/documents/` (or agreed equivalent) and mount routes in `index.js`.
- [x] Add feature flag or env toggle for “Documents” if you want staged rollout.

### Findings (JWT + tenant)

| Concern | How it works in this repo |
|--------|---------------------------|
| **JWT** | `Authorization: Bearer <token>` verified in `server/src/middleware/auth.js` (`authRequired`). Payload sets `req.user = { id: decoded.sub, email }`. Signing uses `JWT_SECRET` / `JWT_EXPIRES_IN`. |
| **Company scope** | After auth, `server/src/middleware/companyContext.js` requires header **`X-Company-Id`**, resolves access via `getAccessibleCompany(companyId, userId)` in `server/src/utils/companyAccess.js` (owner or active `company_members`). On success, **`req.company`** is the full company row. |
| **Client** | `client/src/api/client.js` attaches Bearer token and `X-Company-Id` from `localStorage` (`auth_token`, `current_company_id`). |
| **Route pattern** | Feature routers typically do `router.use(authRequired, companyContext)` then SQL with `WHERE ... company_id = $1` using `req.company.id`. |

**Public signing routes** will **not** use `companyContext` (no company header for external signers). They must resolve `company_id` only **after** validating the recipient signing token, and still scope all writes to that company.

### Conventions to follow

- **Module layout:** Mirror `server/src/modules/clinical/` — aggregate sub-routers from `server/src/modules/documents/` and mount once in `server/src/index.js` (e.g. `app.use('/api/documents', documentsModule)`). See `server/src/modules/documents/README.md`.
- **ORM:** **SQL migrations only** + `query()` from `db.js` (same as `vouchers`, `bankAccounts`, etc.).
- **Feature gating:** Reuse `server/src/utils/featureFlags.js` — `isModuleEnabled(companyId, 'documents', true)` when table `company_feature_flags` exists (migration `036_feature_flags.sql`). Optional global override: **`DOCUMENTS_MODULE_ENABLED`** env (`1` / `0`) checked in documents middleware for a quick kill-switch (to be implemented with the module).

---

## 1) Database schema — **DONE**

- [x] Create `documents` table: `id`, `company_id`, `title`, `file_url`, `owner_id` (FK → users), `status` (`DRAFT` | `SENT` | `SIGNED`), `created_at` (and `updated_at` if standard elsewhere).
- [x] Create `document_recipients` (or `recipients` if name is reserved): `id`, `company_id`, `document_id`, `name`, `email`, `signing_order`, `status` (`PENDING` | `SIGNED`), plus fields for secure signing: `sign_token` (unique), `sign_token_expires_at`, `signed_at` (nullable).
- [x] Create `signatures`: `id`, `company_id`, `document_id`, `recipient_id`, `page`, `x`, `y`, `signature_data`, `signed_at`.
- [x] Create `document_audit_logs` (or reuse generic `audit` if policy allows): `id`, `company_id`, `document_id`, `action`, `actor` (user id or system), `timestamp`, optional `metadata` JSON.
- [x] Add indexes: `(company_id)`, `(document_id)`, `(sign_token)` unique, `(company_id, document_id)` on recipients/signatures.
- [x] Add FKs and ON DELETE rules (e.g. cascade or restrict per product rules).
- [x] Add `database/migrations/0xx_document_signing.sql` and sync `database/schema.sql` (no Prisma).

### Implementation notes

| Spec name | PostgreSQL table | Notes |
|-----------|------------------|--------|
| documents | **`esign_documents`** | Extra: `placements_json` (sender-defined fields before sign), `updated_at`. |
| recipients | **`esign_recipients`** | `sign_token_hash` + `sign_token_expires_at` nullable until **send**; unique token via partial index `WHERE sign_token_hash IS NOT NULL`. Plain token never stored—hash only. |
| signatures | **`esign_signatures`** | One row per captured signature (same recipient may have multiple rows if multiple fields). |
| audit_logs | **`esign_audit_logs`** | `created_at` = timestamp; `actor` VARCHAR (user id UUID string or `system`); `metadata` JSONB. |

- **Migration file:** `database/migrations/038_document_signing.sql` (idempotent `IF NOT EXISTS` / `IF NOT EXISTS` types).
- **Fresh installs:** `database/schema.sql` updated with the same DDL (end of file).
- **Apply on existing DB:** `psql "$DATABASE_URL" -f database/migrations/038_document_signing.sql` (or `scripts/run-prod-migrations.sh` / `scripts/run-all-local.sh`, which apply all `migrations/*.sql` in order).
- **Apply only DocSign DDL (single script):** `bash scripts/run-document-signing-all.sh` (runs `038` + `039` integration hooks; requires `DATABASE_URL`).

---

## 2) Backend — storage abstraction — **DONE**

- [x] Implement storage interface: `saveFile(buffer/stream, meta) → file_url` (MVP: local disk under e.g. `uploads/documents/{company_id}/`).
- [x] Config: max file size, allowed MIME types (PDF MVP), base URL for `file_url`.
- [x] Document future S3 adapter behind same interface (no S3 in MVP).

### Implementation

- **`server/src/modules/documents/storage/index.js`** — `getEsignStorage()`, `getEsignStorageConfig()`; driver `local` only (throws on unknown driver).
- **`server/src/modules/documents/storage/localDiskStorage.js`** — writes `uploads/esign/{companyId}/{uuid}{ext}`, returns `file_url` from public base + path.
- **`server/src/modules/documents/storage/README.md`** — env vars and S3 note.
- **Env (see `server/.env.example`):** `ESIGN_STORAGE_DRIVER`, `ESIGN_UPLOAD_DIR`, `ESIGN_PUBLIC_BASE_URL`, `ESIGN_PUBLIC_URL_PATH`, `ESIGN_MAX_FILE_BYTES`, `ESIGN_ALLOWED_MIME` (default PDF only).
- **Git:** `server/uploads/` ignored in root `.gitignore`.

---

## 3) Backend — security & tokens — **DONE**

- [x] Generate cryptographically secure random `sign_token` per recipient; store hash or raw token per security policy (prefer hash + compare).
- [x] Set TTL on signing links; reject expired/used tokens.
- [x] Ensure all queries filter by `company_id` from JWT context.
- [x] Enforce document owner or role permission before upload/send/detail (define rules).
- [x] Rate-limit or throttle `POST /sign/:token` to reduce abuse.

### Implementation

- **`server/src/modules/documents/security/signToken.js`** — `generateSignToken()` (32-byte base64url), `hashSignToken` (SHA-256 hex), `timingSafeEqualHex`, `signTokenExpiresAt` / `getSignTokenTtlMs` (`ESIGN_TOKEN_TTL_DAYS`, default 14).
- **`server/src/modules/documents/security/resolveSigningContext.js`** — lookup by hash; rejects `not_issued`, `expired`, `already_signed`, non-`SENT` document; checks `assertDocumentsModuleEnabledForCompany`.
- **`server/src/modules/documents/featureGate.js`** — `DOCUMENTS_MODULE_ENABLED=0` + `isModuleEnabled(..., 'documents')`.
- **`server/src/modules/documents/middleware/documentsModuleEnabled.js`** — authenticated stack after `companyContext`.
- **`server/src/modules/documents/middleware/signSubmitRateLimit.js`** — in-memory limiter for `POST /sign/:token` (`ESIGN_SIGN_RATE_LIMIT_WINDOW_MS`, `ESIGN_SIGN_RATE_LIMIT_MAX`).
- **`server/src/modules/documents/permissions.js`** — `documents.read` / `documents.manage`; `canReadDocument`, `canManageDocument`, `companyIdFromRequest`.
- **`server/src/modules/documents/companyScope.js`** — `assertRowCompanyScope` helpers after loads.
- **`server/src/middleware/authorization.js`** — accountant: read+manage; viewer: read only (owner/admin still `*`).

---

## 4) Backend — API (authenticated) — **DONE**

- [x] `POST /api/documents/upload` — multipart upload, create `DRAFT` document, `owner_id` = current user, return document id + metadata.
- [x] `GET /api/documents` — list documents for `company_id` (filters: status, owner, date).
- [x] `GET /api/documents/:id` — detail + recipients + signature placeholders (if stored separately) + audit summary.
- [x] `PATCH /api/documents/:id` (if needed) — title, recipients list, signature positions before send.
- [x] `POST /api/documents/:id/send` — validate recipients, positions, set status `SENT`, generate signing tokens, enqueue email (or log link for MVP), write audit.
- [ ] Optional: `POST /api/documents/:id/recipients`, `POST /api/documents/:id/fields` for split endpoints (not implemented; covered by `PATCH`).

### Implementation

- **Mount:** `app.use('/api', documentsModule)` → `/api/documents/*`. **Static files:** `ESIGN_PUBLIC_URL_PATH` (default `/files/esign`) → `express.static` on `getEsignStorageConfig().uploadRoot`.
- **Router:** `server/src/modules/documents/routes/documents.js` — stack: `authRequired`, `companyContext`, `documentsModuleEnabled`, `attachAuthorization`.
- **Upload:** `multer` memory storage, field **`file`**; optional **`title`** in multipart body. Requires `documents.manage`.
- **List:** query `status`, `owner_id`, `created_from`, `created_to`, `limit` (≤500), `offset`. Requires `documents.read`.
- **Detail / PATCH / send:** `documents.read` + `canReadDocument` for GET; `canManageDocument` (owner or `documents.manage`) for PATCH and send. **DRAFT-only** edits; recipients replaced in full when `recipients` array sent; `placements_json` array `{ page, x, y }`.
- **Send:** sets recipient `sign_token_hash` + `sign_token_expires_at` (`ESIGN_TOKEN_TTL_DAYS`), document `SENT`; returns **`signing_links`**; logs each link; base URL `ESIGN_SIGNING_BASE_URL` or `ESIGN_PUBLIC_BASE_URL` + `/api/sign`.
- **Audit:** `server/src/modules/documents/audit.js` — `uploaded`, `recipients_updated`, `updated`, `sent`.

---

## 5) Backend — API (public signing) — **DONE**

- [x] `GET /api/sign/:token` or `GET /sign/:token` — validate token, return minimal document metadata + fields to sign (no internal user JWT).
- [x] `POST /sign/:token` — accept signature payload, verify recipient order if `signing_order` is enforced, persist `signatures`, update recipient `SIGNED`, when all signed set document `SIGNED`, audit log.
- [x] CORS / cookie policy for public signing page origin if separate host.

### Implementation

- **Mount (before global 1mb JSON):** `app.use('/api/sign', express.json({ limit: ESIGN_SIGN_JSON_LIMIT }), publicSignRoutes)` and same for **`/sign`** — `server/src/modules/documents/routes/publicSign.js`.
- **GET `/:token`:** `resolveSigningContext` + `assertRecipientSigningTurn` (sequential signing); **409** `wrong_order` if not this signer’s turn; audit **`viewed`**. Response: `document` (title, file_url), `recipient` (name), `fields` (from `placements_json`), `signing_order`, `expires_at`.
- **POST `/:token`:** `signSubmitRateLimit`, body `{ signatures: [{ page, x, y, signature_data }] }` (≤30 fields, large base64 OK); **`FOR UPDATE`** document row; re-check turn; insert **`esign_signatures`**; mark recipient **`SIGNED`**; if no pending recipients → document **`SIGNED`**; audit **`signed`** + **`completed`** (system).
- **CORS:** Router uses `cors`; optional **`ESIGN_PUBLIC_SIGNING_ORIGINS`** = comma-separated allowlist (empty = reflect `origin: true` like the rest of the API). **Credentials:** false on this router.

---

## 6) Backend — audit & status transitions — **DONE**

- [x] Log actions: `created`, `uploaded`, `recipients_updated`, `sent`, `viewed`, `signed`, `completed`, `failed`.
- [x] Centralize status machine: document and recipient transitions with validation.

### Implementation

- **`server/src/modules/documents/auditActions.js`** — `ESIGN_AUDIT` constants; `insertEsignAudit` validates action via `assertEsignAuditAction` (`audit.js`).
- **`server/src/modules/documents/statusMachine.js`** — `DOCUMENT_STATUS`, `RECIPIENT_STATUS`, `assertDocumentStatusTransition` (DRAFT→SENT, SENT→SIGNED only), `assertDocumentEditable` (DRAFT), `DOCUMENT_STATUS_SET` for list filters.
- **Audit coverage:** `created` + `uploaded` on upload; `recipients_updated` / `updated` on PATCH; `sent` on send; `viewed` / `signed` / `completed` on public flow; `failed` on send errors, public submit errors (wrong order, not SENT, already_signed, completion invariant, 500).
- **Routes:** Send path locks document row and checks transition before issuing tokens; public POST locks row, requires live status `SENT`, asserts SENT→`SIGNED` when last recipient signs.

---

## 7) Frontend — navigation & shell — **DONE**

- [x] Add sidebar section **Documents** (Arabic-first labels in `ar.json` / `en.json`).
- [x] Register routes: dashboard, upload, detail; public route for signing (may bypass auth layout or use minimal layout).

### Implementation

- **i18n:** `client/src/i18n/locales/ar.json` (primary copy) + `en.json` — `nav.sectionDocuments`, `documents.*` (nav labels, shell placeholders, public signing title).
- **Sidebar:** `DashboardLayout.vue` — group **Documents & e-sign** (`module: 'documents'`) with **Documents** + **Upload**; icon `pen` added in `NavIcon.vue`.
- **Router:** `client/src/router/index.js` — children `documents/upload` (before `documents/:id`), `documents/:id`, `documents`; top-level **`/sign/:token`** (`meta.public`) → `PublicSignView.vue` (no `DashboardLayout`, no auth). `beforeEach` returns early for `meta.public`; `redirectFirstAllowedModule` includes `documents`.
- **Module access:** `stores/company.js` — `canAccessModule('documents')` for **accountant** and **viewer** (with **accounting**); owner/admin unchanged.
- **Shell views (placeholders for §8):** `views/documents/DocumentsDashboardView.vue`, `DocumentUploadView.vue`, `DocumentDetailView.vue`, `PublicSignView.vue`.

---

## 8) Frontend — pages — **DONE**

- [x] **Documents dashboard** — table/cards: title, status, owner, created, actions (view, send if draft).
- [x] **Upload document** — file input, title, optional description; call upload API; redirect to detail.
- [x] **Document details** — show file preview (PDF iframe or viewer), manage recipients (name, email, order), place signature fields (page/x/y) — MVP can be numeric inputs + simple list before a full canvas editor.
- [x] **Signing page (public)** — load by token, show document preview, capture signature (draw or typed image/base64 per MVP), submit POST.

### Implementation

- **API:** `client/src/api/documentsApi.js` (authenticated axios); `client/src/api/esignPublic.js` (public `fetch`, no JWT).
- **Dashboard:** `DocumentsDashboardView.vue` — `GET /api/documents`, status badges, owner email, view / “send” (link to detail for drafts, managers only).
- **Upload:** `DocumentUploadView.vue` — PDF `multipart`, optional title → redirect to detail.
- **Detail:** `DocumentDetailView.vue` — PDF `iframe`, draft: recipients + placements editors, save `PATCH`, send `POST` + modal with signing links; read-only for sent/signed or viewers without manage (document owner who is viewer can still edit draft per backend).
- **Public sign:** `PublicSignView.vue` + `components/documents/SignaturePad.vue` — `GET/POST /api/sign/:token`, one canvas image applied to all `fields` (or default page 1 coords if empty).
- **i18n:** `ar.json` / `en.json` under `documents.*` and `documents.publicError.*`.
- **Signing links in e-mail:** For hash-router SPA, set **`ESIGN_SIGNING_BASE_URL`** to the app origin + hash path pattern if links must open the Vue route (e.g. `https://app.example.com/accountingrepo-client#/sign` or your deployed `base`).

---

## 9) Frontend — UX / i18n / RTL — **DONE**

- [x] All new strings via `vue-i18n` for documents flows; tables/forms use logical layout / `dir` where needed.
- [x] Error states for public signing (expired, wrong order, already signed, etc.) via `documents.publicError.*`.
- [x] Authenticated documents errors mapped via `documentsErrors.js` (module off, forbidden, company/header, network, etc.).
- [x] RTL polish for documents: `navBack` per locale, `text-start` table, `dir="ltr"` on emails/numbers/PDF links, public page + modal `dir`, signature canvas `dir="ltr"`, `aria-live` on errors, table `caption.sr-only`.

---

## 10) Integration hooks (future-ready) — **DONE**

- [x] Optional nullable FKs: `esign_document_id` on `invoices` and `medical_records` — **schema only**, idempotent migration `039_esign_integration_hooks.sql` + `schema.sql` tail; no API wiring yet.
- [x] Documented in `server/src/modules/documents/README.md` (company alignment, ON DELETE SET NULL, junction note for M:N).

---

## 11) Testing & ops — **DONE**

- [x] Unit tests: token hashing / TTL (`esignSecurity.test.mjs`), status transitions + audit actions (`esignStatusMachine.test.mjs`), permission + company scope + signing order (`esignPermissionsAndSigningOrder.test.mjs`).
- [x] Integration test: `tests/esignFlow.integration.test.mjs` — upload → PATCH recipients/placements → send → public GET/POST sign (skipped without `API_BASE_URL` + test credentials; MVP does not send email — links returned in JSON only).
- [x] Backup / production notes: `server/src/modules/documents/storage/README.md` — local `ESIGN_UPLOAD_DIR`, volumes, S3 versioning hint.

---

## 12) Documentation — **DONE**

- [x] **`docs/documents-module.md`** — env vars table, upload directory pointer, authenticated + public API list, signing URL format, client pointers.
- [x] **Runbook** — migration order (`036` feature flags note → `038` → `039`), `scripts/run-document-signing-all.sh`, fresh `schema.sql` note; linked from root **`README.md`**.

---

## Summary checklist (quick)

| Area | Done |
|------|------|
| Schema + migrations | [x] |
| Storage layer (local MVP) | [x] |
| Auth routes + company isolation | [x] (documents CRUD API) |
| Signing tokens + public endpoints | [x] |
| Vue pages + sidebar + i18n | [x] |
| Audit + status flow | [x] |
| Integration hooks (nullable FKs) | [x] |
| Testing & ops (§11) | [x] |
| Module docs / runbook (§12) | [x] |
