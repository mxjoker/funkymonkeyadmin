const { test } = require('node:test');
const assert = require('node:assert');
const { overlaps, conflictsFor, publicAvailability } = require('../netlify/functions/_availability.js');

const NOW = new Date('2026-09-01T12:00:00Z');
const BOOKING = { id: 5, service_id: 'magic', event_date: '2026-09-12', event_time: '14:00', event_zip: '73102' };

// The gig's working span is 17:20Z -> 21:00Z (see test/schedule-span.test.js).
function client({ feeds = [], busy = [], bookings = [] } = {}) {
  return { query: async (sql) => {
    if (/FROM service_time_templates/i.test(sql)) return { rows: [] };
    if (/FROM services/i.test(sql)) return { rows: [{ duration_minutes: 60 }] };
    if (/FROM calendar_feeds/i.test(sql)) return { rows: feeds };
    if (/FROM external_busy/i.test(sql)) return { rows: busy };
    if (/FROM bookings/i.test(sql)) return { rows: bookings };
    return { rows: [] };
  } };
}

const healthyFeed = { id: 1, label: 'Personal', active: true, last_status: 'ok', last_error: null,
                      last_synced_at: new Date('2026-09-01T11:00:00Z'), last_warnings: [] };

test('half-open: touching intervals do not overlap', () => {
  const a1 = new Date('2026-09-12T14:00:00Z'), a2 = new Date('2026-09-12T15:00:00Z');
  const b1 = new Date('2026-09-12T15:00:00Z'), b2 = new Date('2026-09-12T16:00:00Z');
  assert.strictEqual(overlaps(a1, a2, b1, b2), false);
  assert.strictEqual(overlaps(b1, b2, a1, a2), false);
});

test('half-open: a one-minute intersection does overlap', () => {
  assert.strictEqual(overlaps(
    new Date('2026-09-12T14:00:00Z'), new Date('2026-09-12T15:01:00Z'),
    new Date('2026-09-12T15:00:00Z'), new Date('2026-09-12T16:00:00Z')), true);
});

test('an appointment inside the travel window is a conflict, not just inside the party', async () => {
  // 13:30 Central = 18:30Z, during the drive. The party does not start until 14:00 Central.
  const busy = [{ feed_id: 1, feed_label: 'Personal', summary: 'Dentist', all_day: false,
                  starts_at: '2026-09-12T18:30:00Z', ends_at: '2026-09-12T19:00:00Z' }];
  const r = await conflictsFor(client({ feeds: [healthyFeed], busy }), BOOKING, { now: NOW });
  assert.strictEqual(r.external.length, 1);
  assert.strictEqual(r.external[0].summary, 'Dentist');
  assert.strictEqual(r.degraded, false);
});

test('an event outside the working span is not a conflict', async () => {
  const busy = [{ feed_id: 1, feed_label: 'Personal', summary: 'Breakfast', all_day: false,
                  starts_at: '2026-09-12T12:00:00Z', ends_at: '2026-09-12T13:00:00Z' }];
  const r = await conflictsFor(client({ feeds: [healthyFeed], busy }), BOOKING, { now: NOW });
  assert.strictEqual(r.external.length, 0);
});

test('other FME bookings are conflicts too, tiered hard and soft', async () => {
  const bookings = [
    { id: 9,  reference: 'FM-A', client_name: 'Ann', status: 'confirmed', event_date: '2026-09-12', event_time: '15:00', event_zip: '73102', service_id: 'magic' },
    { id: 10, reference: 'FM-B', client_name: 'Bob', status: 'quoted',    event_date: '2026-09-12', event_time: '15:00', event_zip: '73102', service_id: 'magic' },
  ];
  const r = await conflictsFor(client({ feeds: [healthyFeed], bookings }), BOOKING, { now: NOW });
  assert.deepStrictEqual(r.bookings.map(b => [b.reference, b.tier]), [['FM-A', 'hard'], ['FM-B', 'soft']]);
});

test('the booking being edited is never a conflict with itself', async () => {
  const bookings = [{ id: 5, reference: 'FM-SELF', client_name: 'Joe', status: 'confirmed',
                      event_date: '2026-09-12', event_time: '14:00', event_zip: '73102', service_id: 'magic' }];
  const r = await conflictsFor(client({ feeds: [healthyFeed], bookings }), BOOKING, { now: NOW, excludeBookingId: 5 });
  assert.strictEqual(r.bookings.length, 0);
});

