const TYPE_ROOT_BASE = {
  ASSET: 1000,
  LIABILITY: 2000,
  EQUITY: 3000,
  REVENUE: 4000,
  EXPENSE: 5000,
};

function toIntCode(v) {
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) ? n : null;
}

async function codeExists(client, companyId, code) {
  const r = await client.query(
    `SELECT 1 FROM accounts WHERE company_id = $1 AND account_code = $2 LIMIT 1`,
    [companyId, String(code)]
  );
  return r.rows.length > 0;
}

async function generateRootCode(client, companyId, type) {
  const base = TYPE_ROOT_BASE[type];
  const roots = await client.query(
    `SELECT account_code
     FROM accounts
     WHERE company_id = $1 AND level = 1 AND type = $2::account_type`,
    [companyId, type]
  );
  const maxExisting = roots.rows
    .map((r) => toIntCode(r.account_code))
    .filter((n) => n != null)
    .reduce((mx, n) => (n > mx ? n : mx), 0);

  let next = maxExisting >= base ? maxExisting + 1000 : base;
  while (await codeExists(client, companyId, next)) next += 1000;
  return { account_code: String(next), level: 1 };
}

async function generateChildCode(client, companyId, parent) {
  const nextLevel = Number(parent.level) + 1;
  if (nextLevel > 5) {
    throw new Error('Maximum account depth is 5 levels');
  }

  const parentCode = toIntCode(parent.account_code);
  if (parentCode == null) {
    throw new Error('Parent account code is invalid');
  }

  let start;
  let step;
  if (nextLevel === 2) {
    start = parentCode + 100;
    step = 100;
  } else if (nextLevel === 3) {
    start = parentCode + 10;
    step = 10;
  } else if (nextLevel === 4) {
    start = parentCode + 1;
    step = 1;
  } else {
    // level 5
    start = parentCode * 10 + 1;
    step = 1;
  }

  const cur = await client.query(
    `SELECT account_code
     FROM accounts
     WHERE company_id = $1 AND parent_id = $2
     ORDER BY created_at DESC`,
    [companyId, parent.id]
  );
  const maxExisting = cur.rows
    .map((r) => toIntCode(r.account_code))
    .filter((n) => n != null)
    .reduce((mx, n) => (n > mx ? n : mx), 0);

  let next = maxExisting > 0 ? maxExisting + step : start;
  while (await codeExists(client, companyId, next)) next += step;
  return { account_code: String(next), level: nextLevel };
}

export async function createAccountAuto(client, { companyId, name, type, parentId = null }) {
  let parent = null;
  if (parentId) {
    const p = await client.query(
      `SELECT id, type::text, level, account_code
       FROM accounts
       WHERE id = $1 AND company_id = $2`,
      [parentId, companyId]
    );
    if (!p.rows.length) throw new Error('Invalid parent_id');
    parent = p.rows[0];
  }

  const generated = parent
    ? await generateChildCode(client, companyId, parent)
    : await generateRootCode(client, companyId, type);

  const ins = await client.query(
    `INSERT INTO accounts (company_id, code, account_code, level, name, type, parent_id)
     VALUES ($1, $2, $2, $3, $4, $5::account_type, $6)
     RETURNING id, company_id, account_code, level, name, type::text, parent_id, is_active, created_at`,
    [companyId, generated.account_code, generated.level, String(name).trim(), type, parentId || null]
  );
  return ins.rows[0];
}

