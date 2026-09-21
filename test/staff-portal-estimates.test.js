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

// ── Out of town is not a missing ZIP ───────────────────────────────────────
// Joe, 2026-09-20: "for this wednesday it is an out of town gig so should we
// just have a box for those or if the zip is outside of our area it already
// falls in that estimate zone?" It already does — _geo.js refuses to compute a
// drive past MAX_DRIVEABLE_MILES — but it was saying the wrong thing about it.
//
// FME-260923-SP is Orlando: ZIP 32821, 1,061 miles, measured and then refused
// on purpose, because payroll counts the drive leg twice and the real 1,833
// minutes each way would bill a 5-hour minimum as 64 hours. Reporting that as
// "no drive time for ZIP 32821" sends someone looking for a missing ZIP that
// is sitting right there.

test('a gig too far to drive says so, rather than blaming the ZIP', () => {
  const orlando = { zip_known: false, too_far_to_drive: true, event_zip: '32821', duration_minutes: 45 };
  const server = serverReasons(orlando)[0];
  assert.match(server, /out of town/);
  assert.match(server, /32821/, 'Joe still needs to know which gig');
  assert.doesNotMatch(server, /no drive time for ZIP/, 'the ZIP is known — that is how we measured 1,061 miles');
  assert.match(browserReasons(orlando)[0], /out of town/);
});

test('an unknown ZIP still blames the ZIP', () => {
  // The other branch must not have been swallowed by the new one.
  const row = { zip_known: false, too_far_to_drive: false, event_zip: '99999', duration_minutes: 45 };
  assert.match(serverReasons(row)[0], /no drive time for ZIP 99999/);
  assert.doesNotMatch(serverReasons(row)[0], /out of town/);
});

test('out of town is still an estimate, not a pass', () => {
  // The point of the rename is the wording, not the warning: these times are
  // still a placeholder and both screens must still say so.
  const orlando = { zip_known: false, too_far_to_drive: true, event_zip: '32821', duration_minutes: 45 };
  assert.strictEqual(serverReasons(orlando).length, 1);
  assert.strictEqual(browserReasons(orlando).length, 1);
});

test('the portal reads the real ZIP table, not just the seed', () => {
  // It called getDriveMins(zip) with no coords and no home base, so a ZIP that
  // zip_coords knows read as 'estimated' in the portal while the calendar,
  // which passes them, read it as solid — the two screens disagreeing about
  // one gig.
  const sa = fs.readFileSync(path.join(__dirname, '../netlify/functions/staff-assignments.js'), 'utf8');
  assert.ok(!/getDriveMins\(g\.event_zip\)\.zipKnown/.test(sa),
    'the portal is back to answering from the 67-ZIP seed');
  assert.ok(/loadZipCoords\(client, myGigs/.test(sa), 'the portal no longer loads the ZIP table');
  assert.ok(/homeBase\(client\)/.test(sa), 'the portal no longer measures from the real home base');
});

// ── A booking that knows its own length ────────────────────────────────────
// duration_minutes_override, added 2026-09-20. Party length had only ever
// lived on services.duration_minutes, reached through service_id — and a
// custom booking has none (9 of 30 upcoming), so its length fell through to a
// guessed 60 minutes baked into schedule_start and total_minutes.
const { spanFor } = require('../netlify/functions/_schedule.js');

// spanFor takes a client for three lookups. A stub is enough to prove which
// duration it picks, which is the only thing under test here.
function stubClient({ duration }) {
  return { query: async (sql) => {
    if (/service_time_templates/.test(sql)) return { rows: [] };
    if (/FROM services/.test(sql)) return { rows: duration === undefined ? [] : [{ duration_minutes: duration }] };
    return { rows: [] };
  } };
}
const BK = { event_date: '2026-09-23', event_time: '18:30', event_zip: '73069', service_id: '' };

test('the booking\'s own length beats the catalogue', async () => {
  const withCat = await spanFor(stubClient({ duration: 90 }), { ...BK, duration_minutes_override: 120 });
  const catOnly = await spanFor(stubClient({ duration: 90 }), { ...BK });
  // 30 min longer party = 30 min longer shift. Nothing else moves.
  assert.strictEqual(withCat.totalMinutes - catOnly.totalMinutes, 30);
});

test('an override stops the gig being called an estimate', async () => {
  const guessed = await spanFor(stubClient({}), { ...BK });
  assert.ok(guessed.unknowns.some(u => /duration unknown/.test(u)), 'a gig with no length should say so');
  const known = await spanFor(stubClient({}), { ...BK, duration_minutes_override: 120 });
  assert.ok(!known.unknowns.some(u => /duration unknown/.test(u)),
    'a booking that states its own length is not a guess any more');
});

test('a zero-minute override is honoured, not treated as absent', async () => {
  // ?? not ||. A zero-length gig is odd but it is an answer, and || would
  // silently swap it for the catalogue or the 60-minute guess.
  const zero = await spanFor(stubClient({ duration: 90 }), { ...BK, duration_minutes_override: 0 });
  const ninety = await spanFor(stubClient({ duration: 90 }), { ...BK });
  assert.strictEqual(ninety.totalMinutes - zero.totalMinutes, 90);
});

test('both screens resolve the override in SQL, so neither can disagree', () => {
  for (const f of ['../netlify/functions/calendar.js', '../netlify/functions/staff-assignments.js']) {
    const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
    assert.match(src, /COALESCE\(b\.duration_minutes_override, s(vc)?\.duration_minutes\)/,
      `${f} reads the catalogue duration without preferring the booking's own`);
  }
});
