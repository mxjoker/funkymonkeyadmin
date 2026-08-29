const { test } = require('node:test');
const assert = require('node:assert');
const {
  ensureTables, listCamps, createCamp, updateCamp, deleteCamp,
} = require('../netlify/functions/camps');

// Hand-rolled fake client — no DB, no framework. Mirrors `camps` and enough
// of `bookings` (just id + camp_id + event_date) to exercise the actual SQL
// shapes: the GROUP BY/LEFT JOIN in listCamps, and the UPDATE/DELETE
// statements' WHERE clauses.
function fakeClient(bookingRows = []) {
  const camps = [];
  let nextId = 1;
  const bookings = bookingRows.map(b => ({ ...b }));
  return {
    calls: [],
    camps,
    async query(sql, params = []) {
      this.calls.push(sql);

      if (/CREATE TABLE IF NOT EXISTS camps/i.test(sql)) return { rows: [] };
      if (/ALTER TABLE bookings/i.test(sql)) return { rows: [] };

      if (/^\s*SELECT c\.\*/is.test(sql)) {
        // listCamps: one row per camp, day_count/start/end derived from
        // whatever bookings reference it — same shape the real LEFT JOIN
        // produces, including a camp with zero days.
        return {
          rows: camps.map(c => {
            const days = bookings.filter(b => b.camp_id === c.id);
            const dates = days.map(d => d.event_date).filter(Boolean).sort();
            return {
              ...c,
              day_count: days.length,
              start_date: dates[0] || null,
              end_date: dates[dates.length - 1] || null,
            };
          }),
        };
      }

      if (/^\s*INSERT INTO camps/i.test(sql)) {
        const [label, client_name, client_email, client_phone,
          organisation_name, event_location, event_zip, service_id, notes] = params;
        const row = {
          id: nextId++, label, client_name, client_email, client_phone,
          organisation_name, event_location, event_zip, service_id, notes,
          created_at: new Date().toISOString(),
        };
        camps.push(row);
        return { rows: [row] };
      }

      if (/^\s*UPDATE camps/i.test(sql)) {
        const id = params[params.length - 1];
        const row = camps.find(c => c.id === id);
        if (!row) return { rows: [] };
        // Field order in the SET clause mirrors CAMP_FIELDS order used
        // whenever every field is supplied — good enough for these tests,
        // which only ever update a known subset.
        const setCols = [...sql.matchAll(/(\w+)\s*=\s*\$\d+/g)].map(m => m[1]);
        setCols.forEach((col, i) => { row[col] = params[i]; });
        return { rows: [row] };
      }

      if (/^\s*DELETE FROM camps/i.test(sql)) {
        const [id] = params;
        const idx = camps.findIndex(c => c.id === id);
        if (idx === -1) return { rows: [] };
        const [removed] = camps.splice(idx, 1);
        return { rows: [{ id: removed.id }] };
      }

      throw new Error('unexpected query: ' + sql);
    },
  };
}

test('ensureTables issues a CREATE TABLE IF NOT EXISTS for camps', async () => {
  const client = fakeClient();
  await ensureTables(client);
  assert.ok(client.calls.some(sql => /CREATE TABLE IF NOT EXISTS camps/i.test(sql)));
});

// The whole point of the constraint: deleting a camp must never cascade into
// deleting a week of real bookings. Pin the exact clause so a future edit
// can't silently swap it for CASCADE (or drop it).
test('the bookings.camp_id migration is ON DELETE SET NULL, never CASCADE', async () => {
  const client = fakeClient();
  await ensureTables(client);
  const alter = client.calls.find(sql => /ALTER TABLE bookings/i.test(sql));
  assert.ok(alter, 'expected an ALTER TABLE bookings statement');
  assert.match(alter, /ON DELETE SET NULL/i);
  assert.doesNotMatch(alter, /ON DELETE CASCADE/i);
});

test('createCamp requires a label', async () => {
  const client = fakeClient();
  await assert.rejects(() => createCamp(client, {}), /label is required/);
  await assert.rejects(() => createCamp(client, { label: '   ' }), /label is required/);
});

