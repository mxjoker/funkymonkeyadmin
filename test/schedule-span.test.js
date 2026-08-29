const { test } = require('node:test');
const assert = require('node:assert');

// A pinning test. It asserts what the code does TODAY, not what it should do,
// so that Task 3 can move this arithmetic into _schedule.js and prove nothing
// changed. total_minutes feeds payroll; "probably the same" is not good enough.
const { getDriveMins, spanFor } = require('../netlify/functions/_schedule.js');
const { autoCalcTimes } = require('../netlify/functions/staff-assignments.js');

test('getDriveMins: a known ZIP gives a haversine estimate at 35mph plus a 15 min stop', () => {
  // 73102 (downtown) from home 73118. Distance is ~3.4mi, so the raw estimate
  // floors at 10, then +15.
  assert.deepStrictEqual(getDriveMins('73102'), { minutes: 25, zipKnown: true });
});

test('getDriveMins: a 9-digit ZIP is truncated to 5', () => {
  assert.deepStrictEqual(getDriveMins('73102-1234'), { minutes: 25, zipKnown: true });
});

test('getDriveMins: an unknown ZIP still returns 30 — BUG-1, pinned deliberately', () => {
  // The NUMBER is unchanged on purpose: it reaches payroll through
  // total_minutes. zipKnown only lets a caller say it is a guess.
  assert.deepStrictEqual(getDriveMins('99999'), { minutes: 30, zipKnown: false });
  assert.deepStrictEqual(getDriveMins(''),      { minutes: 30, zipKnown: false });
  assert.deepStrictEqual(getDriveMins(null),    { minutes: 30, zipKnown: false });
});

test('autoCalcTimes: total is load + drive + setup + party + pack + drive + home unload', async () => {
  const updates = [];
  const c = {
    query: async (sql, params) => {
      if (/FROM staff_assignments/i.test(sql)) {
        return { rows: [{ id: 1, total_minutes: null }] };
      }
      if (/FROM bookings/i.test(sql)) {
        return { rows: [{ id: 9, service_id: 'magic', event_time: '14:00', event_zip: '73102' }] };
      }
      if (/FROM service_time_templates/i.test(sql)) return { rows: [] };
      if (/FROM services/i.test(sql)) return { rows: [{ duration_minutes: 60 }] };
      if (/^\s*UPDATE staff_assignments/i.test(sql)) { updates.push(params); return { rows: [] }; }
      return { rows: [] };
    }
  };

  await autoCalcTimes(c, 1, 9);

  assert.strictEqual(updates.length, 1, 'autoCalcTimes must persist exactly one update');
  const [load, setup, pack, homeUn, drive, total, scheduleStart] = updates[0];
  assert.deepStrictEqual(
    { load, setup, pack, homeUn, drive },
    { load: 30, setup: 45, pack: 20, homeUn: 15, drive: 25 },
    'defaults when no template row exists'
  );
  // 30 + 25 + 45 + 60 + 20 + 25 + 15
  assert.strictEqual(total, 220);
  // 14:00 minus load(30) + drive(25) + setup(45) = 100 minutes -> 12:20
  assert.strictEqual(scheduleStart, '12:20');
});

test('autoCalcTimes: persists drive_estimated from spanFor\'s zipKnown — false for a known ZIP', async () => {
  const updates = [];
  const c = {
    query: async (sql, params) => {
      if (/FROM staff_assignments/i.test(sql)) return { rows: [{ id: 1, total_minutes: null }] };
      if (/FROM bookings/i.test(sql)) return { rows: [{ id: 9, service_id: 'magic', event_time: '14:00', event_zip: '73102' }] };
      if (/FROM service_time_templates/i.test(sql)) return { rows: [] };
      if (/FROM services/i.test(sql)) return { rows: [{ duration_minutes: 60 }] };
      if (/^\s*UPDATE staff_assignments/i.test(sql)) { updates.push(params); return { rows: [] }; }
      return { rows: [] };
    }
  };
  await autoCalcTimes(c, 1, 9);
  assert.strictEqual(updates[0][7], false, 'a known ZIP is not an estimate');
});

test('autoCalcTimes: persists drive_estimated=true for a blank/unknown ZIP — the fix this round exists for', async () => {
  const updates = [];
  const c = {
    query: async (sql, params) => {
      if (/FROM staff_assignments/i.test(sql)) return { rows: [{ id: 1, total_minutes: null }] };
      if (/FROM bookings/i.test(sql)) return { rows: [{ id: 9, service_id: 'magic', event_time: '14:00', event_zip: '' }] };
      if (/FROM service_time_templates/i.test(sql)) return { rows: [] };
      if (/FROM services/i.test(sql)) return { rows: [{ duration_minutes: 60 }] };
      if (/^\s*UPDATE staff_assignments/i.test(sql)) { updates.push(params); return { rows: [] }; }
      return { rows: [] };
    }
  };
  await autoCalcTimes(c, 1, 9);
  assert.strictEqual(updates[0][7], true, 'a blank ZIP must be flagged as an estimate, not silently guessed');
});