test('an all-day event blocks the whole day', async () => {
  const busy = [{ feed_id: 1, feed_label: 'Personal', summary: 'Wedding in Tulsa', all_day: true,
                  starts_at: '2026-09-12T05:00:00Z', ends_at: '2026-09-13T05:00:00Z' }];
  const r = await conflictsFor(client({ feeds: [healthyFeed], busy }), BOOKING, { now: NOW });
  assert.strictEqual(r.external.length, 1);
});

test('a STALE feed degrades the result — and it never reports clear', async () => {
  const stale = { ...healthyFeed, last_synced_at: new Date('2026-08-29T11:00:00Z') }; // >25h
  const r = await conflictsFor(client({ feeds: [stale] }), BOOKING, { now: NOW });
  assert.strictEqual(r.external.length, 0, 'nothing was found');
  assert.strictEqual(r.degraded, true, 'but the result must not be presented as clear');
  assert.match(r.degradedReasons.join(' '), /Personal/);
});

test('an ERRORED feed degrades the result', async () => {
  const broken = { ...healthyFeed, last_status: 'error', last_error: 'HTTP 404' };
  const r = await conflictsFor(client({ feeds: [broken] }), BOOKING, { now: NOW });
  assert.strictEqual(r.degraded, true);
  assert.match(r.degradedReasons.join(' '), /404/);
});

test('a feed that has NEVER synced degrades the result', async () => {
  const fresh = { ...healthyFeed, last_synced_at: null, last_status: null };
  const r = await conflictsFor(client({ feeds: [fresh] }), BOOKING, { now: NOW });
  assert.strictEqual(r.degraded, true);
  assert.match(r.degradedReasons.join(' '), /never/i);
});

test('parser warnings are surfaced on the result', async () => {
  const warned = { ...healthyFeed, last_warnings: ['the recurring event "School run" uses BYSETPOS'] };
  const r = await conflictsFor(client({ feeds: [warned] }), BOOKING, { now: NOW });
  assert.match(r.warnings.join(' '), /School run/);
});

test('a booking with no time reports windowKnown false rather than a guessed window', async () => {
  const r = await conflictsFor(client({ feeds: [healthyFeed] }), { ...BOOKING, event_time: null }, { now: NOW });
  assert.strictEqual(r.windowKnown, false);
  assert.ok(r.unknowns.some(u => /time/i.test(u)));
});

test('publicAvailability FAILS CLOSED when degraded, even with nothing found', async () => {
  const broken = { ...healthyFeed, last_status: 'error', last_error: 'HTTP 500' };
  const r = await publicAvailability(client({ feeds: [broken] }), BOOKING, { now: NOW });
  assert.deepStrictEqual(r, { available: false, degraded: true });
});

test('publicAvailability leaks nothing about what is in the calendar', async () => {
  const busy = [{ feed_id: 1, feed_label: 'Personal', summary: 'Therapy', all_day: false,
                  starts_at: '2026-09-12T18:30:00Z', ends_at: '2026-09-12T19:00:00Z' }];
  const r = await publicAvailability(client({ feeds: [healthyFeed], busy }), BOOKING, { now: NOW });
  assert.deepStrictEqual(Object.keys(r).sort(), ['available', 'degraded']);
  assert.ok(!JSON.stringify(r).includes('Therapy'));
  assert.strictEqual(r.available, false);
});

test('publicAvailability is available when healthy and clear', async () => {
  const r = await publicAvailability(client({ feeds: [healthyFeed] }), BOOKING, { now: NOW });
  assert.deepStrictEqual(r, { available: true, degraded: false });
});

// ── the handler: booking_id ruling ──────────────────────────────────────────
// The brief's plan text has the handler read service_id off a query param.
// The booking modal has no such field — service is derived from item rows —
// so that param is always empty for a real booking and every gig would be
// silently checked against a 60-minute default. Instead: an optional
// booking_id loads the real service_id/event_date/event_time/event_zip
// server-side, with any explicit query param overriding the loaded value.
function loadHandler(fakeClient) {
  for (const m of ['../netlify/functions/availability.js', '../netlify/functions/_db.js', '../netlify/functions/_auth.js']) {
    delete require.cache[require.resolve(m)];
  }
  const dbMod = require('../netlify/functions/_db.js');
  dbMod.withClient = async (fn) => fn(fakeClient);
  const authMod = require('../netlify/functions/_auth.js');
  authMod.requireAuth = async () => ({ role: 'admin' });
  authMod.preflight = () => null;
  return require('../netlify/functions/availability.js');
}

