# Accounting SaaS (multi-tenant)

Arabic-first (RTL) accounting web app: **Vue 3 + Vite + Pinia + Tailwind + vue-i18n** on the frontend, **Express + PostgreSQL + JWT** on the backend. Each user can own multiple companies; all accounting rows are scoped by `company_id`. The API enforces access via **JWT** and the **`X-Company-Id`** header.

## Prerequisites

- Node.js 20+
- PostgreSQL 14+ (or Docker)

## 1. Database

Start PostgreSQL (example with Docker):

```bash
docker compose up -d
```

Create schema (Docker maps Postgres to **host port 5433** so it does not fight with a local Postgres on 5432):

```bash
psql "postgresql://postgres:postgres@localhost:5433/accounting_saas" -f database/schema.sql
```

**Already have a database?** Apply incremental SQL under `database/migrations/` in order (e.g. invoice GL columns):

```bash
psql "postgresql://postgres:postgres@localhost:5433/accounting_saas" -f database/migrations/001_invoice_gl_postings.sql
```

**Invoices** auto-post journals: creating a non-draft invoice posts **Dr A/R (1100) / Cr Revenue (4000)**; marking **paid** posts **Dr Cash (1000) / Cr A/R (1100)**. Draft invoices are not posted until status leaves draft.

If you see `FATAL: role "postgres" does not exist`, `psql` is almost certainly talking to **another** server on port 5432 (e.g. Homebrew PostgreSQL). Use the URL above with **5433**, or stop the local service: `brew services list` then `brew services stop postgresql@XX`.

## 2. Backend

```bash
cd server
cp .env.example .env
# Set DATABASE_URL and JWT_SECRET in .env
npm install
npm run dev
```

API base: `http://localhost:4000`  
Health: `GET /health`

### Auth

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/auth/register` | Body: `{ email, password, full_name? }` → `{ user, token }` |
| POST | `/api/auth/login` | Body: `{ email, password }` → `{ user, token }` |
| GET | `/api/auth/me` | Header: `Authorization: Bearer <token>` |

### Companies (JWT)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/companies` | List accessible companies |
| POST | `/api/companies` | Body: `{ name, industry? }` — creates company and default chart of accounts |
| GET | `/api/companies/:id` | Company detail |

### Company-scoped routes (JWT + `X-Company-Id`)

| Module | Prefix | Notes |
|--------|--------|--------|
| Accounts | `/api/accounts` | CRUD chart of accounts |
| Transactions | `/api/transactions` | Double-entry journal; lines with debit/credit |
| Invoices | `/api/invoices` | Customer invoices |
| Expenses | `/api/expenses` | Links to `EXPENSE` accounts |
| Reports | `/api/reports/profit-loss` | Query: `from`, `to` |
| Reports | `/api/reports/balance-sheet` | Query: `as_of` |

## 3. Frontend

```bash
cd client
npm install
npm run dev
```

Open `http://localhost:5173`. Vite proxies `/api` to `http://localhost:4000` during development.

For production builds, set `VITE_API_URL` to your public API origin (see `client/.env.example`).

```bash
npm run build
```

## Design notes (future-ready)

- **`company_members`** + `role` supports RBAC (admin, accountant) without changing core tables.
- **`companies.industry`** can drive industry-specific modules (e.g. real estate, restaurants).
- **Invoices / expenses** in this MVP are standalone records; you can later add posting to the general ledger for full automation.

## Project layout

```
database/schema.sql    # PostgreSQL DDL
server/src             # Express modules (auth, companies, accounts, …)
client/src             # Vue app, Pinia, i18n (ar default, en secondary)
```
