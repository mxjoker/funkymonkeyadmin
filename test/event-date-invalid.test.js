const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { fmtEventDate } = require('../netlify/functions/_email.js');

// node-postgres returns a DATE column as a Date object at LOCAL midnight.
// `dateObject + 'T00:00:00'` stringifies it to "Mon Aug 24 2026 00:00:00
// GMT-0500 (Central Daylight Time)T00:00:00", which parses to Invalid Date —
// and toLocaleDateString renders that as the literal text "Invalid Date"
// instead of throwing. Staff were texted "You're booked: …, Invalid Date."
const pgDate = (y, m, d) => new Date(y, m - 1, d);

test('fmtEventDate formats a pg Date object, not "Invalid Date"', () => {
  const out = fmtEventDate(pgDate(2026, 8, 24));
  assert.strictEqual(out, 'Monday, August 24, 2026');
  assert.ok(!out.includes('Invalid'), out);
});

test('fmtEventDate keeps the calendar day it was given', () => {
  // The failure this catches is off-by-one, not a crash: reading a Date with
  // UTC getters in a UTC-5 zone moves the gig back a day, and a staff member
  // shows up on the wrong date having been told so confidently.
  assert.strictEqual(fmtEventDate(pgDate(2026, 1, 1)), 'Thursday, January 1, 2026');
  assert.strictEqual(fmtEventDate(pgDate(2026, 12, 31)), 'Thursday, December 31, 2026');
  assert.strictEqual(fmtEventDate('2026-08-24'), 'Monday, August 24, 2026');
});

test('no message path rebuilds an event date by string concatenation', () => {
  // staff-assignments.js had two copies of this; accept-quote.js had a third,
  // in a client's acceptance email. Guarding all of them together, because the
  // failure mode is a believable-looking string, not an exception.
  const src = ['netlify/functions/staff-assignments.js', 'netlify/functions/accept-quote.js',
               'netlify/functions/automations-scheduled.js']
    .map((f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')).join('\n');
  // Comments are allowed to describe the bug; code is not allowed to contain it.
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.ok(!/event_date\s*\)?\s*\+\s*'T00:00:00'/.test(code),
    'a date is being rebuilt with string concatenation again — use fmtEventDate');
  assert.ok(!/String\(\s*[\w.]*event_date\s*\)\.split\('T'\)/.test(code),
    "String(date).split('T') does not guard this — String(Date) has no 'T' to split on");
});

// The unstaffed alert hid from the first sweep: its concatenation ends in
// 'T00:00:00Z' and the grep that found the others excluded the Z suffix. The
// guard below matches the slice() form too, so neither spelling comes back.
test('no server path rebuilds a date with slice() either', () => {
  const files = ['netlify/functions/staff-assignments.js', 'netlify/functions/accept-quote.js',
                 'netlify/functions/automations-scheduled.js'];
  for (const f of files) {
    const code = fs.readFileSync(path.join(__dirname, '..', f), 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    assert.ok(!/String\(\s*[\w.]*event_date\s*\)\.slice\(/.test(code),
      `${f}: String(date).slice() does not survive a Date object — String(Date) is "Mon Aug 24 2026 ..."`);
  }
});

test('the unstaffed alert formats a pg Date, not "Invalid Date"', () => {
  const out = fmtEventDate(pgDate(2026, 8, 24), { weekday: 'short', month: 'numeric', day: 'numeric', year: undefined });
  assert.strictEqual(out, 'Mon, 8/24');
  assert.ok(!out.includes('Invalid'), out);
});
