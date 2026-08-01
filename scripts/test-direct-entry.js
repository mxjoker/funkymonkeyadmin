#!/usr/bin/env node
/**
 * Self-checks for admin direct entry (spec 2026-08-01).
 *
 * Runs against the LIVE Neon database — there is no test database. Every
 * booking it creates is deleted in the finally block, by exact reference.
 * Never add a query here that deletes by anything but a reference this
 * script generated.
 *
 * Run: node scripts/test-direct-entry.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env');
if (!process.env.DATABASE_URL && fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

// requireAuth accepts AGENT_API_TOKEN as an admin bearer with no session row,
// provided it is at least 32 chars (_auth.js:153-156). Set before requiring
// the handlers so the module reads it.
const TOKEN = 'test-direct-entry-token-0123456789abcdef';
process.env.AGENT_API_TOKEN = TOKEN;

const bookings = require('../netlify/functions/bookings');
const { getPool } = require('../netlify/functions/_db');

const post = (body, token) => bookings.handler({
  httpMethod: 'POST',
  headers: token ? { authorization: 'Bearer ' + token } : {},
  body: JSON.stringify(body),
  queryStringParameters: {},
  path: '/api/bookings',
});

async function main() {
  const created = [];
  try {
    // 1. An admin may save a draft carrying only a name.
    const res = await post({ status: 'draft', client_name: 'Phone Caller' }, TOKEN);
    assert.strictEqual(res.statusCode, 201, `draft POST returned ${res.statusCode}: ${res.body}`);
    const body = JSON.parse(res.body);
    if (body.reference) created.push(body.reference);
    const row = body.booking;
    assert.ok(row, 'POST must return the created row under `booking`');
    assert.strictEqual(row.status, 'draft', `expected status draft, got ${row.status}`);
    assert.strictEqual(row.client_name, 'Phone Caller');
    assert.strictEqual(row.event_date, null, 'a draft with no date must store NULL');
    console.log('  ok  admin draft with only a name is accepted');

    // 2. The identical POST without a token is rejected.
    const noAuth = await post({ status: 'draft', client_name: 'Phone Caller' }, null);
    if (noAuth.statusCode === 201) {
      const noAuthBody = JSON.parse(noAuth.body);
      if (noAuthBody.reference) created.push(noAuthBody.reference);
    }
    assert.strictEqual(noAuth.statusCode, 401,
      `unauthenticated draft returned ${noAuth.statusCode}, expected 401`);
    console.log('  ok  unauthenticated draft is rejected');

    // 3. The public path still enforces its required fields.
    const publicPost = await post({ client_name: 'Web Visitor' }, null);
    if (publicPost.statusCode === 201) {
      const publicPostBody = JSON.parse(publicPost.body);
      if (publicPostBody.reference) created.push(publicPostBody.reference);
    }
    assert.strictEqual(publicPost.statusCode, 400,
      `public POST without email returned ${publicPost.statusCode}, expected 400`);
    console.log('  ok  public POST still requires email/date/service');

    console.log('\nAll direct-entry checks passed.');
  } finally {
    if (created.length) {
      const pool = getPool();
      const c = await pool.connect();
      try {
        for (const ref of created) {
          await c.query('DELETE FROM bookings WHERE reference=$1', [ref]);
          console.log(`  cleaned up ${ref}`);
        }
      } finally { c.release(); }
    }
    process.exitCode = 0;
  }
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