test('handler: booking_id loads service_id/date/time/zip from the row and excludes itself', async () => {
  const seen = [];
  const fakeClient = {
    query: async (sql, params) => {
      seen.push(sql);
      if (/SELECT id, service_id, event_date, event_time, event_zip\s+FROM bookings/i.test(sql)) {
        return { rows: [{ id: 5, service_id: 'magic', event_date: '2026-09-12', event_time: '14:00', event_zip: '73102' }] };
      }
      if (/FROM service_time_templates/i.test(sql)) return { rows: [] };
      if (/FROM services/i.test(sql)) return { rows: [{ duration_minutes: 60 }] };
      if (/FROM calendar_feeds/i.test(sql)) return { rows: [healthyFeed] };
      if (/FROM external_busy/i.test(sql)) return { rows: [] };
      // The "other bookings" query: the booking being checked (id 5) must be
      // excluded from its own conflict list by default.
      if (/^\s*SELECT id, reference, client_name, status, event_date, event_time, event_zip, service_id\s+FROM bookings/i.test(sql)) {
        return { rows: [{ id: 5, reference: 'FM-SELF', client_name: 'Joe', status: 'confirmed',
                          event_date: '2026-09-12', event_time: '14:00', event_zip: '73102', service_id: 'magic' }] };
      }
      return { rows: [] };
    },
  };
  const { handler } = loadHandler(fakeClient);
  const res = await handler({ queryStringParameters: { booking_id: '5' } });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.strictEqual(body.windowKnown, true);
  assert.strictEqual(body.bookings.length, 0, 'the booking is never a conflict with itself');
});

test('handler: an explicit query param overrides the loaded booking_id value', async () => {
  const fakeClient = {
    query: async (sql) => {
      if (/SELECT id, service_id, event_date, event_time, event_zip\s+FROM bookings/i.test(sql)) {
        return { rows: [{ id: 5, service_id: 'magic', event_date: '2026-09-12', event_time: '14:00', event_zip: '73102' }] };
      }
      if (/FROM service_time_templates/i.test(sql)) return { rows: [] };
      if (/FROM services/i.test(sql)) return { rows: [{ duration_minutes: 60 }] };
      return { rows: [] };
    },
  };
  const { handler } = loadHandler(fakeClient);
  // Override the time only; everything else still comes from the loaded row.
  const res = await handler({ queryStringParameters: { booking_id: '5', time: '18:00' } });
  const body = JSON.parse(res.body);
  assert.strictEqual(body.windowKnown, true);
  // 18:00 Central leaves home earlier/later than 14:00 would have — just prove
  // the override changed the window rather than the loaded 14:00 winning.
  assert.notStrictEqual(body.window.startsAt, '2026-09-12T17:20:00.000Z');
});

test('handler: no booking_id and no service_id falls back honestly (60-minute default recorded in unknowns)', async () => {
  const fakeClient = {
    query: async (sql) => {
      if (/FROM service_time_templates/i.test(sql)) return { rows: [] };
      if (/FROM services/i.test(sql)) return { rows: [] }; // no service_id -> no row
      return { rows: [] };
    },
  };
  const { handler } = loadHandler(fakeClient);
  const res = await handler({ queryStringParameters: { date: '2026-09-12', time: '14:00', zip: '73102' } });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(body.unknowns.some(u => /60 minutes/.test(u)));
});

test('handler: a nonexistent booking_id returns 404, not a silent empty result', async () => {
  const fakeClient = { query: async () => ({ rows: [] }) };
  const { handler } = loadHandler(fakeClient);
  const res = await handler({ queryStringParameters: { booking_id: '999' } });
  assert.strictEqual(res.statusCode, 404);
});

test('handler: no date and no booking_id is a 400', async () => {
  const fakeClient = { query: async () => ({ rows: [] }) };
  const { handler } = loadHandler(fakeClient);
  const res = await handler({ queryStringParameters: {} });
  assert.strictEqual(res.statusCode, 400);
});
