const { test } = require('node:test');
const assert = require('node:assert');
const { zonedToInstant, dayBoundsInZone } = require('../netlify/functions/_tz.js');

const TZ = 'America/Chicago';

test('CDT: 2pm Central in September is 19:00 UTC', () => {
  assert.strictEqual(zonedToInstant(2026, 9, 12, 14, 0, TZ).toISOString(), '2026-09-12T19:00:00.000Z');
});

test('CST: 2pm Central in December is 20:00 UTC', () => {
  assert.strictEqual(zonedToInstant(2026, 12, 12, 14, 0, TZ).toISOString(), '2026-12-12T20:00:00.000Z');
});

test('a non-Central TZID is honoured, not assumed to be Chicago', () => {
  assert.strictEqual(zonedToInstant(2026, 9, 12, 14, 0, 'Europe/London').toISOString(), '2026-09-12T13:00:00.000Z');
});

test('the hour after the spring-forward gap resolves correctly', () => {
  // 8 Mar 2026, 02:00-03:00 Central does not exist. 03:00 does, and it is
  // already CDT (UTC-5): 01:59 CST (07:59 UTC) jumps straight to 03:00 CDT
  // (08:00 UTC), verified against the platform's own tz database.
  assert.strictEqual(zonedToInstant(2026, 3, 8, 3, 0, TZ).toISOString(), '2026-03-08T08:00:00.000Z');
});

test('the fall-back day is 25 hours long and dayBoundsInZone covers all of it', () => {
  const { start, end } = dayBoundsInZone('2026-11-01', TZ);
  assert.strictEqual(start.toISOString(), '2026-11-01T05:00:00.000Z');
  assert.strictEqual(end.toISOString(),   '2026-11-02T06:00:00.000Z');
  assert.strictEqual((end - start) / 3600000, 25);
});

test('an ordinary day is 24 hours', () => {
  const { start, end } = dayBoundsInZone('2026-09-12', TZ);
  assert.strictEqual((end - start) / 3600000, 24);
});
