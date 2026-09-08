// Shared Postgres pool. Every function must use getPool() instead of
// creating its own Pool — Netlify keeps one warm instance per function,
// and 20 independent pools exhausted the connection limit on small plans.
const { Pool } = require('pg');

// Long enough for a Neon compute to finish waking, short enough that a truly
// dead database still fails inside a function's budget.
const RETRY_DELAY_MS = 1000;

let pool;

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 3,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });
    pool.on('error', (err) => console.error('pg pool idle error:', err.message));
  }
  return pool;
}

// Checks out a client, runs fn, and guarantees release even when
// pool.connect() itself throws (the old per-file pattern crashed with
// "cannot read release of undefined" when the DB was unreachable).
//
// The connect is retried once. Neon autosuspends the compute after a few
// minutes idle and DATABASE_URL points at the direct endpoint, so the first
// connection of the day pays a cold start; when that start overruns the 10s
// connectionTimeoutMillis, connect() throws and the caller does nothing at
// all. That is how the 2026-09-02 automations run sent no mail — the throw
// escapes ensureTables(), which sits above every per-job .catch() in
// automations-scheduled.js, so a whole run vanished with no email_log row.
//
// Only the already-failing path pays the extra wait: a warm connect returns
// on the first try and never reaches the retry.
async function withClient(fn) {
  let client;
  try {
    client = await getPool().connect();
  } catch (e) {
    console.error('pg connect failed, retrying once:', e.message);
    await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
    client = await getPool().connect();
  }
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

module.exports = { getPool, withClient };
