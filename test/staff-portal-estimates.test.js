const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { estimateReasons: serverReasons, DEFAULT_MINUTES } = require('../netlify/functions/_schedule.js');

// ── When the stage times are a guess, and saying so ────────────────────────
// Two unknowns move every time on the screen, and until 2026-09-20 only one of
// them was ever mentioned:
//
//   - an unrecognised or missing ZIP makes the drive a 30-minute fallback
//   - a booking with no service_id has no catalogue duration, so the party
//     length is a fallback too
//
// Measured that day: 9 of 30 upcoming bookings had no service_id. One of them,
// FM-BF5XDJVB, is named "Community Magic Walkaround 3 hours" and was being
// planned as a 60-minute gig, putting its "home by" about two hours early —
// and both screens presented that as solid.

const HTML = fs.readFileSync(path.join(__dirname, '../staff-portal.html'), 'utf8');

function portalReasons() {
  const a = HTML.indexOf('// ══ PURE TIME HELPERS');
  const b = HTML.indexOf('// ══ END PURE TIME HELPERS');
  const ctx = {};
  vm.createContext(ctx);
  const fmtTime = HTML.slice(HTML.indexOf('function fmtTime(t)'), a);
  vm.runInContext(fmtTime + HTML.slice(a, b) + '\nout = estimateReasons;', ctx);
  return ctx.out;
}
// Spread on the way out: the helper runs in a vm context, so its arrays carry
// that realm's Array prototype and deepStrictEqual compares prototypes. An
// assertion that fails with "actual [] expected []" is this, not a bug.
const _raw = portalReasons();
const browserReasons = (g) => [..._raw(g)];

test('a solid gig is not nagged about', () => {
  const solid = { zip_known: true, duration_minutes: 45 };
  assert.deepStrictEqual(serverReasons(solid), []);
  assert.deepStrictEqual(browserReasons(solid), []);
});

test('an unknown ZIP is reported by both screens', () => {
  const row = { zip_known: false, event_zip: '99999', duration_minutes: 45 };
  assert.strictEqual(serverReasons(row).length, 1);
  assert.strictEqual(browserReasons(row).length, 1);
  assert.match(serverReasons(row)[0], /99999/, 'the calendar names the ZIP, for Joe to go and fix');
});

test('a missing service duration is reported by both screens', () => {
  // This is the half that was silent.
  const row = { zip_known: true, duration_minutes: null };
  assert.strictEqual(serverReasons(row).length, 1, 'the calendar says nothing about a guessed party length');
  assert.strictEqual(browserReasons(row).length, 1, 'the portal says nothing about a guessed party length');
  assert.match(serverReasons(row)[0], new RegExp(String(DEFAULT_MINUTES.party)),
    'the calendar should name the number it guessed');
});

test('both unknowns at once are both named, not just the first', () => {
  // FM-BF5XDJVB as it actually stands: no ZIP and no service.
  const row = { zip_known: false, event_zip: '', duration_minutes: null };
  assert.strictEqual(serverReasons(row).length, 2);
  assert.strictEqual(browserReasons(row).length, 2);
});

test('a zero-minute service is an answer, not a missing one', () => {
  const row = { zip_known: true, duration_minutes: 0 };
  assert.deepStrictEqual(serverReasons(row), [], 'zero was treated as unknown');
  assert.deepStrictEqual(browserReasons(row), []);
});

test('the two screens agree on how many things are soft', () => {
  // They cannot share code across the browser boundary, so they are pinned to
  // the same COUNT of reasons — the wording differs on purpose, because one
  // reader fixes the data and the other has to work the gig.
  for (const row of [
    { zip_known: true,  duration_minutes: 45 },
    { zip_known: false, duration_minutes: 45, event_zip: '73118' },
    { zip_known: true,  duration_minutes: null },
    { zip_known: false, duration_minutes: null, event_zip: '' },
  ]) {
    assert.strictEqual(browserReasons(row).length, serverReasons(row).length,
      JSON.stringify(row) + ' — one screen warns and the other does not');
  }
});

test('the two fallbacks for an unknown party length are now one', () => {
  // calendar.js used 90 and _schedule.js used 60: an unlinked booking blocked
  // 90 minutes on Joe's calendar around a 60-minute party in the crew's shift.
  const cal = fs.readFileSync(path.join(__dirname, '../netlify/functions/calendar.js'), 'utf8');
  assert.ok(!/duration_minutes\) \|\| 90/.test(cal), 'the calendar has its own 90-minute fallback again');
  assert.ok(/DEFAULT_MINUTES\.party/.test(cal), 'the calendar no longer shares the one fallback');
  const sch = fs.readFileSync(path.join(__dirname, '../netlify/functions/_schedule.js'), 'utf8');
  assert.ok(!/duration_minutes \?\? 60/.test(sch), 'the shift maths has its own 60-minute fallback again');
});
