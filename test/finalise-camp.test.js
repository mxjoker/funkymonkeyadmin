const { test } = require('node:test');
const assert = require('node:assert');
const { CLIENT_EDITABLE } = require('../netlify/functions/_finalise.js');

// Hand-rolled fake client that actually honours BEGIN/COMMIT/ROLLBACK by
// snapshotting camps+bookings on BEGIN and restoring on ROLLBACK — the point
// is to prove the atomicity claim (all days or none), not merely record SQL.
function fakeCampClient(campsSeed, bookingsSeed, opts = {}) {
  let camps = campsSeed.map(c => ({ ...c }));
  let bookings = bookingsSeed.map(b => ({ ...b }));
  let snapshot = null;
  const calls = [];
  return {
    calls,
    get camps() { return camps; },
    get bookings() { return bookings; },
    async query(sql, params = []) {
      calls.push(sql.trim().split('\n')[0].trim());

      if (/^BEGIN/i.test(sql)) {
        snapshot = { camps: camps.map(c => ({ ...c })), bookings: bookings.map(b => ({ ...b })) };
        return { rows: [] };
      }
      if (/^COMMIT/i.test(sql)) { snapshot = null; return { rows: [] }; }
      if (/^ROLLBACK/i.test(sql)) {
        if (snapshot) { camps = snapshot.camps; bookings = snapshot.bookings; snapshot = null; }
        return { rows: [] };
      }
      if (/^\s*SELECT \* FROM camps WHERE reference = \$1/i.test(sql)) {
        const row = camps.find(c => c.reference === params[0]);
        return { rows: row ? [row] : [] };
      }
      if (/^\s*SELECT id, event_date, contract_signed FROM bookings WHERE camp_id = \$1/i.test(sql)) {
        return { rows: bookings.filter(b => b.camp_id === params[0]) };
      }
      if (/^\s*UPDATE camps SET/i.test(sql)) {
        if (opts.failCampsUpdate) throw new Error('simulated camps update failure');
        const id = params[params.length - 1];
        const row = camps.find(c => c.id === id);
        if (!row) return { rows: [] };
        const setCols = [...sql.matchAll(/(\w+)\s*=\s*\$\d+/g)].map(m => m[1]);
        setCols.forEach((col, i) => { row[col] = params[i]; });
        return { rows: [{ ...row }] };
      }
      if (/^\s*UPDATE bookings SET/i.test(sql)) {
        if (opts.failBookingsUpdate) throw new Error('simulated bookings update failure');
        const id = params[params.length - 1];
        const setCols = [...sql.matchAll(/(\w+)\s*=\s*\$\d+/g)].map(m => m[1]);
        bookings.filter(b => b.camp_id === id).forEach(b => {
          setCols.forEach((col, i) => { b[col] = params[i]; });
        });
        return { rows: [] };
      }
      throw new Error('unexpected query: ' + sql);
    },
  };
}

// Same module-cache-clearing technique test/bookings-camp-id.test.js already
// uses: swap _db's withClient for one that hands back our fake, then require
// finalise-camp.js fresh so it picks up the swap.
function loadFinaliseCampHandler(client) {
  const mods = [
    '../netlify/functions/finalise-camp.js',
    '../netlify/functions/finalise.js',
    '../netlify/functions/_db.js',
    '../netlify/functions/_auth.js',
    '../netlify/functions/automations.js',
    '../netlify/functions/_email.js',
  ];
  for (const m of mods) delete require.cache[require.resolve(m)];
  const dbMod = require('../netlify/functions/_db.js');
  dbMod.withClient = async (fn) => fn(client);
  const auth = require('../netlify/functions/_auth.js');
  auth.preflight = () => null;
  // Phase 4 sends mail after the commit. finalise-camp destructures these at
  // load time, so they must be stubbed BEFORE it is required. Captured on the
  // client so a test can assert what went out — see test/camp-emails.test.js
  // for the sends themselves; here they only have to not reach a network.
  const automations = require('../netlify/functions/automations.js');
  automations.sendTemplate = async (_c, booking, key, _link, opts = {}) => {
    (client.sent = client.sent || []).push({ key, to: opts.to || booking.client_email, extra: opts.extra });
    return { sent: true };
  };
  const email = require('../netlify/functions/_email.js');
  email.logChange = async () => {};
  return require('../netlify/functions/finalise-camp.js');
}

