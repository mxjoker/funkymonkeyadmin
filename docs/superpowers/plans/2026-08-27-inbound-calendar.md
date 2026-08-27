# Inbound Calendar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the CRM read Joe's personal calendars so it can answer "am I free that Saturday?" — instead of only knowing about gigs it created itself.

**Architecture:** A scheduled Netlify function pulls each subscribed ICS feed hourly into a cache table. One availability function computes a gig's true working span (leave home → home unloaded) and reports overlaps from both the imported calendars and other FME bookings. Two projections: a rich admin view, and a `{available, degraded}` view for the public Instant Booking gate that fails closed.

**Tech Stack:** Node 18+ on Netlify Functions, PostgreSQL via `pg`, `node --test` for tests. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-27-inbound-calendar-design.md`

**Branch:** `feat/inbound-calendar` (already exists, carries the spec commit).

## Global Constraints

- **No new npm dependencies.** The repo has exactly two (`pg`, `pdf-lib`) and that is deliberate. Recurrence and timezone handling are written by hand against stdlib `Intl`.
- **Tests:** `node:test` + `node:assert`, run by `npm test`. No framework, no fixtures directory, no mocking library.
- **Database access is injected.** Every exported function takes a `client` as its first argument so tests can pass a fake `{ query: async (sql, params) => ({ rows: [...] }) }`. Follow `automations-scheduled.js`, which exports `unstaffedAlerts(c, now)` for exactly this reason.
- **Timezone:** `America/Chicago` for floating and all-day values. `TZID` values are honoured as given.
- **Cache window:** today − 7 days to today + 18 months.
- **The feed URL is a credential.** It is never returned in full by any endpoint. The only write operation is replace.
- **Half-open intervals `[start, end)`.** Touching intervals do not overlap.
- **`getDriveMins`' `return 30` fallback for an unknown ZIP must not change.** It reaches payroll via `total_minutes`. It gains a `zipKnown` flag and nothing else. Changing the number is BUG-1's job.
- **Admin endpoints:** `await requireAuth(event, ['admin'])`, returning `unauthorized()` on failure — copy `coi-request.js:136`.
- **Commits:** conventional prefix, and end every message with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- **Staging:** `git add <explicit paths>`. Never `git add -A`.

---

## File Structure

| File | Responsibility |
|---|---|
| `netlify/functions/_tz.js` | **New.** Wall-clock + IANA zone → absolute instant. Day bounds in a zone. |
| `netlify/functions/_schedule.js` | **New.** Working-span math + `getDriveMins`, moved out of `staff-assignments.js`. |
| `netlify/functions/_ics.js` | **New.** Pure ICS parser. String in, busy periods out. No I/O. |
| `netlify/functions/_availability.js` | **New.** Conflict check. Admin and public projections. Helper only — no handler. |
| `netlify/functions/availability.js` | **New.** Thin HTTP endpoint over `_availability.js`. |
| `netlify/functions/calendar-feeds.js` | **New.** Admin CRUD for feeds + refresh action. |
| `netlify/functions/calendar-sync.js` | **New.** Scheduled fetch/parse/replace. |
| `netlify/functions/staff-assignments.js` | **Modify.** `autoCalcTimes` becomes a caller of `_schedule.js`. |
| `admin.html` | **Modify.** Conflict panel, save warning, feeds settings. |
| `netlify.toml` | **Modify.** Schedule + two redirects. |

The spec listed five new files; this plan adds `_tz.js` as a sixth. Both `_ics.js` and `_schedule.js` need wall-clock-to-instant conversion, and having either import it from the other would invert a sensible dependency. It is ~40 lines with one job.

`calendar.js` is not touched.

---

### Task 1: Pin the current span arithmetic

Before moving code that feeds payroll, capture exactly what it produces today. `autoCalcTimes` and `getDriveMins` are currently private, so this task exports them unchanged.

**Files:**
- Modify: `netlify/functions/staff-assignments.js` (add exports at the bottom, beside `module.exports.validPayOverride`)
- Test: `test/schedule-span.test.js` (create)

**Interfaces:**
- Produces: `module.exports.autoCalcTimes`, `module.exports.getDriveMins` from `staff-assignments.js`. Task 3 removes both again once `_schedule.js` owns them.

- [ ] **Step 1: Write the failing test**

```js
// test/schedule-span.test.js
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
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/schedule-span.test.js`
Expected: FAIL — `TypeError: getDriveMins is not a function`, because neither symbol is exported yet.

- [ ] **Step 3: Export the two functions, changing nothing else**

At the bottom of `netlify/functions/staff-assignments.js`, beside the existing exports:

```js
// Exported for test/schedule-span.test.js, which pins this arithmetic before
// it moves to _schedule.js. Both exports disappear again once it has.
module.exports.autoCalcTimes = autoCalcTimes;
module.exports.getDriveMins = getDriveMins;
```

- [ ] **Step 4: Run and confirm green**

Run: `node --test test/schedule-span.test.js`
Expected: PASS, 5 tests.

If a pinned number differs from reality, **change the test to match the code, not the code to match the test.** The point is to record today's behaviour.

- [ ] **Step 5: Full suite, then commit**

Run: `npm test` — expect 658 passing, 0 failing.

```bash
git add test/schedule-span.test.js netlify/functions/staff-assignments.js
git commit -m "test(schedule): pin the working-span arithmetic before extracting it

total_minutes feeds payroll's estimate path. Moving this maths without a
pinning test would make a silent regression indistinguishable from a refactor.

The unknown-ZIP fallback of 30 is pinned deliberately: it is wrong, it is
tracked as BUG-1, and it must not change as a side effect of this work.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: `_tz.js` — wall-clock to instant

**Files:**
- Create: `netlify/functions/_tz.js`
- Test: `test/tz.test.js`

**Interfaces:**
- Produces:
  - `zonedToInstant(y, mo, d, h, mi, tz) -> Date` — `mo` is 1-based.
  - `dayBoundsInZone(isoDate, tz) -> { start: Date, end: Date }` — local midnight to next local midnight, so a 23- or 25-hour DST day is still exactly one day.

- [ ] **Step 1: Write the failing test**

```js
// test/tz.test.js
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
  // 8 Mar 2026, 02:00-03:00 Central does not exist. 03:00 does.
  assert.strictEqual(zonedToInstant(2026, 3, 8, 3, 0, TZ).toISOString(), '2026-03-08T09:00:00.000Z');
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
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/tz.test.js`
Expected: FAIL — `Cannot find module '../netlify/functions/_tz.js'`.

- [ ] **Step 3: Implement**

```js
// netlify/functions/_tz.js
//
// Wall-clock time plus an IANA zone -> an absolute instant, with no dependency.
//
// This is the mirror of the note in calendar.js about building dates in UTC and
// formatting them as wall-clock strings. Outbound must AVOID shifting, because
// the ICS carries TZID and the digits are local. Inbound must DELIBERATELY
// shift, exactly once, here at the boundary — after which everything downstream
// is an absolute instant and timezone stops being a consideration.

// What the wall clock reads in `tz` at instant `d`, as a UTC-epoch number.
// Intl gives us the parts; Date.UTC turns them back into a comparable number.
function wallClockAsUTC(d, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(d).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  // Intl renders midnight as hour 24 in some ICU versions.
  const hour = Number(parts.hour) % 24;
  return Date.UTC(+parts.year, +parts.month - 1, +parts.day, hour, +parts.minute, +parts.second);
}

// Two passes settle DST. The first guess is off by the offset; correcting by
// the offset measured AT that guess lands on the right side of a transition in
// every case except the non-existent spring-forward hour, which resolves
// forward — the same thing calendar clients do.
function zonedToInstant(y, mo, d, h, mi, tz) {
  const want = Date.UTC(y, mo - 1, d, h, mi, 0);
  let guess = want;
  for (let i = 0; i < 2; i++) {
    guess = want - (wallClockAsUTC(new Date(guess), tz) - guess);
  }
  return new Date(guess);
}

// Local midnight to the NEXT local midnight. Computed by adding a calendar day
// rather than 24 hours, so the 25-hour fall-back day and the 23-hour
// spring-forward day are both exactly one day.
function dayBoundsInZone(isoDate, tz) {
  const [y, mo, d] = String(isoDate).split('-').map(Number);
  const start = zonedToInstant(y, mo, d, 0, 0, tz);
  const nxt = new Date(Date.UTC(y, mo - 1, d + 1));
  const end = zonedToInstant(nxt.getUTCFullYear(), nxt.getUTCMonth() + 1, nxt.getUTCDate(), 0, 0, tz);
  return { start, end };
}

module.exports = { zonedToInstant, dayBoundsInZone };
```

- [ ] **Step 4: Run and confirm green**

