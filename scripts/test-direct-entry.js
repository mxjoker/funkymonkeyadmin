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
const booking = require('../netlify/functions/booking');
const { getPool } = require('../netlify/functions/_db');

const post = (body, token) => bookings.handler({
  httpMethod: 'POST',
  headers: token ? { authorization: 'Bearer ' + token } : {},
  body: JSON.stringify(body),
  queryStringParameters: {},
  path: '/api/bookings',
});

const patch = (id, body) => booking.handler({
  httpMethod: 'PATCH',
  headers: { authorization: 'Bearer ' + TOKEN },
  body: JSON.stringify(body),
  queryStringParameters: { id: String(id) },
  path: '/api/booking/' + id,
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

    // 4. Editing a previously un-editable field works and is logged.
    const target = row; // the draft created in check 1
    const patched = await patch(target.id, {
      event_date: '2026-12-25',
      client_phone: '405-555-0100',
      surface_type: 'grass',
    });
    assert.strictEqual(patched.statusCode, 200, `PATCH returned ${patched.statusCode}: ${patched.body}`);
    const after = JSON.parse(patched.body);
    assert.strictEqual(after.client_phone, '405-555-0100');
    assert.strictEqual(after.surface_type, 'grass');
    assert.ok(after.event_date, 'event_date should now be set');

    const pool0 = getPool();
    const c0 = await pool0.connect();
    let logged;
    try {
      const { rows } = await c0.query(
        'SELECT action FROM booking_changes WHERE booking_id=$1', [target.id]
      );
      logged = rows.map(r => r.action);
    } finally { c0.release(); }
    assert.ok(logged.some(a => a.includes('event_date')),
      `expected an event_date change log, got: ${JSON.stringify(logged)}`);
    console.log('  ok  event_date is editable and logged');

    // 5. client.js round-trips against the live clients table.
    const clientFn = require('../netlify/functions/client');
    const TEST_EMAIL = 'direct-entry-selfcheck@example.invalid';
    const callClient = (method, body) => clientFn.handler({
      httpMethod: method,
      headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' },
      queryStringParameters: { email: TEST_EMAIL },
      body: body ? JSON.stringify(body) : null,
      path: '/api/client',
    });

    const gotClient = await callClient('GET');
    assert.strictEqual(gotClient.statusCode, 200, `client GET returned ${gotClient.statusCode}: ${gotClient.body}`);
    const cRec = JSON.parse(gotClient.body);
    assert.ok(Array.isArray(cRec.bookings), 'client GET must return a bookings array');
    assert.ok(Array.isArray(cRec.interactions), 'client GET must return an interactions array');

    // client.js takes the email from the JSON body on PATCH/POST/DELETE — the
    // query param is read for GET only (client.js:84-100). `email` is not in
    // the PATCH allowlist, so it routes the request without being written.
    // clients.tags is JSONB and client.js binds it straight through with no
    // encoding, so a bare string like 'vip' makes Postgres throw
    // "invalid input syntax for type json". Send a JSON array.
    const patchedClient = await callClient('PATCH', {
      email: TEST_EMAIL, notes: 'selfcheck note', tags: JSON.stringify(['vip']),
    });
    assert.strictEqual(patchedClient.statusCode, 200, `client PATCH returned ${patchedClient.statusCode}: ${patchedClient.body}`);
    assert.strictEqual(JSON.parse(patchedClient.body).notes, 'selfcheck note');
    assert.deepStrictEqual(JSON.parse(patchedClient.body).tags, ['vip'],
      'tags must round-trip as a JSON array');
    console.log('  ok  client.js GET and PATCH round-trip');

    console.log('\nAll direct-entry checks passed.');
  } finally {
    const p2 = getPool();
    const c2 = await p2.connect();
    try {
      await c2.query('DELETE FROM clients WHERE email=$1', ['direct-entry-selfcheck@example.invalid']);
    } finally { c2.release(); }
    if (created.length) {
      const pool = getPool();
      const c = await pool.connect();
      try {
        for (const ref of created) {
          await c.query(
            'DELETE FROM booking_changes WHERE booking_id IN (SELECT id FROM bookings WHERE reference=$1)',
            [ref]
          );
          await c.query('DELETE FROM bookings WHERE reference=$1', [ref]);
          console.log(`  cleaned up ${ref}`);
        }
      } finally { c.release(); }
    }
    process.exitCode = 0;
  }
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
