# Documents (e-sign) module

Planned subsystem for DocuSign-like flows inside the same tenant DB and JWT auth.

**Operator / API reference:** [`docs/documents-module.md`](../../../../docs/documents-module.md) (repo root) — environment variables, authenticated and public routes, signing URL shape, migration runbook.

- **Routes:** Mounted from `server/src/index.js` (e.g. `/api/documents` for authenticated CRUD; public signing under `/api/sign` or `/sign` per `taskDocSign.md`).
- **Tenancy:** Authenticated handlers use `authRequired` + `companyContext` (`X-Company-Id`). Public signing uses recipient tokens only; DB access still filtered by `company_id` from the resolved recipient/document.
- **Schema:** PostgreSQL via `database/migrations/` (no Prisma in this repo). **Apply all DocSign DDL at once:** `bash scripts/run-document-signing-all.sh` (requires `DATABASE_URL`).
- **File storage (MVP):** `storage/index.js` → `getEsignStorage()` (local disk; S3-ready interface).
- **Security & tokens:** `security/` — `generateSignToken()` + SHA-256 hash for DB; `resolveSigningContext(plainToken)` for public routes; TTL via `ESIGN_TOKEN_TTL_DAYS`. `middleware/signSubmitRateLimit.js` for `POST /sign/:token`. `featureGate.js` + `middleware/documentsModuleEnabled.js` (`DOCUMENTS_MODULE_ENABLED`, `company_feature_flags.documents`). `permissions.js` + `companyScope.js` — authenticated handlers must use `req.company.id` in every SQL `company_id` predicate; use `canReadDocument` / `canManageDocument` after `attachAuthorization`.
- **Authenticated API:** `routes/documents.js` — `POST /api/documents/upload` (multipart `file`, optional `title`), `GET /api/documents`, `GET|PATCH /api/documents/:id`, `POST /api/documents/:id/send`. PDFs served under `ESIGN_PUBLIC_URL_PATH`.
- **Public signing (no JWT):** `routes/publicSign.js` — **`GET`/`POST` `/api/sign/:token`** and **`/sign/:token`** (same router). Larger JSON limit via `ESIGN_SIGN_JSON_LIMIT`. Sequential signing: `signingOrder.js` + row lock on send.
- **Audit & status:** `auditActions.js` + `statusMachine.js` — canonical actions and document/recipient transition rules; see §6 in `/taskDocSign.md`.

## Integration hooks (future-ready)

Migration **`039_esign_integration_hooks.sql`** (also reflected at the end of `database/schema.sql`) adds **nullable** `esign_document_id` on:

- **`invoices`** — link an invoice to the canonical signed PDF in `esign_documents` once accounting UI/API sets the column.
- **`medical_records`** — same for a clinical chart row (consent, treatment acknowledgment, etc.).

**Rules when wiring product code later**

- Set `esign_document_id` only when the referenced `esign_documents.id` belongs to the **same `company_id`** as the invoice or medical record (FK does not enforce cross-table company match; enforce in application or with a trigger if you need hard guarantees).
- **ON DELETE SET NULL** — deleting an e-sign row clears the link; prefer archiving documents instead of hard delete if you need audit retention.
- **One document per row** — if you need many-to-many (e.g. one invoice with several signed exhibits), add a junction table (e.g. `esign_entity_links`) in a later migration instead of overloading this column.

No REST handlers read or write these columns yet; they are schema-only hooks.

## Testing & ops

**Unit tests** (no server or DB): from `server/`, run `npm run test:esign:unit` — covers signing token helpers, document/recipient status rules, permission helpers, company row scope, and sequential signing turn logic (`tests/esign*.test.mjs`, `tests/esignPermissionsAndSigningOrder.test.mjs`).

**Integration tests** (live API): set `API_BASE_URL`, `TEST_EMAIL`, `TEST_PASSWORD`, `TEST_COMPANY_ID` (same as other repo integration tests). Run `npm run test:integration` — includes **`tests/esignFlow.integration.test.mjs`** (upload → PATCH → send → GET/POST public sign; email is not asserted). Ensure the documents module is enabled for that company and `DOCUMENTS_MODULE_ENABLED` is not `0`.

**Upload backups:** see `storage/README.md` (local `uploads/esign/` vs DB).

Implementation tasks: see `/taskDocSign.md`.
