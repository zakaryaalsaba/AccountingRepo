import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Set to `true` on App Platform to print full PEM in logs (remove after debugging). */
const DEBUG_SSL = process.env.DB_DEBUG_SSL === 'true' || process.env.DB_DEBUG_SSL === '1';

/**
 * DigitalOcean Managed Postgres: use the cluster CA so Node verifies the chain
 * (avoids SELF_SIGNED_CERT_IN_CHAIN) without rejectUnauthorized: false.
 *
 * Resolution order:
 * 1) DB_CA_CERT — PEM string (e.g. App Platform secret / multiline env)
 * 2) DB_CA_CERT_PATH — absolute or relative path to the PEM file
 * 3) server/ca-certificate.crt (copy of DO “Download CA certificate”; good for App Platform when source is `server/`)
 * 4) database/ca-certificate.crt (monorepo layout)
 *
 * If no CA is found but SSL is required, falls back to rejectUnauthorized: false (dev / legacy).
 */
function loadCaPemWithSource() {
  if (process.env.DB_CA_CERT && String(process.env.DB_CA_CERT).trim()) {
    const pem = String(process.env.DB_CA_CERT).replace(/\\n/g, '\n');
    return { pem, source: 'env:DB_CA_CERT' };
  }

  const candidates = [];
  if (process.env.DB_CA_CERT_PATH) {
    candidates.push({
      path: path.resolve(process.cwd(), process.env.DB_CA_CERT_PATH),
      source: 'env:DB_CA_CERT_PATH',
    });
  }
  candidates.push({
    path: path.join(__dirname, '..', 'ca-certificate.crt'),
    source: 'file:server/ca-certificate.crt',
  });
  candidates.push({
    path: path.join(__dirname, '..', '..', 'database', 'ca-certificate.crt'),
    source: 'file:database/ca-certificate.crt',
  });

  for (const { path: filePath, source } of candidates) {
    try {
      if (fs.existsSync(filePath)) {
        return { pem: fs.readFileSync(filePath, 'utf8'), source: `${source} (${filePath})` };
      }
    } catch {
      // try next
    }
  }
  return { pem: null, source: candidates.map((c) => c.path).filter(Boolean) };
}

function sslFromEnv() {
  const url = process.env.DATABASE_URL || '';
  if (!url) return undefined;

  const wantsSsl =
    /sslmode=require|sslmode=verify-full|sslmode=verify-ca|ssl=true/i.test(url) ||
    process.env.DATABASE_SSL === 'true';

  if (!wantsSsl) return undefined;

  const { pem: ca, source } = loadCaPemWithSource();
  if (ca) {
    return {
      rejectUnauthorized: true,
      ca,
      _debugSource: typeof source === 'string' ? source : JSON.stringify(source),
    };
  }

  // No CA file: local dev or missing cert in image — still encrypt, skip chain verify
  console.warn(
    '[db] SSL enabled but no CA found (set DB_CA_CERT / DB_CA_CERT_PATH or add server/ca-certificate.crt). Using rejectUnauthorized: false.'
  );
  return { rejectUnauthorized: false, _debugSource: 'fallback:rejectUnauthorized:false' };
}

const sslOptions = sslFromEnv();
// pg Pool does not accept custom keys; strip debug metadata before passing to pg
const sslForPool = sslOptions
  ? { ...sslOptions }
  : undefined;
if (sslForPool && '_debugSource' in sslForPool) {
  delete sslForPool._debugSource;
}

export const poolSslDebugSource =
  sslOptions && '_debugSource' in sslOptions ? sslOptions._debugSource : undefined;

function redactDatabaseUrl(u) {
  if (!u) return '';
  return String(u).replace(/(:\/\/)([^/:]+):([^@]+)(@)/, '$1$2:***$4');
}

/** Call before sensitive DB work (e.g. register) to trace SSL + CA in Runtime Logs. */
export function logPoolSslDebug(context = '') {
  const prefix = `[db/ssl]${context ? ` ${context}` : ''}`;
  const url = process.env.DATABASE_URL || '';
  let host = '(no DATABASE_URL)';
  try {
    if (url) host = new URL(url.replace(/^postgres(ql)?:/, 'http:')).hostname || url;
  } catch {
    host = '(parse error)';
  }

  const { pem: ca } = loadCaPemWithSource();
  console.log(`${prefix} DATABASE_URL (redacted)=${redactDatabaseUrl(url)}`);
  console.log(`${prefix} DATABASE_URL host=${host}`);
  console.log(`${prefix} ssl option keys=${sslForPool ? Object.keys(sslForPool).join(',') : 'none'}`);
  console.log(`${prefix} ssl debug source=${poolSslDebugSource ?? 'n/a'}`);

  if (ca) {
    console.log(`${prefix} CA length=${ca.length} chars`);
    console.log(`${prefix} CA preview (first 240 chars):\n${ca.slice(0, 240)}`);
    if (DEBUG_SSL) {
      console.log(`${prefix} CA full PEM:\n${ca}`);
    }
  } else {
    console.log(`${prefix} CA: not loaded (empty)`);
  }
}

// Log once when the API process starts (DigitalOcean Runtime Logs)
logPoolSslDebug('(startup)');

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  ssl: sslForPool,
});

/** @param {import('pg').QueryConfig | string} text */
export async function query(text, params) {
  return pool.query(text, params);
}
