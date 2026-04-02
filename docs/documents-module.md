# Document signing (e-sign) module

Multi-tenant PDF signing inside the same PostgreSQL database and JWT session as the rest of the app. Implementation lives under `server/src/modules/documents/`. Task checklist: `/taskDocSign.md`.

---

## Runbook: migrations (order)

Apply **after** core schema and any dependencies:

| Order | File | Purpose |
|-------|------|---------|
| (prerequisite) | `036_feature_flags.sql` | Optional per-company toggles; `company_feature_flags.module_key = 'documents'` |
| 1 | `038_document_signing.sql` | `esign_documents`, `esign_recipients`, `esign_signatures`, `esign_audit_logs`, enums, indexes |
| 2 | `039_esign_integration_hooks.sql` | Nullable `esign_document_id` on `invoices` and `medical_records` |

**Fresh install:** `database/schema.sql` already includes the e-sign DDL and integration hooks at the end of the file.

**Existing database — DocSign only:**

```bash
export DATABASE_URL='postgresql://...'
bash scripts/run-document-signing-all.sh
```

That script runs `038` then `039` in order. For a full platform rollout, apply all `database/migrations/*.sql` in numeric filename order (see root `README.md`).

---

## Environment variables

All server-side; copy from `server/.env.example` (`ESIGN_*` and `DOCUMENTS_MODULE_ENABLED`).

| Variable | Default / notes |
|----------|-----------------|
| `DOCUMENTS_MODULE_ENABLED` | If `0`, authenticated documents routes and public signing reject the module. Omit or `1` to allow (subject to `company_feature_flags` when that table exists). |
| `ESIGN_STORAGE_DRIVER` | `local` (only driver in MVP). |
| `ESIGN_UPLOAD_DIR` | Relative to server CWD unless absolute; default `uploads/esign`. Actual files: `{uploadRoot}/{companyId}/...`. |
| `ESIGN_PUBLIC_BASE_URL` | Base used for `file_url` and default signing link host (e.g. `http://localhost:4000`). |
| `ESIGN_PUBLIC_URL_PATH` | HTTP path for `express.static` over the upload root (default `/files/esign`). PDFs are served at `{origin}{ESIGN_PUBLIC_URL_PATH}/...`. |
| `ESIGN_MAX_FILE_BYTES` | Upload size cap (default 15 MB in code/config). |
| `ESIGN_ALLOWED_MIME` | Default `application/pdf`. |
| `ESIGN_TOKEN_TTL_DAYS` | Signing link expiry after send (default 14). |
| `ESIGN_SIGNING_BASE_URL` | Optional. If set, signing links from `POST .../send` use this prefix instead of `{ESIGN_PUBLIC_BASE_URL}/api/sign`. No trailing slash. |
| `ESIGN_SIGN_JSON_LIMIT` | Body limit for `POST /api/sign` and `POST /sign` (default `15mb`). |
| `ESIGN_SIGN_RATE_LIMIT_WINDOW_MS` / `ESIGN_SIGN_RATE_LIMIT_MAX` | In-memory throttle for signature submit. |
| `ESIGN_PUBLIC_SIGNING_ORIGINS` | Optional comma-separated CORS allowlist for signing routes only. |

**Upload directory (local):** see `server/src/modules/documents/storage/README.md` for backup and production volume notes.

---

## Authenticated API (`Authorization: Bearer`, `X-Company-Id`)

Requires `documents.read` or `documents.manage` (and module enabled). Base path: **`/api/documents`**.

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/documents/upload` | Multipart field **`file`** (PDF), optional **`title`**. Creates `DRAFT`. |
| `GET` | `/api/documents` | List; query: `status`, `owner_id`, `created_from`, `created_to`, `limit`, `offset`. |
| `GET` | `/api/documents/:id` | Detail, recipients, recent audit rows. |
| `PATCH` | `/api/documents/:id` | DRAFT only: `title`, `placements_json`, `recipients[]` (`name`, `email`, `signing_order`). |
| `POST` | `/api/documents/:id/send` | Issues signing tokens; returns **`signing_links`** `{ email, name, link }`; document becomes `SENT`. |

---

## Public signing (no JWT)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/sign/:token` | Load session: document metadata, `fields` from placements. |
| `POST` | `/api/sign/:token` | Body: `{ "signatures": [ { "page", "x", "y", "signature_data" } ] }`. Sequential order enforced across recipients. |

Same router is also mounted at **`/sign/:token`** (hash-friendly SPA paths).

**Signing URL format**

- Plain token is a long opaque string; it appears **URL-encoded** as the last path segment.
- Default link shape: `{ESIGN_SIGNING_BASE_URL or ESIGN_PUBLIC_BASE_URL + "/api/sign"}/{encodeURIComponent(plainToken)}`
- Example: `https://api.example.com/api/sign/AbCdEf...`

Tokens are stored hashed in the database; the link contains the **plain** token once, at send time (logged server-side in MVP; email integration is separate).

---

## Troubleshooting (e.g. DigitalOcean App Platform)

### “Failed to list documents” (HTTP 500) or schema message (HTTP 503)

The UI calls `GET /api/documents`. A **500** with `Failed to list documents` means the handler caught a database error. The most common cause on a new environment is **missing e-sign tables** (migrations `038` / `039` not applied to the **same** Postgres instance the app uses).

**Fix:** Point `DATABASE_URL` at production and run:

```bash
bash scripts/run-document-signing-all.sh
```

Or apply all migrations in order (`scripts/run-prod-migrations.sh`). After deploy, the API may return **503** with an explicit message when PostgreSQL reports `undefined_table` (`42P01`).

**Confirm:** In App Platform **Runtime Logs**, search for `esign_documents` or `42P01`. In `psql`, `\dt esign_*` should list `esign_documents`, `esign_recipients`, etc.

### Module disabled (HTTP 403)

- Server env: `DOCUMENTS_MODULE_ENABLED` must not be `0`.
- If `company_feature_flags` exists, enable `module_key = 'documents'` for that company (Enterprise feature flags API or SQL).

### API URL / CORS (wrong host, not “Failed to list documents”)

The production build must use the correct API origin. Set **`VITE_API_URL`** at build time to your public API base (e.g. `https://accountingsaas-app-jxf9f.ondigitalocean.app` or your API subdomain) **if** the browser does not serve `/api` from the same origin. The client uses `base: '/accountingrepo-client/'` in Vite (`client/vite.config.js`); API requests use `VITE_API_URL` + `/api/...`.

---

## Client (Vue)

Routes and API helpers: `client/src/views/documents/`, `client/src/api/documentsApi.js`, `client/src/api/esignPublic.js`. Sidebar access uses `canAccessModule('documents')` and company feature flags.

---

## Further reading

- `server/src/modules/documents/README.md` — architecture, integration hooks, tests.
- `server/src/modules/documents/storage/README.md` — storage contract, backups, S3 direction.