test('createCamp stores the client/venue/service fields days will inherit', async () => {
  const client = fakeClient();
  const camp = await createCamp(client, {
    label: 'MAC Summer Camp',
    client_name: 'Jane Doe',
    client_email: 'jane@example.com',
    client_phone: '4055551234',
    organisation_name: 'The MAC',
    event_location: '123 Main St',
    event_zip: '73034',
    service_id: 'svc-foam',
    notes: 'Week-long, mornings only',
  });
  assert.strictEqual(camp.label, 'MAC Summer Camp');
  assert.strictEqual(camp.client_name, 'Jane Doe');
  assert.strictEqual(camp.service_id, 'svc-foam');
  assert.ok(camp.id);
});

test('listCamps reports day count and date range from its actual bookings', async () => {
  const client = fakeClient([
    { camp_id: 1, event_date: '2026-07-14' },
    { camp_id: 1, event_date: '2026-07-15' },
    { camp_id: 1, event_date: '2026-07-18' },
    { camp_id: 2, event_date: '2026-08-01' }, // unrelated camp, must not bleed in
  ]);
  await createCamp(client, { label: 'MAC Summer Camp' }); // id 1
  await createCamp(client, { label: 'Other Camp' });      // id 2
  const camps = await listCamps(client);
  const mac = camps.find(c => c.label === 'MAC Summer Camp');
  assert.strictEqual(mac.day_count, 3);
  assert.strictEqual(mac.start_date, '2026-07-14');
  assert.strictEqual(mac.end_date, '2026-07-18');
});

test('a camp with zero days lists as 0/null/null, not an error', async () => {
  const client = fakeClient();
  await createCamp(client, { label: 'Brand New Camp' });
  const [camp] = await listCamps(client);
  assert.strictEqual(camp.day_count, 0);
  assert.strictEqual(camp.start_date, null);
  assert.strictEqual(camp.end_date, null);
});

test('updateCamp renames a camp, leaving other fields untouched', async () => {
  const client = fakeClient();
  const created = await createCamp(client, { label: 'Old Name', client_name: 'Jane' });
  const updated = await updateCamp(client, created.id, { label: 'New Name' });
  assert.strictEqual(updated.label, 'New Name');
  assert.strictEqual(updated.client_name, 'Jane');
});

test('updateCamp with no recognised fields rejects rather than issuing an empty SET', async () => {
  const client = fakeClient();
  const created = await createCamp(client, { label: 'A Camp' });
  await assert.rejects(() => updateCamp(client, created.id, {}), /No fields to update/);
});

test('updateCamp on an unknown id returns null, not a thrown error', async () => {
  const client = fakeClient();
  const updated = await updateCamp(client, 9999, { label: 'X' });
  assert.strictEqual(updated, null);
});

test('deleteCamp removes the camp row and reports success', async () => {
  const client = fakeClient();
  const created = await createCamp(client, { label: 'Gone Soon' });
  const ok = await deleteCamp(client, created.id);
  assert.strictEqual(ok, true);
  assert.strictEqual((await listCamps(client)).length, 0);
});

test('deleteCamp on an unknown id reports false, not a thrown error', async () => {
  const client = fakeClient();
  const ok = await deleteCamp(client, 9999);
  assert.strictEqual(ok, false);
});

// The safety property camps.js exists to provide: deleting the camp row
// must never touch the bookings themselves. This fake client has no real FK
// engine, so it can't exercise ON DELETE SET NULL directly (that's the SQL
// text test above) — what it CAN prove is that deleteCamp's own query never
// references the bookings table at all, so there is no application-level
// path from "delete a camp" to "delete a booking".
test('deleteCamp never issues a query against bookings', async () => {
  const client = fakeClient([{ camp_id: 1, event_date: '2026-07-14' }]);
  const created = await createCamp(client, { label: 'MAC Summer Camp' });
  client.calls.length = 0;
  await deleteCamp(client, created.id);
  assert.ok(client.calls.every(sql => !/\bbookings\b/i.test(sql)), 'deleteCamp touched bookings');
});
