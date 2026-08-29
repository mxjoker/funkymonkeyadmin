// netlify/functions/revenue-targets.js
// Monthly gross-revenue targets, so the dashboard can say whether a month is
// good. Measures the same thing the Revenue This Month card sums (gross
// total_price, event-dated, confirmed) — that was an explicit owner call, so
// the two numbers are always comparable.

const { withClient } = require('./_db');
const { CORS, preflight, requireAuth, unauthorized } = require('./_auth');

const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

// One row per year+month so next year's targets never overwrite this year's.
async function ensureTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS revenue_targets (
      year   INTEGER NOT NULL,
      month  INTEGER NOT NULL,
      amount NUMERIC(10,2) NOT NULL DEFAULT 0,
      PRIMARY KEY (year, month)
    )
  `);
}

// Always returns all twelve months for the year, missing ones as amount 0 —
// callers (the settings UI, the dashboard) never have to special-case "no
// row yet" separately from "target is 0".
async function getTargets(client, year) {
  const result = await client.query(
    `SELECT month, amount FROM revenue_targets WHERE year = $1`,
    [year]
  );
  const byMonth = {};
  result.rows.forEach(r => { byMonth[r.month] = Number(r.amount); });
  const targets = [];
  for (let m = 1; m <= 12; m++) targets.push({ year, month: m, amount: byMonth[m] || 0 });
  return targets;
}

// Upserts whichever months are supplied; returns the full twelve rows after.
async function upsertTargets(client, year, targets) {
  for (const t of targets || []) {
    const month = Number(t.month);
    if (!(month >= 1 && month <= 12)) continue;
    const amount = Number(t.amount) || 0;
    await client.query(
      `INSERT INTO revenue_targets (year, month, amount) VALUES ($1, $2, $3)
       ON CONFLICT (year, month) DO UPDATE SET amount = EXCLUDED.amount`,
      [year, month, amount]
    );
  }
  return getTargets(client, year);
}

exports.handler = async (event) => {
  const pre = preflight(event);
  if (pre) return pre;

  const auth = await requireAuth(event, ['admin']);
  if (!auth) return unauthorized();

  return withClient(async (client) => {
    try {
      await ensureTable(client);

      if (event.httpMethod === 'GET') {
        const year = parseInt(event.queryStringParameters?.year, 10) || new Date().getFullYear();
        return json(200, { year, targets: await getTargets(client, year) });
      }

      if (event.httpMethod === 'POST') {
        let body;
        try {
          body = JSON.parse(event.body || '{}');
        } catch {
          return json(400, { error: 'Invalid JSON' });
        }
        const year = parseInt(body.year, 10);
        if (!year) return json(400, { error: 'year required' });

        return json(200, { year, targets: await upsertTargets(client, year, body.targets) });
      }

      return json(405, { error: 'Method not allowed' });
    } catch (err) {
      console.error('Revenue targets error:', err.message);
      return json(500, { error: 'Internal server error' });
    }
  });
};

exports.ensureTable = ensureTable;
exports.getTargets = getTargets;
exports.upsertTargets = upsertTargets;
