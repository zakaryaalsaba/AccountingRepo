import { query } from '../src/db.js';

async function seed() {
  const companyId = process.env.SEED_COMPANY_ID;
  if (!companyId) {
    throw new Error('SEED_COMPANY_ID is required');
  }
  const customer = await query(
    `INSERT INTO customers (company_id, name, email, phone, payment_terms_days, credit_limit, notes)
     VALUES ($1,'Demo Customer','demo.customer@example.com','0500000001',30,50000,'Seeded demo customer')
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [companyId]
  );
  const vendor = await query(
    `INSERT INTO vendors (company_id, name, email, phone, payment_terms_days, notes)
     VALUES ($1,'Demo Vendor','demo.vendor@example.com','0500000002',30,'Seeded demo vendor')
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [companyId]
  );

  const expAcc = await query(
    `SELECT id FROM accounts WHERE company_id = $1 AND code = '5000' LIMIT 1`,
    [companyId]
  );
  const invAcc = await query(
    `SELECT id FROM accounts WHERE company_id = $1 AND code = '1100' LIMIT 1`,
    [companyId]
  );
  const revAcc = await query(
    `SELECT id FROM accounts WHERE company_id = $1 AND code = '4000' LIMIT 1`,
    [companyId]
  );
  const cashAcc = await query(
    `SELECT id FROM accounts WHERE company_id = $1 AND code = '1000' LIMIT 1`,
    [companyId]
  );
  if (!expAcc.rows.length || !invAcc.rows.length || !revAcc.rows.length || !cashAcc.rows.length) {
    throw new Error('Missing required accounts (1000/1100/4000/5000)');
  }

  const today = new Date().toISOString().slice(0, 10);
  const tx = await query(
    `INSERT INTO transactions (company_id, entry_date, description, reference)
     VALUES ($1,$2,'Seed opening journal','SEED-OPEN')
     RETURNING id`,
    [companyId, today]
  );
  const txId = tx.rows[0].id;
  await query(
    `INSERT INTO transaction_lines (transaction_id, account_id, debit, credit)
     VALUES ($1,$2,10000,0), ($1,$3,0,10000)`,
    [txId, cashAcc.rows[0].id, revAcc.rows[0].id]
  );

  console.log('Demo seed completed', {
    companyId,
    customerCreated: customer.rows.length > 0,
    vendorCreated: vendor.rows.length > 0,
    seedTransactionId: txId,
  });
}

seed()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('seed failed', e);
    process.exit(1);
  });

