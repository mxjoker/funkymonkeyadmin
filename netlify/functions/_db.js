// Shared Postgres pool. Every function must use getPool() instead of
// creating its own Pool — Netlify keeps one warm instance per function,
// and 20 independent pools exhausted the connection limit on small plans.
const { Pool } = require('pg');

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
async function withClient(fn) {
  const client = await getPool().connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

module.exports = { getPool, withClient };
