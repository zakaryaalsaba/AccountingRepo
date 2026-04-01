import 'dotenv/config';
import { Pool } from 'pg';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const APPLY = process.env.APPLY === '1';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function pad(n, p = 6) {
  return String(Number(n || 0)).padStart(p, '0');
}

async function main() {
  const client = await pool.connect();
  try {
    const missing = await client.query(
      `SELECT id, company_id, entry_date
       FROM transactions
       WHERE reference IS NULL
       ORDER BY company_id, entry_date, created_at`
    );
    const grouped = new Map();
    for (const r of missing.rows) {
      const key = `${r.company_id}:${String(r.entry_date).slice(0, 4)}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(r);
    }
    const updates = [];
    for (const [key, rows] of grouped.entries()) {
      const [companyId, year] = key.split(':');
      const max = await client.query(
        `SELECT reference
         FROM transactions
         WHERE company_id = $1
           AND reference LIKE $2
         ORDER BY reference DESC
         LIMIT 1`,
        [companyId, `JV-${year}-%`]
      );
      let next = 1;
      if (max.rows[0]?.reference) {
        const m = String(max.rows[0].reference).match(/(\d+)(?!.*\d)/);
        if (m) next = Number(m[1]) + 1;
      }
      for (const r of rows) {
        const reference = `JV-${year}-${pad(next++)}`;
        updates.push({ id: r.id, reference });
      }
    }
    console.log(`Would update ${updates.length} transaction references.`);
    if (!APPLY) {
      console.log('Dry-run mode. Set APPLY=1 to persist changes.');
      console.log(JSON.stringify(updates.slice(0, 20), null, 2));
      return;
    }
    await client.query('BEGIN');
    for (const u of updates) {
      await client.query(
        `UPDATE transactions
         SET reference = $1
         WHERE id = $2 AND reference IS NULL`,
        [u.reference, u.id]
      );
    }
    await client.query('COMMIT');
    console.log(`Applied ${updates.length} updates.`);
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