const CAMP = {
  id: 5, reference: 'CAMP-ABCDEFGH', label: 'MAC Summer Camp',
  client_name: 'Jane Doe', client_phone: '4055550000', client_email: 'jane@example.com',
  event_location: '', event_zip: '', venue: '', surface_type: '', event_time: '', notes: '',
};
const DAYS = [
  { id: 10, camp_id: 5, event_date: '2026-07-14', contract_signed: false, client_email: 'jane@example.com' },
  { id: 11, camp_id: 5, event_date: '2026-07-15', contract_signed: false, client_email: 'jane@example.com' },
];

test('CAMP_EDITABLE is CLIENT_EDITABLE minus the per-kid/birthday fields', () => {
  const { CAMP_EDITABLE } = require('../netlify/functions/finalise-camp.js');
  assert.deepStrictEqual([...CAMP_EDITABLE].sort(), [...CLIENT_EDITABLE].filter(
    f => !['guest_count', 'child_name', 'guests_of_honour'].includes(f)
  ).sort());
  for (const f of ['guest_count', 'child_name', 'guests_of_honour']) {
    assert.ok(!CAMP_EDITABLE.includes(f), `${f} must not be camp-editable`);
  }
});

test('GET returns the shared fields plus one contract state for the whole camp', async () => {
  const client = fakeCampClient([CAMP], DAYS);
  const { handler } = loadFinaliseCampHandler(client);
  const res = await handler({
    httpMethod: 'GET',
    queryStringParameters: { reference: 'CAMP-ABCDEFGH', email: 'jane@example.com' },
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.strictEqual(body.camp.reference, 'CAMP-ABCDEFGH');
  assert.strictEqual(body.camp.day_count, 2);
  assert.strictEqual(body.camp.contract_signed, false);
});

test('a wrong email 404s without revealing the camp exists', async () => {
  const client = fakeCampClient([CAMP], DAYS);
  const { handler } = loadFinaliseCampHandler(client);
  const res = await handler({
    httpMethod: 'GET',
    queryStringParameters: { reference: 'CAMP-ABCDEFGH', email: 'someone-else@example.com' },
  });
  assert.strictEqual(res.statusCode, 404);
});

test('saving shared fields writes the camp row AND every day in one transaction', async () => {
  const client = fakeCampClient([CAMP], DAYS);
  const { handler } = loadFinaliseCampHandler(client);
  const res = await handler({
    httpMethod: 'PATCH',
    body: JSON.stringify({
      reference: 'CAMP-ABCDEFGH', email: 'jane@example.com',
      updates: { venue: 'The MAC', event_time: '09:00', notes: 'Mornings only' },
    }),
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.strictEqual(body.success, true);
  assert.strictEqual(body.camp.venue, 'The MAC');
  assert.strictEqual(client.camps[0].venue, 'The MAC');
  for (const day of client.bookings) {
    assert.strictEqual(day.venue, 'The MAC');
    assert.strictEqual(day.event_time, '09:00');
    assert.strictEqual(day.notes, 'Mornings only');
  }
  // Real transaction bracketing, not just a bare pair of UPDATEs.
  assert.ok(client.calls.includes('BEGIN'));
  assert.ok(client.calls.includes('COMMIT'));
});

// The three fields Phase 3 owns (per-kid headcount, birthday-party fields)
// are excluded even though CLIENT_EDITABLE — reused, not re-implemented —
// allows them for an individual booking's own finalise form.
test('guest_count/child_name/guests_of_honour are rejected, not silently dropped, and touch nothing', async () => {
  const client = fakeCampClient([CAMP], DAYS);
  const { handler } = loadFinaliseCampHandler(client);
  const res = await handler({
    httpMethod: 'PATCH',
    body: JSON.stringify({
      reference: 'CAMP-ABCDEFGH', email: 'jane@example.com',
      updates: { venue: 'The MAC', guest_count: 40, child_name: 'Ignored', guests_of_honour: 'Ignored' },
    }),
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(body.rejected.includes('guest_count'));
  assert.ok(body.rejected.includes('child_name'));
  assert.ok(body.rejected.includes('guests_of_honour'));
  assert.strictEqual(client.bookings[0].guest_count, undefined);
});

test('a body with only excluded fields saves nothing and reports 400', async () => {
  const client = fakeCampClient([CAMP], DAYS);
  const { handler } = loadFinaliseCampHandler(client);
  const res = await handler({
    httpMethod: 'PATCH',
    body: JSON.stringify({
      reference: 'CAMP-ABCDEFGH', email: 'jane@example.com',
      updates: { guest_count: 40 },
    }),
  });
  assert.strictEqual(res.statusCode, 400);
});

// ── The self-review question: can the client change their email and still
// open their camp link afterwards? ─────────────────────────────────────────
test('a clean email change updates the camp AND every day, and reports emailChanged', async () => {
  const client = fakeCampClient([CAMP], DAYS);
  const { handler } = loadFinaliseCampHandler(client);
  const res = await handler({
    httpMethod: 'PATCH',
    body: JSON.stringify({
      reference: 'CAMP-ABCDEFGH', email: 'jane@example.com',
      updates: { client_email: 'newemail@example.com' },
    }),
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.strictEqual(body.emailChanged, true);
  assert.strictEqual(client.camps[0].client_email, 'newemail@example.com');
  for (const day of client.bookings) assert.strictEqual(day.client_email, 'newemail@example.com');

  // The client's link must keep working under the NEW email.
  const client2 = client; // same fake, state already mutated
  const { handler: handler2 } = loadFinaliseCampHandler(client2);
  const followUp = await handler2({
    httpMethod: 'GET',
    queryStringParameters: { reference: 'CAMP-ABCDEFGH', email: 'newemail@example.com' },
  });
  assert.strictEqual(followUp.statusCode, 200);
});

// The critical safety property for item 5: if the per-day write fails after
// the camp row's email has already changed, BOTH must roll back — otherwise
// the camp authenticates under a new email whose days still expect the old
// one, which is a client locked out of the rest of their week.
test('a failed day-write rolls back the camp\'s email change too — no lockout', async () => {
  const client = fakeCampClient([CAMP], DAYS, { failBookingsUpdate: true });
  const { handler } = loadFinaliseCampHandler(client);
  const res = await handler({
    httpMethod: 'PATCH',
    body: JSON.stringify({
      reference: 'CAMP-ABCDEFGH', email: 'jane@example.com',
      updates: { client_email: 'newemail@example.com' },
    }),
  });
  assert.strictEqual(res.statusCode, 500);

  // Rolled back: the camp row's email must NOT have changed.
  assert.strictEqual(client.camps[0].client_email, 'jane@example.com');
  for (const day of client.bookings) assert.strictEqual(day.client_email, 'jane@example.com');

  // The OLD link must still work — this is what "no lockout" means.
  const { handler: handler2 } = loadFinaliseCampHandler(client);
  const oldEmailStillWorks = await handler2({
    httpMethod: 'GET',
    queryStringParameters: { reference: 'CAMP-ABCDEFGH', email: 'jane@example.com' },
  });
  assert.strictEqual(oldEmailStillWorks.statusCode, 200);

  // The NEW email must NOT authenticate — it was never actually persisted.
  const newEmailDoesNotWork = await handler2({
    httpMethod: 'GET',
    queryStringParameters: { reference: 'CAMP-ABCDEFGH', email: 'newemail@example.com' },
  });
  assert.strictEqual(newEmailDoesNotWork.statusCode, 404);

  assert.ok(client.calls.includes('ROLLBACK'));
  assert.ok(!client.calls.includes('COMMIT'));
});
