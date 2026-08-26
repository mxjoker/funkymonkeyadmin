const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

// A consenting client's booking must come back 201. It used to throw a
// ReferenceError between the INSERT and the response: the row landed, the
// client saw "Something went wrong", and every retry wrote another booking.
// Stubbed at the module boundary so this exercises the real handler.
const F = (n) => require.resolve(path.join(__dirname, '..', 'netlify/functions', n));
const stub = (n, exp) => { require.cache[F(n)] = { id: F(n), filename: F(n), loaded: true, exports: exp }; };

const sent = [];
stub('_db', {
  getPool: () => ({ connect: async () => ({ release() {} }) }),
  withClient: async (fn) => fn({
    query: async (sql) => /INSERT INTO bookings/i.test(sql)
      ? { rows: [{ id: 1, reference: 'FM-TEST0001', client_phone: '+14055551212', total_price: 400, balance_due: 300 }] }
      : { rows: [] },
  }),
});
stub('_sms', { sendSms: async (...a) => { sent.push(a); return { sent: true }; } });
stub('automations', { sendTemplate: async () => ({ sent: true }) });
stub('staff-assignments', { notifyMatchingStaff: async () => ({ notified: 0 }) });

const { handler } = require('../netlify/functions/bookings');

const post = (extra) => handler({
  httpMethod: 'POST',
  body: JSON.stringify({
    client_name: 'Alisa Green', client_email: 'a@example.com', client_phone: '405-555-1212',
    event_date: '2026-11-08', service_id: 'deluxe_magic', service_name: 'Deluxe Birthday Magic Show',
    service_price: 385, mileage_cost: 15, total_price: 400, brand: 'fme', ...extra,
  }),
});

test('a booking with SMS consent returns 201, not an error', async () => {
  const res = await post({ sms_consent: true });
  assert.strictEqual(res.statusCode, 201, `consenting booking must succeed, got ${res.statusCode}: ${res.body}`);
});

test('the opt-in confirmation is actually handed to sendSms', async () => {
  sent.length = 0;
  await post({ sms_consent: true });
  assert.strictEqual(sent.length, 1, 'consent must trigger exactly one opt-in SMS');
  assert.ok(sent[0][0] && typeof sent[0][0].query === 'function',
    'sendSms must receive the live db client as its first argument');
});

test('no consent means no opt-in SMS and still a 201', async () => {
  sent.length = 0;
  const res = await post({ sms_consent: false });
  assert.strictEqual(res.statusCode, 201);
  assert.strictEqual(sent.length, 0);
});
