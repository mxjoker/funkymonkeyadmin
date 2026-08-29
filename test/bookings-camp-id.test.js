const { test } = require('node:test');
const assert = require('node:assert');

// Exercised at the HTTP handler with _db/_auth stubbed out, same technique
// as sms-automations.test.js's save_rule test — neither talks to a real
// database or an admin session, and the assertion is on the SQL/params the
// handler hands to `client.query`, not a live INSERT.
//
// Proves the one thing bookings.js had to gain for Phase 1: camp_id posted
// by admin.html's "+ Day" flow reaches the actual INSERT, and — the safety
// property the whole feature rests on — a booking with no camp_id behaves
// identically to today (NULL, same as every booking already in production).
function loadBookingsHandler(fakeClient) {
  const mods = [
    '../netlify/functions/bookings.js',
    '../netlify/functions/_db.js',
    '../netlify/functions/_auth.js',
    '../netlify/functions/camps.js',
  ];
  for (const m of mods) delete require.cache[require.resolve(m)];
  const dbMod = require('../netlify/functions/_db.js');
  dbMod.withClient = async (fn) => fn(fakeClient);
  const authMod = require('../netlify/functions/_auth.js');
  authMod.requireAuth = async () => ({ role: 'admin' });
  authMod.preflight = () => null;
  return require('../netlify/functions/bookings.js');
}

function fakeClient() {
  const queries = [];
  return {
    queries,
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (/CREATE TABLE|ALTER TABLE/i.test(sql)) return { rows: [] };
      if (/^\s*SELECT 1 FROM bookings/i.test(sql)) return { rows: [] }; // reference is free
      if (/^\s*INSERT INTO bookings/i.test(sql)) {
        return { rows: [{ id: 501, reference: 'FM-TESTCAMP', client_phone: '', deposit_amount: 0 }] };
      }
      throw new Error('unexpected query: ' + sql);
    },
  };
}

const draftBody = (extra) => JSON.stringify({
  status: 'draft',
  client_name: 'Jane Doe',
  event_date: '2026-07-14',
  ...extra,
});

test('a camp day POST carries camp_id all the way into the INSERT', async () => {
  const client = fakeClient();
  const { handler } = loadBookingsHandler(client);

  const res = await handler({ httpMethod: 'POST', body: draftBody({ camp_id: 7, service_id: 'svc-foam' }) });

  assert.strictEqual(res.statusCode, 201);
  const insert = client.queries.find(q => /INSERT INTO bookings/i.test(q.sql));
  assert.ok(insert, 'expected an INSERT INTO bookings');
  assert.match(insert.sql, /camp_id/);
  assert.strictEqual(insert.params[insert.params.length - 1], 7);
});

test('an ordinary booking with no camp_id stores NULL — identical to today', async () => {
  const client = fakeClient();
  const { handler } = loadBookingsHandler(client);

  const res = await handler({ httpMethod: 'POST', body: draftBody() });

  assert.strictEqual(res.statusCode, 201);
  const insert = client.queries.find(q => /INSERT INTO bookings/i.test(q.sql));
  assert.strictEqual(insert.params[insert.params.length - 1], null);
});

test('a non-numeric camp_id is dropped to NULL rather than stored or crashing', async () => {
  const client = fakeClient();
  const { handler } = loadBookingsHandler(client);

  const res = await handler({ httpMethod: 'POST', body: draftBody({ camp_id: 'not-a-number' }) });

  assert.strictEqual(res.statusCode, 201);
  const insert = client.queries.find(q => /INSERT INTO bookings/i.test(q.sql));
  assert.strictEqual(insert.params[insert.params.length - 1], null);
});

test('POST /api/bookings ensures the camp tables before inserting', async () => {
  const client = fakeClient();
  const { handler } = loadBookingsHandler(client);

  await handler({ httpMethod: 'POST', body: draftBody({ camp_id: 3 }) });

  assert.ok(client.queries.some(q => /CREATE TABLE IF NOT EXISTS camps/i.test(q.sql)));
  assert.ok(client.queries.some(q => /ALTER TABLE bookings ADD COLUMN IF NOT EXISTS camp_id/i.test(q.sql)));
});