Run: `node --test test/tz.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add netlify/functions/_tz.js test/tz.test.js
git commit -m "feat(tz): wall-clock plus IANA zone to an absolute instant

The mirror of calendar.js's outbound rule. Outbound must avoid shifting
because the ICS carries TZID and the digits are local; inbound shifts once,
here, after which everything downstream is an instant.

Two correction passes settle DST. Day bounds add a calendar day rather than
24 hours, so the 25-hour November day is still one day.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Extract `_schedule.js`

**Files:**
- Create: `netlify/functions/_schedule.js`
- Modify: `netlify/functions/staff-assignments.js` (delete `ZIP_COORDS`, `HOME_ZIP`, `getDriveMins`; rewrite `autoCalcTimes` as a caller; drop the Task 1 exports)
- Test: `test/schedule-span.test.js` (repoint at the new module)

**Interfaces:**
- Consumes: `zonedToInstant` from `_tz.js`.
- Produces:
  - `getDriveMins(destZip) -> { minutes: number, zipKnown: boolean }`
  - `spanFor(client, booking, overrides = {}) -> { startsAt: Date|null, endsAt: Date|null, totalMinutes: number, driveMinutes: number, zipKnown: boolean, windowKnown: boolean, unknowns: string[] }`

`booking` needs `service_id`, `event_date`, `event_time`, `event_zip`. `overrides` accepts the same keys a `staff_assignments` row carries: `load_minutes`, `unload_minutes`, `pack_out_minutes`, `home_unload_minutes`, `drive_minutes_each_way`.

- [ ] **Step 1: Add the new tests, and repoint the pinned ones**

Change the `require` at the top of `test/schedule-span.test.js` to:

```js
const { getDriveMins, spanFor } = require('../netlify/functions/_schedule.js');
const { autoCalcTimes } = require('../netlify/functions/staff-assignments.js');
```

Update the three `getDriveMins` assertions to read the new shape — the numbers are unchanged, which is the point:

```js
test('getDriveMins: a known ZIP gives a haversine estimate at 35mph plus a 15 min stop', () => {
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
```

Then append the new tests — the ones that justify the whole extraction:

```js
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
```

- [ ] **Step 2: Run and watch it fail**

Run: `node --test test/schedule-span.test.js`
Expected: FAIL — `Cannot find module '../netlify/functions/_schedule.js'`.

- [ ] **Step 3: Create `_schedule.js`**

Move `ZIP_COORDS` and `HOME_ZIP` **verbatim** from `staff-assignments.js:59-121` — do not retype the coordinates.

```js
// netlify/functions/_schedule.js
//
// The working span of a gig: when Joe leaves home, and when he is back and
// unloaded. Extracted from autoCalcTimes in staff-assignments.js so it can be
// computed from a BOOKING ALONE, with no staff assignment.
//
// That is the whole reason this file exists. autoCalcTimes only ever ran when
// an assignment was created, so schedule_start is null on every booking nobody
// is staffed to yet — which is exactly the booking you are asking "am I free?"
// about. Reading the persisted column would have returned null and, worse,
// been easy to read as "no conflict".

const { zonedToInstant } = require('./_tz');

const TZ = 'America/Chicago';

const ZIP_COORDS = { /* moved verbatim from staff-assignments.js */ };
const HOME_ZIP = '73118';

// The 30-minute fallback for an unknown ZIP is UNCHANGED and that is
// deliberate: it flows into total_minutes and from there into payroll's
// estimate path. Deciding what payroll should do with an unknown drive is
// BUG-1's job, not this refactor's. zipKnown is the only new thing — it lets a
// caller say "estimated" without altering the number.
function getDriveMins(destZip) {
  const home = ZIP_COORDS[HOME_ZIP];
  const dest = ZIP_COORDS[String(destZip == null ? '' : destZip).substring(0, 5)];
  if (!home || !dest) return { minutes: 30, zipKnown: false };
  const R = 3958.8;
  const dLat = (dest.lat - home.lat) * Math.PI / 180;
  const dLng = (dest.lng - home.lng) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(home.lat*Math.PI/180)*Math.cos(dest.lat*Math.PI/180)*Math.sin(dLng/2)**2;
  const miles = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return { minutes: Math.max(10, Math.round((miles / 35) * 60)) + 15, zipKnown: true };
}

async function spanFor(client, booking, overrides = {}) {
  const { rows: [tmpl] } = await client.query(
    'SELECT * FROM service_time_templates WHERE service_id=$1', [booking.service_id]);
  const { rows: [svc] } = await client.query(
    'SELECT duration_minutes FROM services WHERE service_id=$1', [booking.service_id]);

  const unknowns = [];
  const drive = getDriveMins(booking.event_zip);
  if (!drive.zipKnown) unknowns.push(`drive time estimated — ZIP ${booking.event_zip || '(none)'} is not in the table`);

  const load   = overrides.load_minutes           ?? tmpl?.load_minutes           ?? 30;
  const setup  = overrides.unload_minutes         ?? tmpl?.unload_minutes         ?? 45;
  const pack   = overrides.pack_out_minutes       ?? tmpl?.pack_out_minutes       ?? 20;
  const homeUn = overrides.home_unload_minutes    ?? tmpl?.home_unload_minutes    ?? 15;
  const driveM = overrides.drive_minutes_each_way ?? drive.minutes;
  const party  = svc?.duration_minutes ?? 60;
  if (!svc) unknowns.push('service duration unknown — assumed 60 minutes');

  const totalMinutes = load + driveM + setup + party + pack + driveM + homeUn;
  const leadMinutes = load + driveM + setup;   // home -> on stage

  let startsAt = null, endsAt = null, windowKnown = false;
  const t = String(booking.event_time || '').match(/^(\d{1,2}):(\d{2})/);
  if (!booking.event_date) {
    unknowns.push('no event date on this booking');
  } else if (!t) {
    unknowns.push('no event time on this booking — the working window cannot be computed');
  } else {
    const [Y, Mo, D] = String(booking.event_date).slice(0, 10).split('-').map(Number);
    const eventAt = zonedToInstant(Y, Mo, D, Number(t[1]), Number(t[2]), TZ);
    startsAt = new Date(eventAt.getTime() - leadMinutes * 60000);
    endsAt   = new Date(startsAt.getTime() + totalMinutes * 60000);
    windowKnown = true;
  }

  return { startsAt, endsAt, totalMinutes, driveMinutes: driveM, zipKnown: drive.zipKnown, windowKnown, unknowns };
}

module.exports = { spanFor, getDriveMins, TZ };
```

- [ ] **Step 4: Rewrite `autoCalcTimes` as a caller**

In `staff-assignments.js`: delete `ZIP_COORDS`, `HOME_ZIP` and `getDriveMins`, add `const { spanFor } = require('./_schedule');`, and replace the body of `autoCalcTimes` between fetching the booking and the `UPDATE` with:

```js
    const span = await spanFor(client, b, sa);

    const load   = sa.load_minutes          ?? tmpl?.load_minutes          ?? 30;
    const setup  = sa.unload_minutes        ?? tmpl?.unload_minutes        ?? 45;
    const pack   = sa.pack_out_minutes      ?? tmpl?.pack_out_minutes      ?? 20;
    const homeUn = sa.home_unload_minutes   ?? tmpl?.home_unload_minutes   ?? 15;
    const drive  = span.driveMinutes;
    const total  = span.totalMinutes;

    // schedule_start is a wall-clock "HH:MM" column, so format the instant back
    // into Central rather than reading UTC hours off it.
    const scheduleStart = span.windowKnown
      ? new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Chicago', hour12: false, hour: '2-digit', minute: '2-digit' }).format(span.startsAt)
      : null;
```

Then delete the two exports added in Task 1.

- [ ] **Step 5: Run and confirm green**

Run: `node --test test/schedule-span.test.js`
Expected: PASS, 10 tests. **The five pinned tests must pass unchanged apart from `getDriveMins`' return shape.** If any pinned number moved, the extraction is wrong — fix the code, not the test.

- [ ] **Step 6: Full suite, then commit**

Run: `npm test` — expect 663 passing, 0 failing. Pay attention to `test/staff-portal-multi-role.test.js` and any payroll test: those consume `total_minutes`.

```bash
git add netlify/functions/_schedule.js netlify/functions/staff-assignments.js test/schedule-span.test.js
git commit -m "refactor(schedule): compute the working span from a booking, not an assignment

autoCalcTimes only ran when a staff assignment was created, so schedule_start
is null on any booking nobody is staffed to — exactly the booking you ask
'am I free?' about. spanFor takes a booking row and needs no assignment;
autoCalcTimes becomes a caller passing its own overrides.

The pinned arithmetic is unchanged, including getDriveMins' 30-minute fallback
for an unknown ZIP. That number reaches payroll; it gains a zipKnown flag so
callers can say 'estimated' without moving it. BUG-1 remains its own task.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: `_ics.js` — parsing, without recurrence

**Files:**
- Create: `netlify/functions/_ics.js`
- Test: `test/ics-parse.test.js`

**Interfaces:**
- Consumes: `zonedToInstant`, `dayBoundsInZone` from `_tz.js`.
- Produces: `parseIcs(text, { windowStart, windowEnd, tz }) -> { events: [{ uid, summary, startsAt: Date, endsAt: Date, allDay: boolean }], warnings: string[] }`

Events are returned sorted by `startsAt`. Recurring events yield only their first instance in this task; Task 5 expands them.

- [ ] **Step 1: Write the failing test**

```js
// test/ics-parse.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { parseIcs } = require('../netlify/functions/_ics.js');

const TZ = 'America/Chicago';
const WIN = { windowStart: new Date('2026-01-01T00:00:00Z'), windowEnd: new Date('2027-12-31T00:00:00Z'), tz: TZ };

const cal = (...body) => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...body, 'END:VCALENDAR'].join('\r\n');
const ev = (...lines) => ['BEGIN:VEVENT', ...lines, 'END:VEVENT'];

test('a TZID event resolves to the right instant', () => {
  const { events } = parseIcs(cal(...ev(
    'UID:a@test', 'SUMMARY:Dentist',
    'DTSTART;TZID=America/Chicago:20260912T140000',
    'DTEND;TZID=America/Chicago:20260912T150000',
  )), WIN);
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].summary, 'Dentist');
  assert.strictEqual(events[0].startsAt.toISOString(), '2026-09-12T19:00:00.000Z');
  assert.strictEqual(events[0].endsAt.toISOString(), '2026-09-12T20:00:00.000Z');
  assert.strictEqual(events[0].allDay, false);
});

test('a UTC event is taken as-is', () => {
  const { events } = parseIcs(cal(...ev(
    'UID:b@test', 'SUMMARY:Call', 'DTSTART:20260912T190000Z', 'DTEND:20260912T200000Z',
  )), WIN);
  assert.strictEqual(events[0].startsAt.toISOString(), '2026-09-12T19:00:00.000Z');
});

test('a floating time is read as Central', () => {
  const { events } = parseIcs(cal(...ev(
    'UID:c@test', 'SUMMARY:Floaty', 'DTSTART:20260912T140000', 'DTEND:20260912T150000',
  )), WIN);
  assert.strictEqual(events[0].startsAt.toISOString(), '2026-09-12T19:00:00.000Z');
});

test('an all-day event covers local midnight to local midnight', () => {
  const { events } = parseIcs(cal(...ev(
    'UID:d@test', 'SUMMARY:Trip', 'DTSTART;VALUE=DATE:20261101', 'DTEND;VALUE=DATE:20261102',
  )), WIN);
  assert.strictEqual(events[0].allDay, true);
  // 1 Nov 2026 is the 25-hour fall-back day.
  assert.strictEqual(events[0].startsAt.toISOString(), '2026-11-01T05:00:00.000Z');
  assert.strictEqual(events[0].endsAt.toISOString(),   '2026-11-02T06:00:00.000Z');
});

test('DURATION is honoured when DTEND is absent', () => {
  const { events } = parseIcs(cal(...ev(
    'UID:e@test', 'SUMMARY:Short', 'DTSTART:20260912T190000Z', 'DURATION:PT90M',
  )), WIN);
  assert.strictEqual(events[0].endsAt.toISOString(), '2026-09-12T20:30:00.000Z');
});

test('a timed event with neither DTEND nor DURATION is treated as zero-length', () => {
  const { events } = parseIcs(cal(...ev(
    'UID:f@test', 'SUMMARY:Point', 'DTSTART:20260912T190000Z',
  )), WIN);
  assert.strictEqual(events[0].endsAt.getTime(), events[0].startsAt.getTime());
});

test('folded continuation lines are rejoined', () => {
  const { events } = parseIcs(cal(...ev(
    'UID:g@test',
    'SUMMARY:A very long summary that the calendar server has wrapped acro',
    ' ss two lines',
    'DTSTART:20260912T190000Z', 'DTEND:20260912T200000Z',
  )), WIN);
  assert.strictEqual(events[0].summary, 'A very long summary that the calendar server has wrapped across two lines');
});

test('escaped characters in SUMMARY are unescaped', () => {
  const { events } = parseIcs(cal(...ev(
    'UID:h@test', 'SUMMARY:Lunch\\, then gym\\; maybe', 'DTSTART:20260912T190000Z', 'DTEND:20260912T200000Z',
  )), WIN);
  assert.strictEqual(events[0].summary, 'Lunch, then gym; maybe');
});

test('a CANCELLED event is not busy', () => {
  const { events } = parseIcs(cal(...ev(
    'UID:i@test', 'SUMMARY:Off', 'STATUS:CANCELLED', 'DTSTART:20260912T190000Z', 'DTEND:20260912T200000Z',
  )), WIN);
  assert.strictEqual(events.length, 0);
});

test('a TRANSPARENT event is not busy — that is what Google Free means', () => {
  const { events } = parseIcs(cal(...ev(
    'UID:j@test', 'SUMMARY:FYI', 'TRANSP:TRANSPARENT', 'DTSTART:20260912T190000Z', 'DTEND:20260912T200000Z',
  )), WIN);
  assert.strictEqual(events.length, 0);
});

test('events outside the window are dropped', () => {
  const { events } = parseIcs(cal(...ev(
    'UID:k@test', 'SUMMARY:Ancient', 'DTSTART:20200912T190000Z', 'DTEND:20200912T200000Z',
  )), WIN);
  assert.strictEqual(events.length, 0);
});

test('an event with no DTSTART is skipped and warned about, never silently dropped', () => {
  const { events, warnings } = parseIcs(cal(...ev('UID:l@test', 'SUMMARY:Broken')), WIN);
  assert.strictEqual(events.length, 0);
  assert.strictEqual(warnings.length, 1);
  assert.match(warnings[0], /Broken/);
});

test('results are sorted by start', () => {
  const { events } = parseIcs(cal(
    ...ev('UID:m@test', 'SUMMARY:Later',  'DTSTART:20260912T200000Z', 'DTEND:20260912T210000Z'),
    ...ev('UID:n@test', 'SUMMARY:Sooner', 'DTSTART:20260912T180000Z', 'DTEND:20260912T190000Z'),
  ), WIN);
  assert.deepStrictEqual(events.map(e => e.summary), ['Sooner', 'Later']);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/ics-parse.test.js`
Expected: FAIL — `Cannot find module '../netlify/functions/_ics.js'`.

- [ ] **Step 3: Implement**

```js
// netlify/functions/_ics.js
//
// A parser for the ICS feeds Joe subscribes to. Pure: a string in, busy periods
// out, no I/O and no database.
//
// The escaping and folding rules here are the inverse of esc() and fold() in
// calendar.js. RFC 5545 is unforgiving in both directions — a feed that is
// mis-unfolded produces silently wrong summaries rather than an error.
//
// Everything this file cannot understand becomes a WARNING, never a silent
// omission. A dropped event is a gig double-booked.

const { zonedToInstant, dayBoundsInZone } = require('./_tz');

// Continuation lines begin with a space or tab and belong to the line above.
function unfold(text) {
  return String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n[ \t]/g, '').split('\n');
}

function unescapeText(v) {
  return String(v).replace(/\\n/gi, '\n').replace(/\\([;,\\])/g, '$1');
}

// "DTSTART;TZID=America/Chicago:20260912T140000" -> name, params, value
function parseLine(line) {
  const colon = line.indexOf(':');
  if (colon === -1) return null;
  const left = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const [name, ...paramParts] = left.split(';');
  const params = {};
  for (const p of paramParts) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name: name.toUpperCase(), params, value };
}

// The three forms a date-time arrives in, plus VALUE=DATE.
function toInstant({ params, value }, tz) {
  if (params.VALUE === 'DATE' || /^\d{8}$/.test(value)) {
    const iso = `${value.slice(0,4)}-${value.slice(4,6)}-${value.slice(6,8)}`;
    return { at: dayBoundsInZone(iso, tz).start, allDay: true, isoDate: iso };
  }
  const m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
  if (!m) return null;
  const [, Y, Mo, D, h, mi, s, z] = m;
  if (z) return { at: new Date(Date.UTC(+Y, +Mo - 1, +D, +h, +mi, +s)), allDay: false };
  // No Z: either TZID-qualified or floating. Floating is read as the local zone,
  // which is what every calendar client does.
  return { at: zonedToInstant(+Y, +Mo, +D, +h, +mi, params.TZID || tz), allDay: false };
}

// PT90M, PT1H30M, P1D — enough of ISO 8601 for calendar durations.
function durationMs(v) {
  const m = String(v).match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return null;
  return ((+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0)) * 1000;
}

function parseIcs(text, { windowStart, windowEnd, tz }) {
  const lines = unfold(text);
  const events = [];
  const warnings = [];
  let cur = null;

  for (const raw of lines) {
    if (/^BEGIN:VEVENT\s*$/i.test(raw)) { cur = { props: {} }; continue; }
    if (/^END:VEVENT\s*$/i.test(raw)) {
      if (cur) finishEvent(cur, { windowStart, windowEnd, tz }, events, warnings);
      cur = null; continue;
    }
    if (!cur) continue;
    const p = parseLine(raw);
    if (!p) continue;
    if (p.name === 'EXDATE') (cur.props.EXDATE ||= []).push(p);
    else cur.props[p.name] = p;
  }

  events.sort((a, b) => a.startsAt - b.startsAt);
  return { events, warnings };
}

function finishEvent(cur, opts, events, warnings) {
  const p = cur.props;
  const summary = p.SUMMARY ? unescapeText(p.SUMMARY.value) : '(no title)';
  const uid = p.UID ? p.UID.value : null;

  if (p.STATUS && /CANCELLED/i.test(p.STATUS.value)) return;
  if (p.TRANSP && /TRANSPARENT/i.test(p.TRANSP.value)) return;

  if (!p.DTSTART) { warnings.push(`"${summary}" has no start time and was skipped`); return; }
  const start = toInstant(p.DTSTART, opts.tz);
  if (!start) { warnings.push(`"${summary}" has an unreadable start time and was skipped`); return; }

  let end;
  if (p.DTEND) {
    const e = toInstant(p.DTEND, opts.tz);
    // DTEND on an all-day event is exclusive: DTEND 20261102 means the event
    // ends at the START of 2 Nov, which is the end of 1 Nov.
    end = e ? e.at : null;
  } else if (p.DURATION) {
    const ms = durationMs(p.DURATION.value);
    end = ms == null ? null : new Date(start.at.getTime() + ms);
  }
  if (!end) end = new Date(start.at.getTime());

  // Task 5 replaces this with expansion.
  pushIfInWindow(events, { uid, summary, startsAt: start.at, endsAt: end, allDay: start.allDay }, opts);
}

function pushIfInWindow(events, e, { windowStart, windowEnd }) {
  if (e.endsAt <= windowStart || e.startsAt >= windowEnd) return;
  events.push(e);
}

module.exports = { parseIcs, unfold, parseLine, toInstant, durationMs, unescapeText };
```

- [ ] **Step 4: Run and confirm green**

Run: `node --test test/ics-parse.test.js`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add netlify/functions/_ics.js test/ics-parse.test.js
git commit -m "feat(ics): parse VEVENTs into absolute busy periods

The inverse of calendar.js's esc() and fold(). Handles the four DTSTART forms
(VALUE=DATE, Z-suffixed UTC, TZID-qualified, floating), DURATION when DTEND is
absent, and the exclusive end of an all-day DTEND.

CANCELLED and TRANSPARENT events are not busy — the second is what Google sets
for 'Free', which makes it a way to tell the CRM to ignore an entry without
deleting it.

Anything unparseable becomes a warning. A silently dropped event is a gig
double-booked.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: `_ics.js` — recurrence

**Files:**
- Modify: `netlify/functions/_ics.js`
- Test: `test/ics-parse.test.js` (append)

**Interfaces:**
- Produces: no signature change. `parseIcs` now returns one entry per occurrence within the window, and pushes a warning naming any rule it could not expand.

Supported: `FREQ` = `DAILY|WEEKLY|MONTHLY|YEARLY`, `INTERVAL`, `COUNT`, `UNTIL`, `BYDAY`, and `EXDATE`. Anything else yields the first instance plus a warning.

- [ ] **Step 1: Write the failing tests**

```js
test('a weekly rule expands across the window', () => {
  const { events } = parseIcs(cal(...ev(
    'UID:r1@test', 'SUMMARY:School run',
    'DTSTART;TZID=America/Chicago:20260907T150000',
    'DTEND;TZID=America/Chicago:20260907T160000',
    'RRULE:FREQ=WEEKLY;COUNT=4',
  )), WIN);
  assert.strictEqual(events.length, 4);
  assert.deepStrictEqual(
    events.map(e => e.startsAt.toISOString().slice(0, 10)),
    ['2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28']
  );
});

test('UNTIL terminates the series', () => {
  const { events } = parseIcs(cal(...ev(
    'UID:r2@test', 'SUMMARY:Standup',
    'DTSTART:20260907T140000Z', 'DTEND:20260907T143000Z',
    'RRULE:FREQ=DAILY;UNTIL=20260910T000000Z',
  )), WIN);
  assert.strictEqual(events.length, 3); // 7th, 8th, 9th
});

test('INTERVAL is honoured', () => {
  const { events } = parseIcs(cal(...ev(
    'UID:r3@test', 'SUMMARY:Fortnightly',
    'DTSTART:20260907T140000Z', 'DTEND:20260907T150000Z',
    'RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=3',
  )), WIN);
  assert.deepStrictEqual(
    events.map(e => e.startsAt.toISOString().slice(0, 10)),
    ['2026-09-07', '2026-09-21', '2026-10-05']
  );
});

test('BYDAY generates several days per week', () => {
  const { events } = parseIcs(cal(...ev(
    'UID:r4@test', 'SUMMARY:MWF',
    'DTSTART;TZID=America/Chicago:20260907T090000',
    'DTEND;TZID=America/Chicago:20260907T100000',
    'RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=3',
  )), WIN);
  assert.deepStrictEqual(
    events.map(e => e.startsAt.toISOString().slice(0, 10)),
    ['2026-09-07', '2026-09-09', '2026-09-11']
  );
});

test('EXDATE removes an occurrence', () => {
  const { events } = parseIcs(cal(...ev(
    'UID:r5@test', 'SUMMARY:Weekly',
    'DTSTART;TZID=America/Chicago:20260907T150000',
    'DTEND;TZID=America/Chicago:20260907T160000',
    'RRULE:FREQ=WEEKLY;COUNT=3',
    'EXDATE;TZID=America/Chicago:20260914T150000',
  )), WIN);
  assert.deepStrictEqual(
    events.map(e => e.startsAt.toISOString().slice(0, 10)),
    ['2026-09-07', '2026-09-21']
  );
});

test('a MONTHLY rule steps by calendar month', () => {
  const { events } = parseIcs(cal(...ev(
    'UID:r6@test', 'SUMMARY:Monthly',
    'DTSTART:20260115T140000Z', 'DTEND:20260115T150000Z',
    'RRULE:FREQ=MONTHLY;COUNT=3',
  )), WIN);
  assert.deepStrictEqual(
    events.map(e => e.startsAt.toISOString().slice(0, 10)),
    ['2026-01-15', '2026-02-15', '2026-03-15']
  );
});

test('an unsupported rule keeps the first instance AND warns — never silence', () => {
  const { events, warnings } = parseIcs(cal(...ev(
    'UID:r7@test', 'SUMMARY:Third Thursday',
    'DTSTART:20260115T140000Z', 'DTEND:20260115T150000Z',
    'RRULE:FREQ=MONTHLY;BYSETPOS=3;BYDAY=TH',
  )), WIN);
  assert.strictEqual(events.length, 1, 'the first instance is still busy');
  assert.strictEqual(warnings.length, 1);
  assert.match(warnings[0], /Third Thursday/);
  assert.match(warnings[0], /BYSETPOS/);
});

test('expansion stops at the window end rather than running forever', () => {
  const { events } = parseIcs(cal(...ev(
    'UID:r8@test', 'SUMMARY:Endless',
    'DTSTART:20260101T140000Z', 'DTEND:20260101T150000Z',
    'RRULE:FREQ=DAILY',
  )), { windowStart: new Date('2026-01-01T00:00:00Z'), windowEnd: new Date('2026-01-11T00:00:00Z'), tz: TZ });
  assert.strictEqual(events.length, 10);
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `node --test test/ics-parse.test.js`
Expected: FAIL — the weekly rule returns 1 event, not 4.

- [ ] **Step 3: Implement expansion**

Add to `_ics.js`:

```js
const DAY_CODES = { SU:0, MO:1, TU:2, WE:3, TH:4, FR:5, SA:6 };
const SUPPORTED_RRULE_PARTS = new Set(['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'BYDAY', 'WKST']);
const MAX_OCCURRENCES = 1000;   // a hard stop, independent of the window

function parseRrule(value) {
  const parts = {};
  for (const bit of String(value).split(';')) {
    const eq = bit.indexOf('=');
    if (eq > 0) parts[bit.slice(0, eq).toUpperCase()] = bit.slice(eq + 1);
  }
  const unsupported = Object.keys(parts).filter(k => !SUPPORTED_RRULE_PARTS.has(k));
  return { parts, unsupported };
}

// Occurrence starts, as instants. BYDAY only applies to WEEKLY here; on any
// other FREQ it is part of a pattern we do not support, and parseRrule has
// already flagged it.
function expandRrule(startAt, parts, windowEnd, tz) {
  const freq = String(parts.FREQ || '').toUpperCase();
  const interval = Math.max(1, Number(parts.INTERVAL || 1));
  const count = parts.COUNT ? Number(parts.COUNT) : null;
  const until = parts.UNTIL ? toInstant({ params: {}, value: parts.UNTIL }, tz)?.at : null;
  const hardEnd = until && until < windowEnd ? until : windowEnd;

  const byDay = (freq === 'WEEKLY' && parts.BYDAY)
    ? String(parts.BYDAY).split(',').map(d => DAY_CODES[d.trim().toUpperCase()]).filter(n => n != null)
    : null;

  const out = [];
  const push = (d) => { if (d <= hardEnd) out.push(new Date(d)); };

  // Anchor on the wall clock so DST does not drift a 3pm event to 2pm.
  const wall = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(startAt).reduce((a, p) => (a[p.type] = p.value, a), {});
  const H = Number(wall.hour) % 24, Mi = Number(wall.minute);
  let cursor = new Date(Date.UTC(+wall.year, +wall.month - 1, +wall.day));

  for (let n = 0; out.length < (count ?? MAX_OCCURRENCES) && n < MAX_OCCURRENCES; n++) {
    if (freq === 'WEEKLY' && byDay) {
      const weekStart = new Date(cursor);
      weekStart.setUTCDate(weekStart.getUTCDate() - weekStart.getUTCDay());
      for (const dow of byDay.slice().sort((a, b) => a - b)) {
        const d = new Date(weekStart);
        d.setUTCDate(d.getUTCDate() + dow);
        const at = zonedToInstant(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), H, Mi, tz);
        if (at >= startAt && (count == null || out.length < count)) push(at);
      }
    } else {
      const at = zonedToInstant(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, cursor.getUTCDate(), H, Mi, tz);
      push(at);
    }
    if (out.length && out[out.length - 1] >= hardEnd) break;

    if (freq === 'DAILY')        cursor.setUTCDate(cursor.getUTCDate() + interval);
    else if (freq === 'WEEKLY')  cursor.setUTCDate(cursor.getUTCDate() + 7 * interval);
    else if (freq === 'MONTHLY') cursor.setUTCMonth(cursor.getUTCMonth() + interval);
    else if (freq === 'YEARLY')  cursor.setUTCFullYear(cursor.getUTCFullYear() + interval);
    else break;
  }

  return out.filter(d => d <= hardEnd).slice(0, count ?? undefined);
}
```

Replace the last two lines of `finishEvent` with:

```js
  const durMs = end.getTime() - start.at.getTime();
  const base = { uid, summary, allDay: start.allDay };

  if (!p.RRULE) {
    pushIfInWindow(events, { ...base, startsAt: start.at, endsAt: end }, opts);
    return;
  }

  const { parts, unsupported } = parseRrule(p.RRULE.value);
  if (unsupported.length) {
    // The first instance is still real, so it is still busy. But an unexpanded
    // rule is a standing commitment the CRM cannot see, and that has to be said
    // out loud — it ends up in the conflict panel, not in a log.
    warnings.push(`the recurring event "${summary}" uses ${unsupported.join(', ')}, which cannot be expanded — only its first occurrence is known`);
    pushIfInWindow(events, { ...base, startsAt: start.at, endsAt: end }, opts);
    return;
  }

  const exdates = new Set();
  for (const x of (p.EXDATE || [])) {
    for (const v of String(x.value).split(',')) {
      const inst = toInstant({ params: x.params, value: v.trim() }, opts.tz);
      if (inst) exdates.add(inst.at.getTime());
    }
  }

  for (const at of expandRrule(start.at, parts, opts.windowEnd, opts.tz)) {
    if (exdates.has(at.getTime())) continue;
    pushIfInWindow(events, { ...base, startsAt: at, endsAt: new Date(at.getTime() + durMs) }, opts);
  }
```

Add `parseRrule` and `expandRrule` to `module.exports`.

- [ ] **Step 4: Run and confirm green**

Run: `node --test test/ics-parse.test.js`
Expected: PASS, 21 tests.

- [ ] **Step 5: Full suite, then commit**

Run: `npm test`

```bash
git add netlify/functions/_ics.js test/ics-parse.test.js
git commit -m "feat(ics): expand recurring events over the cache window

Supports FREQ daily/weekly/monthly/yearly, INTERVAL, COUNT, UNTIL, BYDAY and
EXDATE — which covers what a personal calendar actually contains. Occurrences
are anchored on the wall clock so a 3pm weekly event stays at 3pm across a DST
boundary rather than drifting an hour.

A rule using anything else keeps its first occurrence and raises a named
warning that surfaces in the conflict panel. Under-reporting loudly is
survivable; under-reporting silently is the bug that double-books a Saturday.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Schema and the feeds endpoint

**Files:**
- Create: `netlify/functions/calendar-feeds.js`
- Modify: `netlify.toml` (redirect only; the schedule comes in Task 7)
- Test: `test/calendar-feeds.test.js`

**Interfaces:**
- Produces:
  - `ensureCalendarTables(client) -> Promise<void>`
  - `maskUrl(url) -> string`
  - `listFeeds(client) -> Promise<Array<{ id, label, url_masked, active, last_synced_at, last_status, last_error, last_event_count, last_warnings }>>`
  - `exports.handler` — `GET /api/calendar-feeds`, `POST` `{action:'save'|'delete'|'refresh', ...}`

- [ ] **Step 1: Write the failing test**

```js
// test/calendar-feeds.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { maskUrl, listFeeds, ensureCalendarTables } = require('../netlify/functions/calendar-feeds.js');

test('maskUrl keeps enough to recognise a feed and hides the secret', () => {
  const u = 'https://calendar.google.com/calendar/ical/abc123secrettoken/private-9f8e7d6c/basic.ics';
  const m = maskUrl(u);
  assert.match(m, /^https:\/\/calendar\.google\.com\//);
  assert.match(m, /basic\.ics$/);
  assert.ok(!m.includes('abc123secrettoken'), 'the token must not survive masking');
  assert.ok(!m.includes('private-9f8e7d6c'), 'the private path must not survive masking');
});

test('maskUrl does not throw on junk', () => {
  assert.strictEqual(typeof maskUrl('not a url'), 'string');
  assert.strictEqual(typeof maskUrl(''), 'string');
  assert.strictEqual(typeof maskUrl(null), 'string');
});

test('listFeeds never returns the raw url — the URL is the credential', async () => {
  const c = { query: async () => ({ rows: [{
    id: 1, label: 'Personal',
    url: 'https://calendar.google.com/calendar/ical/SECRET/private-TOKEN/basic.ics',
    active: true, last_synced_at: null, last_status: null, last_error: null,
    last_event_count: null, last_warnings: [],
  }] }) };

  const feeds = await listFeeds(c);
  const blob = JSON.stringify(feeds);
  assert.ok(!blob.includes('SECRET'), 'raw url leaked out of listFeeds');
  assert.ok(!blob.includes('private-TOKEN'), 'raw url leaked out of listFeeds');
  assert.strictEqual(feeds[0].url, undefined, 'there must be no url property at all');
  assert.ok(feeds[0].url_masked, 'a masked form must be provided for display');
});

test('ensureCalendarTables creates both tables and the range index', async () => {
  const sqls = [];
  const c = { query: async (sql) => { sqls.push(sql); return { rows: [] }; } };
  await ensureCalendarTables(c);
  const all = sqls.join('\n');
  assert.match(all, /CREATE TABLE IF NOT EXISTS calendar_feeds/i);
  assert.match(all, /CREATE TABLE IF NOT EXISTS external_busy/i);
  assert.match(all, /idx_busy_range/i);
  assert.match(all, /ON DELETE CASCADE/i, 'deleting a feed must take its busy rows with it');
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `node --test test/calendar-feeds.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```js
// netlify/functions/calendar-feeds.js
//
// Admin CRUD for subscribed calendars, plus the "refresh now" action.
//
// The feed URL IS the credential — anyone holding a Google secret-ICS address
// can read that calendar indefinitely. So it is write-only from the API's point
// of view: it goes in, it never comes back out, and the only edit is replace.

const { withClient } = require('./_db');
const { CORS, preflight, requireAuth, unauthorized } = require('./_auth');

const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

async function ensureCalendarTables(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS calendar_feeds (
      id               SERIAL PRIMARY KEY,
      label            TEXT NOT NULL,
      url              TEXT NOT NULL,
      active           BOOLEAN NOT NULL DEFAULT TRUE,
      last_synced_at   TIMESTAMPTZ,
      last_status      TEXT,
      last_error       TEXT,
      last_event_count INTEGER,
      last_warnings    JSONB NOT NULL DEFAULT '[]',
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS external_busy (
      id         SERIAL PRIMARY KEY,
      feed_id    INTEGER NOT NULL REFERENCES calendar_feeds(id) ON DELETE CASCADE,
      starts_at  TIMESTAMPTZ NOT NULL,
      ends_at    TIMESTAMPTZ NOT NULL,
      all_day    BOOLEAN NOT NULL DEFAULT FALSE,
      summary    TEXT,
      uid        TEXT,
      synced_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await client.query('CREATE INDEX IF NOT EXISTS idx_busy_range ON external_busy (starts_at, ends_at)');
}

// Host and filename only. Everything between them is secret in every provider's
// scheme, so none of it survives.
function maskUrl(url) {
  const s = String(url || '');
  try {
    const u = new URL(s);
    const last = u.pathname.split('/').filter(Boolean).pop() || '';
    return `${u.protocol}//${u.host}/…/${last}`;
  } catch {
    return s ? '…' : '';
  }
}

const FEED_COLUMNS = 'id, label, url, active, last_synced_at, last_status, last_error, last_event_count, last_warnings';

async function listFeeds(client) {
  const { rows } = await client.query(`SELECT ${FEED_COLUMNS} FROM calendar_feeds ORDER BY id`);
  // Destructure the url away rather than deleting it, so a future column
  // addition cannot reintroduce it by accident.
  return rows.map(({ url, ...rest }) => ({ ...rest, url_masked: maskUrl(url) }));
}

exports.handler = async (event) => {
  const pre = preflight(event); if (pre) return pre;
  const auth = await requireAuth(event, ['admin']); if (!auth) return unauthorized();

  try {
    return await withClient(async (client) => {
      await ensureCalendarTables(client);

      if (event.httpMethod === 'GET') {
        return json(200, { feeds: await listFeeds(client) });
      }

      if (event.httpMethod === 'POST') {
        let body; try { body = JSON.parse(event.body || '{}'); }
        catch { return json(400, { error: 'Invalid JSON' }); }

        if (body.action === 'save') {
          const label = String(body.label || '').trim();
          const url = String(body.url || '').trim();
          if (!label) return json(400, { error: 'A label is required.' });
          if (!/^https?:\/\//i.test(url)) return json(400, { error: 'The calendar address must be a http(s) URL.' });
          if (body.id) {
            await client.query('UPDATE calendar_feeds SET label=$1, url=$2 WHERE id=$3', [label, url, body.id]);
          } else {
            await client.query('INSERT INTO calendar_feeds (label, url) VALUES ($1,$2)', [label, url]);
          }
          return json(200, { feeds: await listFeeds(client) });
        }

        if (body.action === 'delete') {
          if (!body.id) return json(400, { error: 'Which feed?' });
          await client.query('DELETE FROM calendar_feeds WHERE id=$1', [body.id]);
          return json(200, { feeds: await listFeeds(client) });
        }

        if (body.action === 'refresh') {
          const { syncAllFeeds } = require('./calendar-sync');
          const result = await syncAllFeeds(client, new Date());
          return json(200, { feeds: await listFeeds(client), result });
        }

        return json(400, { error: `Unknown action "${body.action}".` });
      }

      return json(405, { error: 'Method not allowed' });
    });
  } catch (e) {
    console.error('calendar-feeds error:', e.message);
    return json(500, { error: 'Calendar feeds are unavailable right now.' });
  }
};

module.exports.ensureCalendarTables = ensureCalendarTables;
module.exports.maskUrl = maskUrl;
module.exports.listFeeds = listFeeds;
```

Add to `netlify.toml`, beside the existing calendar redirects:

```toml
[[redirects]]
  from = "/api/calendar-feeds"
  to = "/.netlify/functions/calendar-feeds"
  status = 200
```

- [ ] **Step 4: Run and confirm green**

Run: `node --test test/calendar-feeds.test.js`
Expected: PASS, 4 tests. (`syncAllFeeds` is required lazily inside the refresh branch, so this task does not need Task 7 to exist.)

- [ ] **Step 5: Commit**

```bash
git add netlify/functions/calendar-feeds.js test/calendar-feeds.test.js netlify.toml
git commit -m "feat(calendar): subscribed-feed storage and admin CRUD

The feed URL is the credential: a Google secret-ICS address grants permanent
read access. It is therefore write-only across the API — listFeeds destructures
it away rather than deleting it, so a later column addition cannot reintroduce
the leak, and a test asserts the raw token never appears in the response.

last_status, last_error and last_warnings exist so a rotated URL reads as a
broken feed rather than as an empty calendar reporting you free.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: `calendar-sync.js`

**Files:**
- Create: `netlify/functions/calendar-sync.js`
- Modify: `netlify.toml` (schedule)
- Test: `test/calendar-sync.test.js`

**Interfaces:**
- Consumes: `parseIcs` from `_ics.js`, `ensureCalendarTables` from `calendar-feeds.js`.
- Produces:
  - `windowFor(now) -> { windowStart: Date, windowEnd: Date }`
  - `syncFeed(client, feed, now, fetchImpl) -> { ok: boolean, count: number, warnings: string[], error: string|null }`
  - `syncAllFeeds(client, now, fetchImpl) -> { synced: number, failed: number }`
  - `exports.handler` — the scheduled entry point.

`fetchImpl` defaults to global `fetch`; tests inject a stub.

- [ ] **Step 1: Write the failing test**

```js
// test/calendar-sync.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { windowFor, syncFeed } = require('../netlify/functions/calendar-sync.js');

const ICS = [
  'BEGIN:VCALENDAR', 'VERSION:2.0',
  'BEGIN:VEVENT', 'UID:x@test', 'SUMMARY:Dentist',
  'DTSTART;TZID=America/Chicago:20260912T140000',
  'DTEND;TZID=America/Chicago:20260912T150000',
  'END:VEVENT', 'END:VCALENDAR',
].join('\r\n');

const okFetch = async () => ({ ok: true, status: 200, text: async () => ICS });

function recordingClient() {
  const sqls = [];
  return { sqls, query: async (sql, params) => { sqls.push({ sql, params }); return { rows: [] }; } };
}

test('the window runs from a week back to eighteen months out', () => {
  const { windowStart, windowEnd } = windowFor(new Date('2026-08-27T12:00:00Z'));
  assert.strictEqual(windowStart.toISOString().slice(0, 10), '2026-08-20');
  assert.strictEqual(windowEnd.toISOString().slice(0, 10), '2028-02-27');
});

test('a good sync replaces the feed rows inside a transaction', async () => {
  const c = recordingClient();
  const r = await syncFeed(c, { id: 7, label: 'Personal', url: 'https://x/ics' }, new Date('2026-08-27T12:00:00Z'), okFetch);

  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.count, 1);

  const text = c.sqls.map(s => s.sql).join('\n');
  assert.match(text, /BEGIN/);
  assert.match(text, /DELETE FROM external_busy WHERE feed_id/i);
  assert.match(text, /INSERT INTO external_busy/i);
  assert.match(text, /COMMIT/);
  assert.ok(c.sqls.findIndex(s => /DELETE FROM external_busy/i.test(s.sql)) >
            c.sqls.findIndex(s => /BEGIN/.test(s.sql)), 'the delete must be inside the transaction');
});

test('a failing fetch records the error and DELETES NOTHING', async () => {
  const c = recordingClient();
  const boom = async () => { throw new Error('getaddrinfo ENOTFOUND'); };
  const r = await syncFeed(c, { id: 7, label: 'Personal', url: 'https://x/ics' }, new Date(), boom);

  assert.strictEqual(r.ok, false);
  assert.match(r.error, /ENOTFOUND/);

  const text = c.sqls.map(s => s.sql).join('\n');
  assert.ok(!/DELETE FROM external_busy/i.test(text),
    'stale busy rows must survive a failed sync — an empty calendar reporting you free is the failure this design exists to prevent');
  assert.match(text, /UPDATE calendar_feeds SET[\s\S]*last_status/i);
  const upd = c.sqls.find(s => /UPDATE calendar_feeds/i.test(s.sql));
  assert.ok(upd.params.includes('error'));
});

test('a non-200 response is an error, not an empty calendar', async () => {
  const c = recordingClient();
  const notFound = async () => ({ ok: false, status: 404, text: async () => 'Not Found' });
  const r = await syncFeed(c, { id: 7, label: 'Personal', url: 'https://x/ics' }, new Date(), notFound);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /404/);
  assert.ok(!c.sqls.some(s => /DELETE FROM external_busy/i.test(s.sql)));
});

test('an oversized feed is refused rather than parsed', async () => {
  const c = recordingClient();
  const huge = async () => ({ ok: true, status: 200, text: async () => 'x'.repeat(5 * 1024 * 1024 + 1) });
  const r = await syncFeed(c, { id: 7, label: 'Personal', url: 'https://x/ics' }, new Date(), huge);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /too large/i);
});

test('parser warnings are persisted so they can reach the conflict panel', async () => {
  const c = recordingClient();
  const withRule = async () => ({ ok: true, status: 200, text: async () => [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT', 'UID:y@test', 'SUMMARY:Third Thursday',
    'DTSTART:20260115T140000Z', 'DTEND:20260115T150000Z',
    'RRULE:FREQ=MONTHLY;BYSETPOS=3;BYDAY=TH',
    'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n') });

  const r = await syncFeed(c, { id: 7, label: 'Personal', url: 'https://x/ics' }, new Date('2026-01-01T00:00:00Z'), withRule);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.warnings.length, 1);
  const upd = c.sqls.find(s => /UPDATE calendar_feeds/i.test(s.sql));
  assert.match(JSON.stringify(upd.params), /Third Thursday/);
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `node --test test/calendar-sync.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```js
// netlify/functions/calendar-sync.js
//
// Pulls every active feed once an hour into external_busy.
//
// One rule governs the error handling here: a feed that fails keeps the rows it
// already had. Deleting first and refetching second would turn a transient 500
// at Google into an empty calendar, and an empty calendar says "you are free"
// with total confidence. Stale data is wrong by hours; an empty table is wrong
// by an entire booked Saturday.

const { withClient } = require('./_db');
const { parseIcs } = require('./_ics');
const { ensureCalendarTables } = require('./calendar-feeds');

const TZ = 'America/Chicago';
const MAX_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10000;

function windowFor(now) {
  const windowStart = new Date(now.getTime() - 7 * 86400000);
  const windowEnd = new Date(now.getTime());
  windowEnd.setUTCMonth(windowEnd.getUTCMonth() + 18);
  return { windowStart, windowEnd };
}

async function syncFeed(client, feed, now, fetchImpl = fetch) {
  const { windowStart, windowEnd } = windowFor(now);
  let events = [], warnings = [], error = null;

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    let text;
    try {
      const res = await fetchImpl(feed.url, { signal: ctrl.signal, redirect: 'follow' });
      if (!res.ok) throw new Error(`feed returned HTTP ${res.status}`);
      text = await res.text();
    } finally { clearTimeout(timer); }

    if (text.length > MAX_BYTES) throw new Error(`feed is too large (${text.length} bytes)`);

    const parsed = parseIcs(text, { windowStart, windowEnd, tz: TZ });
    events = parsed.events;
    warnings = parsed.warnings;
  } catch (e) {
    error = e.name === 'AbortError' ? `feed timed out after ${FETCH_TIMEOUT_MS}ms` : e.message;
  }

  if (error) {
    // Deliberately no DELETE. See the header.
    await client.query(
      `UPDATE calendar_feeds SET last_status=$1, last_error=$2, last_synced_at=NOW() WHERE id=$3`,
      ['error', error, feed.id]
    );
    return { ok: false, count: 0, warnings: [], error };
  }

  await client.query('BEGIN');
  try {
    await client.query('DELETE FROM external_busy WHERE feed_id=$1', [feed.id]);
    for (const e of events) {
      await client.query(
        `INSERT INTO external_busy (feed_id, starts_at, ends_at, all_day, summary, uid)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [feed.id, e.startsAt.toISOString(), e.endsAt.toISOString(), e.allDay, e.summary, e.uid]
      );
    }
    await client.query(
      `UPDATE calendar_feeds
          SET last_status=$1, last_error=NULL, last_event_count=$2, last_warnings=$3::jsonb, last_synced_at=NOW()
        WHERE id=$4`,
      ['ok', events.length, JSON.stringify(warnings), feed.id]
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    await client.query(
      `UPDATE calendar_feeds SET last_status=$1, last_error=$2, last_synced_at=NOW() WHERE id=$3`,
      ['error', `write failed: ${e.message}`, feed.id]
    );
    return { ok: false, count: 0, warnings: [], error: e.message };
  }

  return { ok: true, count: events.length, warnings, error: null };
}

