const { test } = require('node:test');
const assert = require('node:assert');

// Phase 2, item 7 + the safety property: a camp day's own finalise link must
// hand off to the camp's, while a booking with camp_id NULL must go through
// the existing per-booking finalise/contract flow completely unchanged.
// Exercised at the HTTP handler with _db/_auth stubbed, same technique
// test/bookings-camp-id.test.js already uses for bookings.js.

function fakeClient(bookingsSeed, campsSeed = []) {
  const bookings = bookingsSeed.map(b => ({ ...b }));
  const camps = campsSeed.map(c => ({ ...c }));
  const calls = [];
  return {
    calls, bookings, camps,
    async query(sql, params = []) {
      calls.push(sql.trim().split('\n')[0].trim());
      if (/CREATE TABLE|ALTER TABLE|CREATE INDEX/i.test(sql)) return { rows: [] };
      if (/^\s*SELECT \* FROM bookings WHERE reference = \$1/i.test(sql)) {
        const row = bookings.find(b => b.reference === params[0]);
        return { rows: row ? [row] : [] };
      }
      if (/^\s*SELECT reference, client_email FROM camps WHERE id = \$1/i.test(sql)) {
        const row = camps.find(c => c.id === params[0]);
        return { rows: row ? [row] : [] };
      }
      if (/^\s*SELECT id, booking_id, service_id, name/i.test(sql)) return { rows: [] }; // getItems
      if (/^\s*UPDATE bookings SET .* WHERE id=\$\d+ RETURNING \*/is.test(sql)) {
        const id = params[params.length - 1];
        const row = bookings.find(b => b.id === id);
        if (!row) return { rows: [] };
        const setCols = [...sql.matchAll(/(\w+)\s*=\s*\$\d+/g)].map(m => m[1]);
        setCols.forEach((col, i) => { row[col] = params[i]; });
        return { rows: [{ ...row }] };
      }
      if (/^\s*INSERT INTO booking_changes/i.test(sql)) return { rows: [] };
      throw new Error('unexpected query: ' + sql);
    },
  };
}

function loadFinaliseHandler(client) {
  const mods = ['../netlify/functions/finalise.js', '../netlify/functions/_db.js', '../netlify/functions/_auth.js'];
  for (const m of mods) delete require.cache[require.resolve(m)];
  const dbMod = require('../netlify/functions/_db.js');
  dbMod.withClient = async (fn) => fn(client);
  const auth = require('../netlify/functions/_auth.js');
  auth.preflight = () => null;
  // Per-save receipts and reissue notices go through sendTemplate — stubbed so
  // these tests exercise finalise.js's own logic without a real DB/email send.
  const automations = require('../netlify/functions/automations.js');
  automations.sendTemplate = async () => ({ sent: true });
  return require('../netlify/functions/finalise.js');
}

const CAMP_DAY = {
  id: 10, reference: 'FM-DAY0001', client_email: 'jane@example.com', camp_id: 5,
  status: 'quoted', total_price: 500, deposit_amount: 100, balance_due: 400,
  event_zip: '73034', event_location: '123 Main St',
};
const CAMP = { id: 5, reference: 'CAMP-ABCDEFGH', client_email: 'jane@example.com' };

const SOLO_BOOKING = {
  id: 20, reference: 'FM-SOLO0001', client_email: 'x@example.com', camp_id: null,
  status: 'quoted', total_price: 300, deposit_amount: 100, balance_due: 200,
  event_zip: '73034', event_location: '456 Elm St', client_phone: '4055551111',
  deposit_paid: false,
};

test('GET on a camp day redirects to the camp\'s finalise link, not its own', async () => {
  const client = fakeClient([CAMP_DAY], [CAMP]);
  const { handler } = loadFinaliseHandler(client);
  const res = await handler({
    httpMethod: 'GET',
    queryStringParameters: { reference: 'FM-DAY0001', email: 'jane@example.com' },
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.deepStrictEqual(body.redirect, { reference: 'CAMP-ABCDEFGH', email: 'jane@example.com' });
  assert.ok(!body.booking, 'a camp day must not also render its own finalise view');
});

test('PATCH on a camp day redirects instead of applying the edit', async () => {
  const client = fakeClient([CAMP_DAY], [CAMP]);
  const { handler } = loadFinaliseHandler(client);
  const res = await handler({
    httpMethod: 'PATCH',
    body: JSON.stringify({
      reference: 'FM-DAY0001', email: 'jane@example.com',
      updates: { venue: 'The MAC' },
    }),
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.deepStrictEqual(body.redirect, { reference: 'CAMP-ABCDEFGH', email: 'jane@example.com' });
  // The day itself must be untouched — no UPDATE bookings query issued.
  assert.ok(!client.calls.some(c => /^UPDATE bookings SET/i.test(c)),
    'a camp day\'s own finalise endpoint must not write to it directly');
});

// ── The safety property ─────────────────────────────────────────────────────
// A booking with camp_id NULL must use the existing per-booking finalise and
// contract flow, completely unchanged by anything added for camps.
test('GET on a non-camp booking is completely unchanged — no redirect, normal view', async () => {
  const client = fakeClient([SOLO_BOOKING]);
  const { handler } = loadFinaliseHandler(client);
  const res = await handler({
    httpMethod: 'GET',
    queryStringParameters: { reference: 'FM-SOLO0001', email: 'x@example.com' },
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(!body.redirect, 'a non-camp booking must never redirect');
  assert.strictEqual(body.booking.reference, 'FM-SOLO0001');
  assert.strictEqual(body.booking.total_price, 300);
});

test('PATCH on a non-camp booking saves normally — the existing flow, untouched', async () => {
  const client = fakeClient([SOLO_BOOKING]);
  const { handler } = loadFinaliseHandler(client);
  const res = await handler({
    httpMethod: 'PATCH',
    body: JSON.stringify({
      reference: 'FM-SOLO0001', email: 'x@example.com',
      updates: { client_phone: '4055559999' },
    }),
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(!body.redirect, 'a non-camp booking must never redirect');
  assert.strictEqual(body.success, true);
  assert.strictEqual(body.booking.client_phone, '4055559999');
  assert.ok(client.calls.some(c => /^UPDATE bookings SET/i.test(c)),
    'the ordinary per-booking UPDATE must still run');
});
