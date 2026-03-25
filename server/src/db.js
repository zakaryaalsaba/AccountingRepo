import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
function loadCaPem() {
  if (process.env.DB_CA_CERT && String(process.env.DB_CA_CERT).trim()) {
    return String(process.env.DB_CA_CERT).replace(/\\n/g, '\n');
  }

  const candidates = [];
  if (process.env.DB_CA_CERT_PATH) {
    candidates.push(path.resolve(process.cwd(), process.env.DB_CA_CERT_PATH));
  }
  candidates.push(path.join(__dirname, '..', 'ca-certificate.crt'));
  candidates.push(path.join(__dirname, '..', '..', 'database', 'ca-certificate.crt'));

  for (const filePath of candidates) {
    try {
      if (fs.existsSync(filePath)) {
        return fs.readFileSync(filePath, 'utf8');
      }
    } catch {
      // try next
    }
  }
  return null;
}

function sslFromEnv() {
  const url = process.env.DATABASE_URL || '';
  if (!url) return undefined;

  const wantsSsl =
    /sslmode=require|sslmode=verify-full|sslmode=verify-ca|ssl=true/i.test(url) ||
    process.env.DATABASE_SSL === 'true';

  if (!wantsSsl) return undefined;

  const ca = loadCaPem();
  if (ca) {
    return {
      rejectUnauthorized: true,
      ca,
    };
  }

  // No CA file: local dev or missing cert in image — still encrypt, skip chain verify
  console.warn(
    '[db] SSL enabled but no CA found (set DB_CA_CERT / DB_CA_CERT_PATH or add server/ca-certificate.crt). Using rejectUnauthorized: false.'
  );
  return { rejectUnauthorized: false };
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  ssl: sslFromEnv(),
});

/** @param {import('pg').QueryConfig | string} text */
export async function query(text, params) {
  return pool.query(text, params);
}