async function syncAllFeeds(client, now = new Date(), fetchImpl = fetch) {
  await ensureCalendarTables(client);
  const { rows: feeds } = await client.query(
    'SELECT id, label, url FROM calendar_feeds WHERE active = TRUE ORDER BY id');
  let synced = 0, failed = 0;
  for (const feed of feeds) {
    // Feeds are independent: one bad URL must not stop the rest.
    const r = await syncFeed(client, feed, now, fetchImpl);
    if (r.ok) synced++; else { failed++; console.error(`calendar-sync: feed ${feed.id} (${feed.label}) failed — ${r.error}`); }
  }
  console.log(`calendar-sync: ${synced} feed(s) synced, ${failed} failed`);
  return { synced, failed };
}

exports.handler = async () => {
  try {
    const result = await withClient((client) => syncAllFeeds(client, new Date()));
    return { statusCode: 200, body: JSON.stringify(result) };
  } catch (e) {
    console.error('calendar-sync FAILED:', e.message);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};

module.exports.windowFor = windowFor;
module.exports.syncFeed = syncFeed;
module.exports.syncAllFeeds = syncAllFeeds;
```

Add to `netlify.toml`, beside the other scheduled functions:

```toml
# Inbound calendar pull. Hourly at :17 rather than on the hour, so it is not
# queueing behind every other cron on the platform. Staleness between runs is
# covered by the Refresh Now button in settings.
[functions."calendar-sync"]
  schedule = "17 * * * *"
```

- [ ] **Step 4: Run and confirm green**

Run: `node --test test/calendar-sync.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 5: Full suite, then commit**

Run: `npm test`

```bash
git add netlify/functions/calendar-sync.js test/calendar-sync.test.js netlify.toml
git commit -m "feat(calendar): hourly pull of subscribed feeds into external_busy

A failing feed keeps the rows it already had. Deleting first and refetching
second would turn a transient 500 at Google into an empty calendar, and an
empty calendar reports you free with total confidence. Stale data is wrong by
hours; an empty table is wrong by a booked Saturday. Tests assert no DELETE is
issued on the failure path.

Feeds are independent — one bad URL cannot stop the others. Parser warnings
are persisted so they can reach the conflict panel.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: `_availability.js`

**Files:**
- Create: `netlify/functions/_availability.js` (helper — no handler)
- Create: `netlify/functions/availability.js` (HTTP endpoint)
- Modify: `netlify.toml` (redirect)
- Test: `test/availability.test.js`

Every `_`-prefixed file in this repo is a helper and none are routed. Netlify
also excludes underscore-prefixed files from function deployment, so a redirect
to `/.netlify/functions/_availability` would 404. The handler therefore lives in
its own file.

**Interfaces:**
- Consumes: `spanFor` from `_schedule.js`, `dayBoundsInZone` from `_tz.js`.
- Produces:
  - `overlaps(aStart, aEnd, bStart, bEnd) -> boolean` — half-open.
  - `conflictsFor(client, booking, { excludeBookingId, now }) -> Promise<Result>`
  - `publicAvailability(client, booking, { now }) -> Promise<{ available: boolean, degraded: boolean }>`
  - `exports.handler` — `GET /api/availability?date=&time=&zip=&service_id=&exclude=`

`Result` is `{ window, windowKnown, external, bookings, degraded, degradedReasons, warnings, unknowns }`.

- [ ] **Step 1: Write the failing test**

```js
// test/availability.test.js
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
```

- [ ] **Step 2: Run and watch it fail**

Run: `node --test test/availability.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```js
// netlify/functions/_availability.js
//
// "Am I free?" — answered from two sources at once: the calendars Joe
// subscribes to, and FME's own bookings.
//
// The invariant that matters: this function can return "nothing found", but it
// can never return "definitely clear" when a feed is broken or stale. Those are
// different answers and conflating them is how getDriveMins came to return 30
// for a ZIP it had never heard of. degraded is a first-class part of the result
// and every caller must render it.

const { withClient } = require('./_db');
const { CORS, preflight, requireAuth, unauthorized } = require('./_auth');
const { spanFor, TZ } = require('./_schedule');

const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

const STALE_MS = 25 * 3600 * 1000;   // a day plus an hour of slack for the hourly cron
const HARD_STATUSES = ['accepted', 'confirmed', 'completed'];
const SOFT_STATUSES = ['quoted', 'draft'];

// Half-open [start, end). A gig ending at 15:00 and an appointment starting at
// 15:00 do not clash — get this wrong and every back-to-back day cries wolf,
// which trains you to ignore the panel entirely.
const overlaps = (aStart, aEnd, bStart, bEnd) =>
  new Date(aStart) < new Date(bEnd) && new Date(bStart) < new Date(aEnd);

function feedHealth(feeds, now) {
  const reasons = [];
  const warnings = [];
  for (const f of feeds) {
    if (f.active === false) continue;
    if (!f.last_synced_at) { reasons.push(`"${f.label}" has never synced`); continue; }
    if (f.last_status === 'error') { reasons.push(`"${f.label}" failed to sync: ${f.last_error || 'unknown error'}`); continue; }
    const age = now - new Date(f.last_synced_at);
    if (age > STALE_MS) {
      const hours = Math.round(age / 3600000);
      reasons.push(`"${f.label}" last synced ${hours} hours ago`);
    }
    for (const w of (Array.isArray(f.last_warnings) ? f.last_warnings : [])) warnings.push(`${f.label}: ${w}`);
  }
  return { degraded: reasons.length > 0, reasons, warnings };
}

async function conflictsFor(client, booking, { excludeBookingId = null, now = new Date() } = {}) {
  const span = await spanFor(client, booking);

  const { rows: feeds } = await client.query(
    `SELECT id, label, active, last_synced_at, last_status, last_error, last_warnings
       FROM calendar_feeds WHERE active = TRUE`);
  const health = feedHealth(feeds, now);

  const base = {
    window: span.windowKnown ? { startsAt: span.startsAt, endsAt: span.endsAt } : null,
    windowKnown: span.windowKnown,
    external: [], bookings: [],
    degraded: health.degraded, degradedReasons: health.reasons,
    warnings: health.warnings, unknowns: span.unknowns,
  };

  if (!span.windowKnown) return base;

  const { rows: busy } = await client.query(
    `SELECT b.summary, b.all_day, b.starts_at, b.ends_at, f.label AS feed_label
       FROM external_busy b JOIN calendar_feeds f ON f.id = b.feed_id
      WHERE f.active = TRUE AND b.starts_at < $2 AND b.ends_at > $1
      ORDER BY b.starts_at`,
    [span.startsAt.toISOString(), span.endsAt.toISOString()]);

  base.external = busy
    .filter(e => overlaps(span.startsAt, span.endsAt, e.starts_at, e.ends_at))
    .map(e => ({ feedLabel: e.feed_label, summary: e.summary, allDay: e.all_day,
                 startsAt: new Date(e.starts_at), endsAt: new Date(e.ends_at) }));

  const { rows: others } = await client.query(
    `SELECT id, reference, client_name, status, event_date, event_time, event_zip, service_id
       FROM bookings
      WHERE event_date = $1 AND status = ANY($2)`,
    [String(booking.event_date).slice(0, 10), [...HARD_STATUSES, ...SOFT_STATUSES]]);

  for (const o of others) {
    if (excludeBookingId != null && String(o.id) === String(excludeBookingId)) continue;
    const s = await spanFor(client, o);
    // A same-day booking with no time cannot be ruled out, so it is reported
    // rather than dropped.
    const clash = s.windowKnown ? overlaps(span.startsAt, span.endsAt, s.startsAt, s.endsAt) : true;
    if (!clash) continue;
    base.bookings.push({
      id: o.id, reference: o.reference, clientName: o.client_name, status: o.status,
      tier: HARD_STATUSES.includes(o.status) ? 'hard' : 'soft',
      startsAt: s.startsAt, endsAt: s.endsAt, windowKnown: s.windowKnown,
    });
  }

  return base;
}

// Everything a stranger is allowed to learn. No summaries, no feed labels, no
// client names — and it fails CLOSED, because "we are not sure" must never let
// somebody instant-book a Saturday Joe is already committed to.
async function publicAvailability(client, booking, { now = new Date() } = {}) {
  const r = await conflictsFor(client, booking, { now });
  if (r.degraded || !r.windowKnown) return { available: false, degraded: true };
  const hard = r.bookings.some(b => b.tier === 'hard');
  return { available: r.external.length === 0 && !hard, degraded: false };
}

module.exports = { overlaps, conflictsFor, publicAvailability, feedHealth, TZ };
```

Drop the now-unused `withClient`, `preflight`, `requireAuth`, `unauthorized` and
`json` imports from `_availability.js` — it is a pure helper over an injected
client.

Then the endpoint:

```js
// netlify/functions/availability.js
// GET /api/availability?date=&time=&zip=&service_id=&exclude=
// Admin only. The computation lives in _availability.js so it can be imported
// by the Instant Booking gate without dragging an HTTP handler along.

const { withClient } = require('./_db');
const { CORS, preflight, requireAuth, unauthorized } = require('./_auth');
const { conflictsFor } = require('./_availability');

const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

exports.handler = async (event) => {
  const pre = preflight(event); if (pre) return pre;
  const auth = await requireAuth(event, ['admin']); if (!auth) return unauthorized();

  const q = event.queryStringParameters || {};
  if (!q.date) return json(400, { error: 'A date is required.' });

  try {
    return await withClient(async (client) => json(200, await conflictsFor(client, {
      event_date: q.date, event_time: q.time || null,
      event_zip: q.zip || null, service_id: q.service_id || null,
    }, { excludeBookingId: q.exclude || null })));
  } catch (e) {
    console.error('availability error:', e.message);
    // Never 200 with an empty result on failure: the caller must be able to
    // tell "nothing found" from "could not look". The modal turns this into
    // "this date has NOT been cleared".
    return json(500, { error: 'Availability could not be checked.' });
  }
};
```

Add to `netlify.toml`:

```toml
[[redirects]]
  from = "/api/availability"
  to = "/.netlify/functions/availability"
  status = 200
```

- [ ] **Step 4: Run and confirm green**

Run: `node --test test/availability.test.js`
Expected: PASS, 15 tests.

- [ ] **Step 5: Full suite, then commit**

Run: `npm test`

```bash
git add netlify/functions/_availability.js netlify/functions/availability.js test/availability.test.js netlify.toml
git commit -m "feat(availability): one conflict check over calendars and bookings

Answers 'am I free' from both sources against the gig's full working span, so a
2pm appointment clashes with an 11am gig that has Joe driving at 1:30.

The invariant: 'nothing found' and 'definitely clear' are different answers.
A stale, errored or never-synced feed sets degraded, the admin view renders it,
and publicAvailability fails closed — a stranger must never instant-book a slot
the system is unsure about. It returns two booleans and nothing else, so no
calendar summary can leak through a public path.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: The conflict panel in the booking pop-up

**Files:**
- Modify: `admin.html` — add `formatConflicts` inside the PURE HELPERS block (`admin.html:1538`–`1782`), and render the panel in `openBooking` (`admin.html:2144`)
- Test: `test/conflict-panel.test.js`

**Interfaces:**
- Consumes: `GET /api/availability` from Task 8.
- Produces: `formatConflicts(result) -> { tone: 'clear'|'warn'|'unknown', headline: string, lines: string[], notes: string[] }`, exported from the PURE HELPERS block for testing.

- [ ] **Step 1: Write the failing test**

```js
// test/conflict-panel.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Same trick as bookings-sort.test.js: run the pure helpers in a bare context so
// any reach for `document` throws instead of silently passing.
const HTML = fs.readFileSync(path.join(__dirname, '../admin.html'), 'utf8');
function loadHelpers() {
  const a = HTML.indexOf('// ══ PURE HELPERS');
  const b = HTML.indexOf('// ══ END PURE HELPERS');
  assert.ok(a !== -1 && b !== -1, 'pure-helper sentinels missing from admin.html');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(HTML.slice(a, b) + '\nout = { formatConflicts };', ctx);
  return ctx.out;
}
const { formatConflicts } = loadHelpers();

const clean = { windowKnown: true, external: [], bookings: [], degraded: false, degradedReasons: [], warnings: [], unknowns: [] };

test('a clean result reads as clear', () => {
  const v = formatConflicts(clean);
  assert.strictEqual(v.tone, 'clear');
  assert.match(v.headline, /clear|nothing/i);
});

test('a degraded result NEVER reads as clear, even with nothing found', () => {
  const v = formatConflicts({ ...clean, degraded: true, degradedReasons: ['"Personal" last synced 40 hours ago'] });
  assert.notStrictEqual(v.tone, 'clear', 'degraded must not be presented as clear');
  assert.strictEqual(v.tone, 'unknown');
  assert.match(v.notes.join(' '), /40 hours/);
});

test('an unknown window is not clear either', () => {
  const v = formatConflicts({ ...clean, windowKnown: false, unknowns: ['no event time on this booking'] });
  assert.strictEqual(v.tone, 'unknown');
  assert.match(v.notes.join(' '), /no event time/);
});

test('external events are listed with their feed and time', () => {
  const v = formatConflicts({ ...clean, external: [{
    feedLabel: 'Personal', summary: 'Dentist', allDay: false,
    startsAt: '2026-09-12T18:30:00Z', endsAt: '2026-09-12T19:00:00Z' }] });
  assert.strictEqual(v.tone, 'warn');
  assert.match(v.lines[0], /Dentist/);
  assert.match(v.lines[0], /Personal/);
});

test('an all-day event says so instead of printing midnight', () => {
  const v = formatConflicts({ ...clean, external: [{
    feedLabel: 'Personal', summary: 'Tulsa trip', allDay: true,
    startsAt: '2026-09-12T05:00:00Z', endsAt: '2026-09-13T05:00:00Z' }] });
  assert.match(v.lines[0], /all day/i);
  assert.ok(!/00:00/.test(v.lines[0]));
});

test('hard and soft bookings are distinguishable', () => {
  const v = formatConflicts({ ...clean, bookings: [
    { reference: 'FM-A', clientName: 'Ann', status: 'confirmed', tier: 'hard', windowKnown: true, startsAt: '2026-09-12T19:00:00Z', endsAt: '2026-09-12T21:00:00Z' },
    { reference: 'FM-B', clientName: 'Bob', status: 'quoted',    tier: 'soft', windowKnown: true, startsAt: '2026-09-12T19:00:00Z', endsAt: '2026-09-12T21:00:00Z' },
  ] });
  assert.strictEqual(v.tone, 'warn');
  assert.match(v.lines.join('\n'), /FM-A/);
  assert.match(v.lines.join('\n'), /FM-B/);
  assert.match(v.lines.find(l => /FM-B/.test(l)), /quoted/i);
});

test('parser warnings appear as notes even when nothing clashes', () => {
  const v = formatConflicts({ ...clean, warnings: ['Personal: the recurring event "School run" uses BYSETPOS'] });
  assert.match(v.notes.join(' '), /School run/);
  assert.notStrictEqual(v.tone, 'clear', 'an unexpanded recurring rule means the answer is not certain');
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `node --test test/conflict-panel.test.js`
Expected: FAIL — `formatConflicts is not defined`.

- [ ] **Step 3: Add `formatConflicts` to the PURE HELPERS block**

Insert before `// ══ END PURE HELPERS ══` in `admin.html`:

```js
// Turns an /api/availability result into something renderable. Pure, so
// test/conflict-panel.test.js can hold it to the one rule that matters:
// a degraded answer is never shown as "clear".
function formatConflicts(r) {
  const fmtTime = (iso) => new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(new Date(iso));

  const notes = [
    ...(r.degradedReasons || []),
    ...(r.warnings || []),
    ...(r.windowKnown ? [] : (r.unknowns || [])),
  ];

  const lines = [];
  for (const e of (r.external || [])) {
    lines.push(e.allDay
      ? `${e.summary} — all day (${e.feedLabel})`
      : `${e.summary} — ${fmtTime(e.startsAt)}–${fmtTime(e.endsAt)} (${e.feedLabel})`);
  }
  for (const b of (r.bookings || [])) {
    const when = b.windowKnown ? `${fmtTime(b.startsAt)}–${fmtTime(b.endsAt)}` : 'time not set';
    lines.push(`${b.reference} ${b.clientName} — ${when} (${b.status})`);
  }

  // Order matters. Uncertainty outranks a clean sweep, because "we found
  // nothing" and "we could not look" must never render the same.
  const uncertain = r.degraded || !r.windowKnown || (r.warnings || []).length > 0;
  if (lines.length) return { tone: 'warn', headline: `${lines.length} thing${lines.length === 1 ? '' : 's'} overlap this gig`, lines, notes };
  if (uncertain)    return { tone: 'unknown', headline: 'Nothing found — but the check is incomplete', lines, notes };
  return { tone: 'clear', headline: 'Clear — nothing else on this date', lines, notes };
}
```

- [ ] **Step 4: Render it in `openBooking`**

Add a container to the modal body markup in `openBooking`, directly above the date field:

```html
<div id="conflict-panel" style="margin-bottom:14px"></div>
```

Then add, outside the PURE HELPERS block:

```js
const CONFLICT_TONES = {
  clear:   { bg: '#f0fdf4', border: '#86efac', fg: '#166534', icon: '✅' },
  warn:    { bg: '#fef2f2', border: '#fca5a5', fg: '#991b1b', icon: '⚠️' },
  unknown: { bg: '#fffbeb', border: '#fde68a', fg: '#92400e', icon: '❓' },
};

async function refreshConflictPanel(bookingId) {
  const el = document.getElementById('conflict-panel');
  if (!el) return;
  const get = (f) => (document.querySelector(`.bk-edit[data-f="${f}"]`) || {}).value || '';
  const date = get('event_date');
  if (!date) { el.innerHTML = ''; return; }

  el.innerHTML = `<div style="font-size:.85rem;color:#9ca3af">Checking the calendar…</div>`;
  const qs = new URLSearchParams({ date, time: get('event_time'), zip: get('event_zip'), service_id: get('service_id') });
  if (bookingId && bookingId !== 'new') qs.set('exclude', bookingId);

  let r;
  try {
    const res = await apiFetch(`/api/availability?${qs}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    r = await res.json();
  } catch (e) {
    // A failed check is NOT a clear date. Say so.
    el.innerHTML = `<div style="background:#fffbeb;border:1.5px solid #fde68a;border-radius:10px;padding:10px 14px;font-size:.85rem;color:#92400e">
      ❓ Could not check the calendar (${esc(e.message)}). This date has <strong>not</strong> been cleared.</div>`;
    return;
  }

  const v = formatConflicts(r);
  const t = CONFLICT_TONES[v.tone];
  el.innerHTML = `
    <div style="background:${t.bg};border:1.5px solid ${t.border};border-radius:10px;padding:10px 14px">
      <div style="font-weight:700;color:${t.fg};font-size:.88rem">${t.icon} ${esc(v.headline)}</div>
      ${v.lines.length ? `<ul style="margin:6px 0 0 18px;padding:0;color:${t.fg};font-size:.85rem">${v.lines.map(l => `<li>${esc(l)}</li>`).join('')}</ul>` : ''}
      ${v.notes.length ? `<div style="margin-top:6px;font-size:.78rem;color:${t.fg};opacity:.8">${v.notes.map(esc).join(' · ')}</div>` : ''}
    </div>`;
}
```

Call `refreshConflictPanel(b.id)` at the end of `openBooking`, and bind it to changes:

```js
for (const f of ['event_date', 'event_time', 'event_zip', 'service_id']) {
  const input = document.querySelector(`.bk-edit[data-f="${f}"]`);
  if (input) input.addEventListener('change', () => refreshConflictPanel(b.id));
}
```

- [ ] **Step 5: Run and confirm green**

Run: `node --test test/conflict-panel.test.js`
Expected: PASS, 7 tests.

- [ ] **Step 6: Full suite, then commit**

Run: `npm test`

```bash
git add admin.html test/conflict-panel.test.js
git commit -m "feat(admin): show calendar and booking conflicts in the booking modal

formatConflicts lives in the PURE HELPERS block so the one rule that matters is
testable without a DOM: a degraded answer never renders as clear. 'We found
nothing' and 'we could not look' are different sentences, and a failed fetch
says the date has NOT been cleared rather than falling back to green.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 10: Warn on saving a clashing booking

**Files:**
- Modify: `admin.html` — the booking save handler
- Test: `test/conflict-panel.test.js` (append)

**Interfaces:**
- Consumes: `conflictsFor` via `/api/availability`; `formatConflicts` from Task 9.
- Produces: `hardConflictSummary(result) -> string|null` in the PURE HELPERS block — `null` when saving needs no confirmation.

- [ ] **Step 1: Write the failing test**

```js
test('hardConflictSummary: a clean result needs no confirmation', () => {
  assert.strictEqual(hardConflictSummary(clean), null);
});

test('hardConflictSummary: a soft (quoted) clash alone does not block the save', () => {
  const r = { ...clean, bookings: [{ reference: 'FM-B', clientName: 'Bob', status: 'quoted', tier: 'soft', windowKnown: true, startsAt: '2026-09-12T19:00:00Z', endsAt: '2026-09-12T21:00:00Z' }] };
  assert.strictEqual(hardConflictSummary(r), null);
});

test('hardConflictSummary: a confirmed booking clash asks first', () => {
  const r = { ...clean, bookings: [{ reference: 'FM-A', clientName: 'Ann', status: 'confirmed', tier: 'hard', windowKnown: true, startsAt: '2026-09-12T19:00:00Z', endsAt: '2026-09-12T21:00:00Z' }] };
  const s = hardConflictSummary(r);
  assert.ok(s, 'a hard clash must produce a confirmation message');
  assert.match(s, /FM-A/);
});

test('hardConflictSummary: any calendar event asks first', () => {
  const r = { ...clean, external: [{ feedLabel: 'Personal', summary: 'Dentist', allDay: false, startsAt: '2026-09-12T18:30:00Z', endsAt: '2026-09-12T19:00:00Z' }] };
  assert.match(hardConflictSummary(r), /Dentist/);
});
```

Add `hardConflictSummary` to the `vm` export line in `loadHelpers()`:

```js
vm.runInContext(HTML.slice(a, b) + '\nout = { formatConflicts, hardConflictSummary };', ctx);
const { formatConflicts, hardConflictSummary } = loadHelpers();
```

- [ ] **Step 2: Run and watch it fail**

Run: `node --test test/conflict-panel.test.js`
Expected: FAIL — `hardConflictSummary is not defined`.

- [ ] **Step 3: Implement**

In the PURE HELPERS block, below `formatConflicts`:

```js
// What, if anything, must be confirmed before saving. Soft clashes (a quote out
// for the same day) are shown in the panel but do not interrupt a save — you
// have not promised anybody anything yet.
function hardConflictSummary(r) {
  const items = [
    ...(r.external || []).map(e => `${e.summary} (${e.feedLabel})`),
    ...(r.bookings || []).filter(b => b.tier === 'hard').map(b => `${b.reference} ${b.clientName} (${b.status})`),
  ];
  return items.length ? items.join('\n• ') : null;
}
```

In the save handler, before the PATCH/POST:

```js
  // Deliberate double-booking is legitimate — two teams go out on the same day.
  // So this asks rather than blocks, and records the answer, because in six
  // weeks "why are there two gigs at 2pm" needs an answer better than a shrug.
  const summary = hardConflictSummary(lastConflictResult || {});
  if (summary) {
    const ok = confirm(`This date already has:\n\n• ${summary}\n\nSave anyway?`);
    if (!ok) return;
    payload.admin_notes = `${payload.admin_notes || ''}\n[${new Date().toISOString().slice(0,10)}] Saved over a known conflict: ${summary.replace(/\n• /g, '; ')}`.trim();
  }
```

Store the last result when the panel refreshes — in `refreshConflictPanel`, after parsing: `lastConflictResult = r;` with `let lastConflictResult = null;` declared alongside `CONFLICT_TONES`.

- [ ] **Step 4: Run and confirm green**

Run: `node --test test/conflict-panel.test.js`
Expected: PASS, 11 tests.

- [ ] **Step 5: Full suite, then commit**

Run: `npm test`

```bash
git add admin.html test/conflict-panel.test.js
git commit -m "feat(admin): confirm before saving a booking over a known conflict

Asks rather than blocks — two teams out on one day is legitimate — and appends
the override to admin_notes so a deliberate double-booking is a recorded
decision rather than a mystery six weeks later.

Soft clashes (a quote out for the same date) show in the panel but never
interrupt a save; nothing has been promised yet.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 11: Feeds settings UI

**Files:**
- Modify: `admin.html` — a "Calendars" section on the existing Settings/Catalogue page
- Test: `test/conflict-panel.test.js` (append)

**Interfaces:**
- Consumes: `GET`/`POST /api/calendar-feeds` from Task 6.
- Produces: `feedStatusLabel(feed, now) -> { text: string, tone: 'ok'|'warn'|'error' }` in the PURE HELPERS block.

- [ ] **Step 1: Write the failing test**

```js
test('feedStatusLabel: a fresh successful sync is ok', () => {
  const s = feedStatusLabel({ label: 'Personal', last_status: 'ok', last_synced_at: '2026-09-01T11:00:00Z', last_event_count: 42, last_warnings: [] }, new Date('2026-09-01T12:00:00Z'));
  assert.strictEqual(s.tone, 'ok');
  assert.match(s.text, /42/);
});

test('feedStatusLabel: an error is an error, and shows the reason', () => {
  const s = feedStatusLabel({ label: 'Personal', last_status: 'error', last_error: 'HTTP 404', last_synced_at: '2026-09-01T11:00:00Z' }, new Date('2026-09-01T12:00:00Z'));
  assert.strictEqual(s.tone, 'error');
  assert.match(s.text, /404/);
});

test('feedStatusLabel: never synced is an error, not a blank', () => {
  const s = feedStatusLabel({ label: 'Personal', last_status: null, last_synced_at: null }, new Date('2026-09-01T12:00:00Z'));
  assert.strictEqual(s.tone, 'error');
  assert.match(s.text, /never/i);
});

test('feedStatusLabel: stale is a warning', () => {
  const s = feedStatusLabel({ label: 'Personal', last_status: 'ok', last_synced_at: '2026-08-29T11:00:00Z', last_event_count: 42 }, new Date('2026-09-01T12:00:00Z'));
  assert.strictEqual(s.tone, 'warn');
  assert.match(s.text, /hours ago/);
});

test('feedStatusLabel: warnings are mentioned even on a successful sync', () => {
  const s = feedStatusLabel({ label: 'Personal', last_status: 'ok', last_synced_at: '2026-09-01T11:00:00Z', last_event_count: 42, last_warnings: ['a thing'] }, new Date('2026-09-01T12:00:00Z'));
  assert.strictEqual(s.tone, 'warn');
  assert.match(s.text, /1 warning/);
});
```

Extend the `vm` export line to `out = { formatConflicts, hardConflictSummary, feedStatusLabel };` and the destructure to match.

- [ ] **Step 2: Run and watch it fail**

Run: `node --test test/conflict-panel.test.js`
Expected: FAIL — `feedStatusLabel is not defined`.

- [ ] **Step 3: Implement**

In the PURE HELPERS block:

```js
// A feed's health in one line. Never blank and never quietly optimistic: a feed
// that has never synced reads as an error, because it is contributing nothing
// to a check that is meant to keep gigs off booked days.
function feedStatusLabel(f, now) {
  if (!f.last_synced_at) return { tone: 'error', text: 'Never synced — this calendar is not being checked' };
  if (f.last_status === 'error') return { tone: 'error', text: `Failed: ${f.last_error || 'unknown error'}` };
  const hours = Math.round((now - new Date(f.last_synced_at)) / 3600000);
  const warnCount = (f.last_warnings || []).length;
  if (hours > 25) return { tone: 'warn', text: `Last synced ${hours} hours ago — may be out of date` };
  if (warnCount) return { tone: 'warn', text: `${f.last_event_count || 0} events, ${warnCount} warning${warnCount === 1 ? '' : 's'}` };
  return { tone: 'ok', text: `${f.last_event_count || 0} events, synced ${hours === 0 ? 'within the hour' : `${hours}h ago`}` };
}
```

Then add a Calendars section rendering the feed list with Add / Replace / Delete and a **Refresh Now** button that `POST`s `{action:'refresh'}` and re-renders. Show `url_masked`, never a raw URL. Include the warnings from `last_warnings` under each feed.

- [ ] **Step 4: Run and confirm green**

Run: `node --test test/conflict-panel.test.js`
Expected: PASS, 16 tests.

- [ ] **Step 5: Full suite, then commit**

Run: `npm test`

```bash
git add admin.html test/conflict-panel.test.js
git commit -m "feat(admin): calendar feeds settings with health and refresh

Each feed shows what it last did, never a blank: a feed that has never synced
reads as an error, because it is contributing nothing to a check meant to keep
gigs off booked days. Addresses display masked — the URL is the credential and
never comes back out of the API.

Refresh Now covers the one real weakness of hourly polling: a date blocked out
twenty minutes ago while a client is on the phone.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Post-implementation

Not tasks; do these before calling the feature done.

1. **Deploy.** Auto-publish is off. Use the Netlify dashboard's Trigger deploy, which builds from GitHub — **not** the Netlify MCP `deploy-site`, which creates the `deploy_source: "api"` + `locked: true` state that broke auto-publishing on 2026-08-01.
2. **Add the first real feed** and press Refresh Now. Confirm `last_event_count` is non-zero and the count is plausible.
3. **Prove the failure path in production**, once: change a character in a feed URL, refresh, and confirm the booking modal says the check is incomplete rather than showing a green "clear". This is the behaviour the whole design is built around and it is worth seeing with your own eyes.
4. **Check the hourly schedule fired** in the Netlify function logs after the first hour.

## Spec coverage self-review

| Spec requirement | Task |
|---|---|
| `calendar_feeds` / `external_busy` schema, cascade, range index | 6 |
| URL is a credential; masked, replace-only | 6 |
| Absolute instants; TZID resolved at parse | 2, 4 |
| All-day = local midnight to midnight | 2, 4 |
| Wholesale replace in a transaction | 7 |
| Rolling window −7d / +18mo | 7 |
| Unfolding, escaping, DTSTART forms, DURATION | 4 |
| CANCELLED and TRANSPARENT filters | 4 |
| RRULE subset + EXDATE; unsupported → first instance + warning | 5 |
| Hourly at `17 * * * *`, 10s timeout, 5MB cap | 7 |
| Failing feed keeps rows | 7 |
| Degraded as a first-class output | 8 |
| `spanFor` from a booking alone; `windowKnown` | 3 |
| `getDriveMins` fallback unchanged; `zipKnown` added | 3 |
| Pinning test before extraction | 1 |
| Half-open intervals | 8 |
| Hard/soft booking tiers | 8 |
| Public path fails closed, leaks nothing | 8 |
| Booking pop-up panel | 9 |
| Save warning + changelog note | 10 |
| Settings UI with refresh | 11 |
| Declined-invitation limitation | Accepted in spec; no task |
| Month grid rendering | Out of scope by decision |
