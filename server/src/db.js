import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
});

/** @param {import('pg').QueryConfig | string} text */
export async function query(text, params) {
  return pool.query(text, params);
}