test('autoCalcTimes: no event_time means no schedule_start, not a guessed one', async () => {
  const updates = [];
  const c = {
    query: async (sql, params) => {
      if (/FROM staff_assignments/i.test(sql)) return { rows: [{ id: 1, total_minutes: null }] };
      if (/FROM bookings/i.test(sql)) return { rows: [{ id: 9, service_id: 'magic', event_time: null, event_zip: '73102' }] };
      if (/FROM service_time_templates/i.test(sql)) return { rows: [] };
      if (/FROM services/i.test(sql)) return { rows: [{ duration_minutes: 60 }] };
      if (/^\s*UPDATE staff_assignments/i.test(sql)) { updates.push(params); return { rows: [] }; }
      return { rows: [] };
    }
  };

  await autoCalcTimes(c, 1, 9);
  assert.strictEqual(updates[0][6], null, 'schedule_start must stay null when the gig has no time');
});

// Fix round 1: autoCalcTimes used to keep its own load/setup/pack/homeUn
// defaults in a separate ?? chain, duplicating spanFor's. In sync today, but
// a changed default in one place and not the other would silently desync the
// persisted breakdown columns from total_minutes. Now both come from the same
// span object, so this identity holds structurally rather than by luck — if
// a future edit reintroduces a second copy of the defaults, this fails the
// moment the two disagree.
test('autoCalcTimes: persisted total_minutes equals the sum of the persisted component columns', async () => {
  const updates = [];
  const c = {
    query: async (sql, params) => {
      if (/FROM staff_assignments/i.test(sql)) return { rows: [{ id: 1, total_minutes: null }] };
      if (/FROM bookings/i.test(sql)) return { rows: [{ id: 9, service_id: 'magic', event_time: '14:00', event_zip: '73102' }] };
      if (/FROM service_time_templates/i.test(sql)) return { rows: [] };
      if (/FROM services/i.test(sql)) return { rows: [{ duration_minutes: 60 }] };
      if (/^\s*UPDATE staff_assignments/i.test(sql)) { updates.push(params); return { rows: [] }; }
      return { rows: [] };
    }
  };

  await autoCalcTimes(c, 1, 9);
  const [load, setup, pack, homeUn, drive, total] = updates[0];
  assert.strictEqual(
    total, load + drive + setup + 60 + pack + drive + homeUn,
    'total_minutes must be built from exactly the load/setup/pack/homeUn/drive values persisted alongside it'
  );
});

const bookingRow = (over = {}) => ({
  id: 9, service_id: 'magic', event_date: '2026-09-12', event_time: '14:00', event_zip: '73102', ...over,
});

const spanClient = (tmpl = [], svc = [{ duration_minutes: 60 }]) => ({
  query: async (sql) => {
    if (/FROM service_time_templates/i.test(sql)) return { rows: tmpl };
    if (/FROM services/i.test(sql)) return { rows: svc };
    return { rows: [] };
  }
});

test('spanFor works on a booking with NO staff assignment — the reason this exists', async () => {
  const s = await spanFor(spanClient(), bookingRow());
  assert.strictEqual(s.windowKnown, true);
  assert.strictEqual(s.totalMinutes, 220);
  // Leaves home 12:20 Central = 17:20 UTC in September.
  assert.strictEqual(s.startsAt.toISOString(), '2026-09-12T17:20:00.000Z');
  // 12:20 + 220 minutes = 16:00 Central = 21:00 UTC.
  assert.strictEqual(s.endsAt.toISOString(), '2026-09-12T21:00:00.000Z');
});

test('spanFor: no event_time gives windowKnown false and says why, never a guessed window', async () => {
  const s = await spanFor(spanClient(), bookingRow({ event_time: null }));
  assert.strictEqual(s.windowKnown, false);
  assert.strictEqual(s.startsAt, null);
  assert.strictEqual(s.endsAt, null);
  assert.ok(s.unknowns.some(u => /time/i.test(u)), 'unknowns must name the missing time');
});

test('spanFor: an unknown ZIP reports zipKnown false while still returning the 30-minute figure', async () => {
  const s = await spanFor(spanClient(), bookingRow({ event_zip: '99999' }));
  assert.strictEqual(s.zipKnown, false);
  assert.strictEqual(s.driveMinutes, 30);
  assert.ok(s.unknowns.some(u => /zip/i.test(u)));
});

test('spanFor: assignment overrides beat the template', async () => {
  const s = await spanFor(spanClient(), bookingRow(), { drive_minutes_each_way: 90, load_minutes: 10 });
  // 10 + 90 + 45 + 60 + 20 + 90 + 15
  assert.strictEqual(s.totalMinutes, 330);
});

test('spanFor: a template row beats the hardcoded defaults', async () => {
  const tmpl = [{ load_minutes: 5, unload_minutes: 5, pack_out_minutes: 5, home_unload_minutes: 5 }];
  const s = await spanFor(spanClient(tmpl), bookingRow());
  // 5 + 25 + 5 + 60 + 5 + 25 + 5
  assert.strictEqual(s.totalMinutes, 130);
});

test('spanFor: event_date as a real JS Date (what pg actually hands back from a DATE column) is not garbled', async () => {
  // A row read straight off `bookings` never carries a "YYYY-MM-DD" string —
  // pg parses DATE columns into a JS Date. Before the fix, String(aDate).slice(0,10)
  // sliced "Sat Sep 12" off of "Sat Sep 12 2026 00:00:00 GMT..." and produced
  // NaN dates while still reporting windowKnown: true.
  const s = await spanFor(spanClient(), bookingRow({ event_date: new Date(2026, 8, 12) }));
  assert.strictEqual(s.windowKnown, true);
  assert.strictEqual(s.startsAt.toISOString(), '2026-09-12T17:20:00.000Z');
  assert.strictEqual(s.endsAt.toISOString(), '2026-09-12T21:00:00.000Z');
});
