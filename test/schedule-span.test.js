const { test } = require('node:test');
const assert = require('node:assert');

// A pinning test. It asserts what the code does TODAY, not what it should do,
// so that Task 3 can move this arithmetic into _schedule.js and prove nothing
// changed. total_minutes feeds payroll; "probably the same" is not good enough.
const { getDriveMins, autoCalcTimes } = require('../netlify/functions/staff-assignments.js');

test('getDriveMins: a known ZIP gives a haversine estimate at 35mph plus a 15 min stop', () => {
  // 73102 (downtown) from home 73118. Distance is ~3.4mi, so the raw estimate
  // floors at 10, then +15.
  assert.strictEqual(getDriveMins('73102'), 25);
});

test('getDriveMins: a 9-digit ZIP is truncated to 5', () => {
  assert.strictEqual(getDriveMins('73102-1234'), 25);
});

test('getDriveMins: an unknown ZIP silently returns 30 — BUG-1, pinned deliberately', () => {
  // This is wrong and it is tracked as BUG-1. It is pinned here so the
  // extraction cannot change it by accident; fixing it is a separate task
  // with its own thought about what payroll should do.
  assert.strictEqual(getDriveMins('99999'), 30);
  assert.strictEqual(getDriveMins(''), 30);
  assert.strictEqual(getDriveMins(null), 30);
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
