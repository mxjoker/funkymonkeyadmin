const { test } = require('node:test');
const assert = require('node:assert');

// Phase 2, item 6: signing a camp's contract must set contract_signed on
// every day sharing its camp_id — an admin toggling one day's "Mark Contract
// Signed" button (admin.html:3055) should not leave four siblings unsigned.
// The safety property: a booking with camp_id NULL must cascade to nobody
// and behave exactly as today.
//
// Exercised at the HTTP handler with _db/_auth stubbed, same technique
// test/bookings-camp-id.test.js uses for bookings.js.

function loadBookingHandler(fakeClient) {
  const mods = ['../netlify/functions/booking.js', '../netlify/functions/_db.js', '../netlify/functions/_auth.js'];
  for (const m of mods) delete require.cache[require.resolve(m)];
  const dbMod = require('../netlify/functions/_db.js');
  dbMod.withClient = async (fn) => fn(fakeClient);
  const authMod = require('../netlify/functions/_auth.js');
  authMod.requireAuth = async () => ({ role: 'admin' });
  authMod.preflight = () => null;
  return require('../netlify/functions/booking.js');
}

function fakeClient(bookingsSeed) {
  const bookings = bookingsSeed.map(b => ({ ...b }));
  const calls = [];
  return {
    calls, bookings,
    async query(sql, params = []) {
      calls.push({ sql: sql.trim(), params });
      if (/CREATE TABLE|ALTER TABLE|CREATE INDEX/i.test(sql)) return { rows: [] };
      if (/^\s*SELECT \* FROM bookings WHERE id=\$1/i.test(sql)) {
        const row = bookings.find(b => b.id === params[0]);
        return { rows: row ? [row] : [] };
      }
      if (/^\s*UPDATE bookings SET .* WHERE id=\$\d+ RETURNING \*/is.test(sql)) {
        const id = params[params.length - 1];
        const row = bookings.find(b => b.id === id);
        if (!row) return { rows: [] };
        const setCols = [...sql.matchAll(/(\w+)\s*=\s*\$\d+/g)].map(m => m[1]);
        setCols.forEach((col, i) => { row[col] = params[i]; });
        return { rows: [{ ...row }] };
      }
      if (/^\s*UPDATE bookings SET contract_signed=\$1, updated_at=NOW\(\) WHERE camp_id=\$2 AND id<>\$3/i.test(sql)) {
        const [signed, campId, exceptId] = params;
        bookings.filter(b => b.camp_id === campId && b.id !== exceptId)
          .forEach(b => { b.contract_signed = signed; });
        return { rows: [] };
      }
      if (/^\s*INSERT INTO booking_changes/i.test(sql)) return { rows: [] };
      throw new Error('unexpected query: ' + sql);
    },
  };
}

test('signing one camp day\'s contract cascades to every sibling day', async () => {
  const client = fakeClient([
    { id: 501, camp_id: 9, contract_signed: false, client_email: 'a@example.com' },
    { id: 502, camp_id: 9, contract_signed: false, client_email: 'a@example.com' },
    { id: 503, camp_id: 9, contract_signed: false, client_email: 'a@example.com' },
  ]);
  const { handler } = loadBookingHandler(client);

  const res = await handler({
    httpMethod: 'PATCH', path: '/api/booking/501',
    body: JSON.stringify({ contract_signed: true }),
  });

  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.strictEqual(body.contract_signed, true);
  assert.strictEqual(client.bookings.find(b => b.id === 502).contract_signed, true);
  assert.strictEqual(client.bookings.find(b => b.id === 503).contract_signed, true);
});

test('unsigning cascades the same way', async () => {
  const client = fakeClient([
    { id: 501, camp_id: 9, contract_signed: true, client_email: 'a@example.com' },
    { id: 502, camp_id: 9, contract_signed: true, client_email: 'a@example.com' },
  ]);
  const { handler } = loadBookingHandler(client);

  await handler({
    httpMethod: 'PATCH', path: '/api/booking/501',
    body: JSON.stringify({ contract_signed: false }),
  });

  assert.strictEqual(client.bookings.find(b => b.id === 502).contract_signed, false);
});

// The safety property: a booking with camp_id NULL must behave exactly as
// today — no cascade query issued at all, and no other booking touched.
test('a non-camp booking\'s contract toggle touches only itself — no cascade query', async () => {
  const client = fakeClient([
    { id: 601, camp_id: null, contract_signed: false, client_email: 'solo@example.com' },
    { id: 602, camp_id: null, contract_signed: false, client_email: 'other@example.com' },
  ]);
  const { handler } = loadBookingHandler(client);

  const res = await handler({
    httpMethod: 'PATCH', path: '/api/booking/601',
    body: JSON.stringify({ contract_signed: true }),
  });

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(client.bookings.find(b => b.id === 601).contract_signed, true);
  assert.strictEqual(client.bookings.find(b => b.id === 602).contract_signed, false);
  assert.ok(!client.calls.some(c => /WHERE camp_id=\$2 AND id<>\$3/i.test(c.sql)),
    'no cascade query should be issued for a booking outside any camp');
});
