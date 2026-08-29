const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const HTML = fs.readFileSync(path.join(__dirname, '../admin.html'), 'utf8');

// Same trick as booking-form-grouping.test.js: run the helpers in a bare
// context so any reach for `document` throws instead of silently passing.
function loadHelpers() {
  const a = HTML.indexOf('// ══ PURE HELPERS');
  const b = HTML.indexOf('// ══ END PURE HELPERS');
  assert.ok(a !== -1 && b !== -1, 'pure-helper sentinels missing from admin.html');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(
    HTML.slice(a, b) + '\nout = { BOOKING_COLUMNS, sortBookings, nextSort, incompleteReasons, needsZipEstimate, zipEstimateBookings, driveEstimateNote, driveTimeIsEstimated, groupBookingsByCamp, campDateRangeLabel };',
    ctx
  );
  return ctx.out;
}

const { BOOKING_COLUMNS, sortBookings, nextSort } = loadHelpers();

const order = (list, sort, field = 'reference') =>
  sortBookings([...list], sort).map(b => b[field]);

// Objects built inside the vm carry THAT realm's prototypes, so
// deepStrictEqual rejects them as "same structure but not reference-equal".
// Round-trip through JSON to bring them into this realm before comparing.
const plain = (v) => JSON.parse(JSON.stringify(v));

const ROWS = [
  { reference: 'A', client_name: 'Zoe',  service_name: 'Magic Show', event_date: '2026-09-01', total_price: 385, status: 'confirmed', created_at: '2026-08-03' },
  { reference: 'B', client_name: 'adam', service_name: 'Foam Party', event_date: '2026-07-15', total_price: 730, status: 'review',    created_at: '2026-08-01' },
  { reference: 'C', client_name: 'Mia',  service_name: 'Snow Party', event_date: '2026-08-20', total_price: 200, status: 'accepted',  created_at: '2026-08-02' },
];

test('every column the header renders is actually sortable', () => {
  // A column with no `get` would silently fall through to created_at order.
  for (const c of BOOKING_COLUMNS) {
    assert.strictEqual(typeof c.get, 'function', `${c.key} has no accessor`);
    assert.ok(c.label, `${c.key} has no label`);
  }
  assert.deepStrictEqual(
    plain(BOOKING_COLUMNS.map(c => c.key)),
    ['reference', 'client', 'service', 'event', 'created', 'total', 'status']
  );
});

test('event date sorts chronologically in both directions', () => {
  assert.deepStrictEqual(order(ROWS, { key: 'event', dir: 'asc'  }), ['B', 'C', 'A']);
  assert.deepStrictEqual(order(ROWS, { key: 'event', dir: 'desc' }), ['A', 'C', 'B']);
});

test('total sorts numerically, not as text', () => {
  // '730' vs '385' compares fine as strings; 1000 vs 385 does not. Guard the
  // case that would break if the accessor ever stopped calling Number().
  const rows = [...ROWS, { reference: 'D', total_price: 1000, event_date: '2026-09-09' }];
  assert.deepStrictEqual(order(rows, { key: 'total', dir: 'desc' }), ['D', 'B', 'A', 'C']);
});

test('client sort is case-insensitive', () => {
  // Plain localeCompare would put 'Zoe' before 'adam' on a case-sensitive run.
  assert.deepStrictEqual(order(ROWS, { key: 'client', dir: 'asc' }), ['B', 'C', 'A']);
});

test('service is sortable — the column the old dropdown could not reach', () => {
  assert.deepStrictEqual(order(ROWS, { key: 'service', dir: 'asc' }), ['B', 'A', 'C']);
});

test('blank values sort last whichever way the arrow points', () => {
  const rows = [
    { reference: 'has',   event_date: '2026-09-01' },
    { reference: 'blank', event_date: '' },
    { reference: 'also',  event_date: '2026-07-01' },
  ];
  assert.strictEqual(order(rows, { key: 'event', dir: 'asc'  }).at(-1), 'blank');
  assert.strictEqual(order(rows, { key: 'event', dir: 'desc' }).at(-1), 'blank');
});

test('inquiry date sorts by created_at in both directions', () => {
  assert.deepStrictEqual(order(ROWS, { key: 'created', dir: 'desc' }), ['A', 'C', 'B']);
  assert.deepStrictEqual(order(ROWS, { key: 'created', dir: 'asc'  }), ['B', 'C', 'A']);
});

test('unknown sort key falls back to created_at rather than throwing', () => {
  // CREATED_COL is now the Inquiry column itself, so this is the same order.
  assert.deepStrictEqual(order(ROWS, { key: 'nonsense', dir: 'desc' }), ['A', 'C', 'B']);
});

test('clicking the active column flips it; a new column does not', () => {
  assert.deepStrictEqual(plain(nextSort({ key: 'event', dir: 'asc'  }, 'event')),  { key: 'event',  dir: 'desc' });
  assert.deepStrictEqual(plain(nextSort({ key: 'event', dir: 'desc' }, 'event')),  { key: 'event',  dir: 'asc'  });
  assert.deepStrictEqual(plain(nextSort({ key: 'event', dir: 'desc' }, 'client')), { key: 'client', dir: 'asc'  });
});

test('total and inquiry open newest/biggest-first, every other column ascending', () => {
  assert.strictEqual(nextSort({ key: 'client', dir: 'asc' }, 'total').dir, 'desc');
  // Oldest lead first is never the useful first look at an inquiry date.
  assert.strictEqual(nextSort({ key: 'client', dir: 'asc' }, 'created').dir, 'desc');
  for (const key of ['reference', 'client', 'service', 'event', 'status']) {
    assert.strictEqual(nextSort({ key: 'total', dir: 'desc' }, key).dir, 'asc', `${key} should open ascending`);
  }
});

test('the sorted list is a copy — sorting must not reorder allBookings', () => {
  // renderBookingsTable spreads allBookings before filtering for this reason:
  // with no filters active, `list` would otherwise BE the global array.
  const original = [...ROWS];
  sortBookings([...ROWS], { key: 'total', dir: 'asc' });
  assert.deepStrictEqual(ROWS, original);
});

// Event-time snapping tests lived here. The Event Time field is now a <select>
// of quarter hours (TIME_OPTIONS in admin.html), which cannot produce an
// off-slot value in the first place, so roundTo15() and its tests were removed
// together. See test/time-options.test.js.

// ── The incomplete catch-all ─────────────────────────────────────────────────
// Status-based panels miss leads that arrived without a service or a price.
// This one keys off missing DATA, so nothing falls through.

const { incompleteReasons } = loadHelpers();
const OK = { status:'review', service_id:'foam_single', total_price:385,
             event_date:'2099-01-01', event_time:'14:00', event_zip:'73118' };

test('a complete future booking raises nothing', () => {
  assert.deepStrictEqual(plain(incompleteReasons(OK)), []);
});

test('each missing field is named individually', () => {
  const cases = [
    [{ service_id: '' },   'no service'],
    [{ total_price: 0 },   'not priced'],
    [{ event_time: '' },   'no time'],
    [{ event_zip: '' },    'no ZIP'],
  ];
  for (const [patch, reason] of cases) {
    assert.deepStrictEqual(plain(incompleteReasons({ ...OK, ...patch })), [reason]);
  }
});

test('the real stubs are caught regardless of status', () => {
  // Kristal Rohrbaugh's fundraiser: `confirmed`, no service, $0 — it matched
  // no status-based panel, which is the whole reason this exists.
  const kristal = { ...OK, status:'confirmed', service_id:'', total_price:0, event_time:'', event_zip:'' };
  assert.deepStrictEqual(plain(incompleteReasons(kristal)),
    ['no service', 'not priced', 'no time', 'no ZIP']);
  // Tim Havern: same shape, `review`.
  assert.ok(incompleteReasons({ ...kristal, status:'review' }).length);
  // And an accepted one, e.g. Meghan Swinehart.
  assert.ok(incompleteReasons({ ...kristal, status:'accepted' }).length);
});

test('finished and abandoned bookings are left alone', () => {
  // Completed gigs and cancellations are history; drafts are half-typed by
  // design. Flagging 126 imported completed rows would bury the live ones.
  for (const status of ['completed', 'cancelled', 'draft']) {
    assert.deepStrictEqual(plain(incompleteReasons({ ...OK, status, service_id:'', total_price:0 })), []);
  }
});

test('past events are not flagged — this panel is about work still to come', () => {
  assert.deepStrictEqual(plain(incompleteReasons({ ...OK, event_date:'2020-01-01', service_id:'' })), []);
});

test('a booking with no date at all is flagged, not skipped', () => {
  // No date must not read as "past" and get silently dropped.
  const r = plain(incompleteReasons({ ...OK, event_date:'', service_id:'' }));
  assert.ok(r.includes('no date'), 'missing date is itself a reason');
  assert.ok(r.includes('no service'));
});

test('a $0 price counts as unpriced however it is expressed', () => {
  for (const v of [0, '0', '0.00', null, undefined, '']) {
    assert.ok(plain(incompleteReasons({ ...OK, total_price: v })).includes('not priced'),
      `total_price ${JSON.stringify(v)} should count as unpriced`);
  }
});

// ── needsZipEstimate / zipEstimateBookings ──────────────────────────────────
// The dashboard's "N upcoming gigs have no usable ZIP" banner. zip_known is
// computed server-side (bookings.js, from _schedule.js's ONE ZIP table) so
// these helpers never carry their own copy of it — see the comment above
// needsZipEstimate in admin.html for why that matters.
const { needsZipEstimate, zipEstimateBookings } = loadHelpers();

const TODAY = '2026-08-27';

test('needsZipEstimate: an upcoming booking with an unknown/blank ZIP needs one', () => {
  assert.strictEqual(
    needsZipEstimate({ id: 1, event_date: '2026-09-01', zip_known: false }, false, TODAY),
    true
  );
});

test('needsZipEstimate: a known ZIP never needs one, whatever else is true', () => {
  assert.strictEqual(
    needsZipEstimate({ id: 1, event_date: '2026-09-01', zip_known: true }, false, TODAY),
    false
  );
});

test('needsZipEstimate: a per-assignment drive override already pins the number, ZIP or no ZIP', () => {
  assert.strictEqual(
    needsZipEstimate({ id: 1, event_date: '2026-09-01', zip_known: false }, true, TODAY),
    false
  );
});

test('needsZipEstimate: past events are not actionable', () => {
  assert.strictEqual(
    needsZipEstimate({ id: 1, event_date: '2026-01-01', zip_known: false }, false, TODAY),
    false
  );
});

test('needsZipEstimate: no event_date at all is not actionable either — nothing to depart FOR yet', () => {
  assert.strictEqual(
    needsZipEstimate({ id: 1, event_date: null, zip_known: false }, false, TODAY),
    false
  );
});

test('zipEstimateBookings: counts only the upcoming, unpinned, unknown-ZIP bookings', () => {
  const bookings = [
    { id: 1, event_date: '2026-09-01', zip_known: false }, // counts
    { id: 2, event_date: '2026-09-01', zip_known: true },  // known ZIP
    { id: 3, event_date: '2026-09-01', zip_known: false }, // overridden
    { id: 4, event_date: '2026-01-01', zip_known: false }, // past
    { id: 5, event_date: '2026-09-05', zip_known: false }, // counts
  ];
  const result = zipEstimateBookings(bookings, new Set([3]), TODAY);
  assert.deepStrictEqual(plain(result).map(b => b.id), [1, 5]);
});

test('zipEstimateBookings: accepts a plain array of ids too, not just a Set', () => {
  const bookings = [{ id: 7, event_date: '2026-09-01', zip_known: false }];
  assert.strictEqual(zipEstimateBookings(bookings, [7], TODAY).length, 0);
  assert.strictEqual(zipEstimateBookings(bookings, [], TODAY).length, 1);
});

// ── driveEstimateNote / driveTimeIsEstimated ────────────────────────────────
// Fix round 1: the schedule timeline showed a guessed Depart time with no
// indication, on both the admin gig card and the staff portal.
// Fix round 2: driveTimeIsEstimated is now DERIVED at render time (booking's
// zip_known + assignment's override), not read off a persisted column — a
// stored flag never got set on an existing assignment (autoCalcTimes only
// writes once, on creation) and would have gone stale the moment a missing
// ZIP was filled in.
const { driveEstimateNote, driveTimeIsEstimated } = loadHelpers();

test('driveEstimateNote: a known drive time gets no qualifier', () => {
  assert.strictEqual(driveEstimateNote(false), '');
  assert.strictEqual(driveEstimateNote(null), '');
  assert.strictEqual(driveEstimateNote(undefined), '');
});

test('driveEstimateNote: a guessed drive time says so', () => {
  assert.match(driveEstimateNote(true), /estimated/);
  assert.match(driveEstimateNote(true), /no ZIP/);
});

test('driveTimeIsEstimated: no override, unknown ZIP — estimated. This is FM-E5EFPPQX\'s exact shape.', () => {
  assert.strictEqual(
    driveTimeIsEstimated({ drive_minutes_each_way: null }, { zip_known: false }),
    true
  );
});

test('driveTimeIsEstimated: no override, known ZIP — not estimated', () => {
  assert.strictEqual(
    driveTimeIsEstimated({ drive_minutes_each_way: null }, { zip_known: true }),
    false
  );
});

test('driveTimeIsEstimated: an override wins regardless of ZIP — a hand-entered figure is real, not a guess', () => {
  assert.strictEqual(
    driveTimeIsEstimated({ drive_minutes_each_way: 40 }, { zip_known: false }),
    false
  );
  assert.strictEqual(
    driveTimeIsEstimated({ drive_minutes_each_way: 40 }, { zip_known: true }),
    false
  );
});

test('driveTimeIsEstimated: a missing booking (lookup failed) reads as estimated, not a crash', () => {
  assert.strictEqual(driveTimeIsEstimated({ drive_minutes_each_way: null }, undefined), true);
});

// ── groupBookingsByCamp ──────────────────────────────────────────────────────
// Phase 1 of camps. Nothing here decides what a camp IS (that's explicit, at
// creation, in camps.js) — this only decides how an already-filtered flat
// list of bookings is displayed: an ordinary booking passes through
// untouched, and a booking whose camp_id names a known camp gets pulled into
// one group row per camp.
const { groupBookingsByCamp, campDateRangeLabel } = loadHelpers();

// The MAC's real 5-day camp, 14-18 Jul, one row per day exactly as it
// actually sits in production today — camp_id null on every one, since the
// column didn't exist until this feature shipped.
const MAC_DAYS = ['14', '15', '16', '17', '18'].map((d, i) => ({
  id: 100 + i, reference: `FM-MAC${i}`, camp_id: 1,
  client_name: 'The MAC', service_name: 'Foam Party',
  event_date: `2026-07-${d}`, created_at: '2026-06-01', total_price: 300, status: 'confirmed',
}));
const CAMPS = [{ id: 1, label: 'MAC Summer Camp' }];

test('with no camps in the table, the list is untouched — byte-identical to today', () => {
  const plainBookings = [
    { id: 1, reference: 'A', event_date: '2026-09-01' },
    { id: 2, reference: 'B', event_date: '2026-09-02', camp_id: null },
  ];
  const rows = groupBookingsByCamp(plainBookings, []);
  assert.deepStrictEqual(plain(rows), plain(plainBookings));
});

// A camp_id that doesn't match any known camp (e.g. the camp was looked up
// from a stale local cache) must never crash or silently vanish the booking
// — it passes through as an ordinary row, same as camp_id null.
test('a camp_id with no matching camp record passes through untouched, not dropped', () => {
  const rows = groupBookingsByCamp([{ id: 9, reference: 'X', camp_id: 999, event_date: '2026-09-01' }], []);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].isCamp, undefined);
  assert.strictEqual(rows[0].reference, 'X');
});

test('five days of one camp collapse into one row carrying all five days', () => {
  const rows = groupBookingsByCamp(MAC_DAYS, CAMPS);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].isCamp, true);
  assert.strictEqual(rows[0].label, 'MAC Summer Camp');
  assert.strictEqual(rows[0].days.length, 5);
  assert.strictEqual(rows[0].dateRangeLabel, '14–18 Jul');
});

test('a camp row sorts by its earliest day, alongside ordinary bookings', () => {
  const others = [
    { id: 1, reference: 'BEFORE', event_date: '2026-07-01' },
    { id: 2, reference: 'BETWEEN', event_date: '2026-07-16' },
    { id: 3, reference: 'AFTER', event_date: '2026-08-01' },
  ];
  const rows = groupBookingsByCamp([...MAC_DAYS, ...others], CAMPS);
  const ordered = sortBookings(rows, { key: 'event', dir: 'asc' }).map(r => r.isCamp ? 'CAMP' : r.reference);
  // The camp's earliest day is 14 Jul, so it lands between BEFORE (1 Jul)
  // and BETWEEN (16 Jul) — not wherever its last day or an unsorted day would.
  // plain(): rows/ordered are built inside the vm realm (see the file's own
  // comment on `plain` above) — round-trip through JSON before comparing.
  assert.deepStrictEqual(plain(ordered), ['BEFORE', 'CAMP', 'BETWEEN', 'AFTER']);
});

test('total_price on a camp row is the sum of its days, not just the first', () => {
  const rows = groupBookingsByCamp(MAC_DAYS, CAMPS);
  assert.strictEqual(rows[0].total_price, 300 * 5);
});

// Divergent per-day total/status, on purpose — MAC_DAYS above shares 300 and
// 'confirmed' across every day, which can't tell "summed total" apart from
// "first day's total repeated", or "earliest day's status" apart from
// "whichever day sorts first in the source array" (DIVERGENT_CAMP_DAYS is
// deliberately NOT in event_date order in the array literal). These two
// pin the actual rule: total is the SUM across days; status is the
// EARLIEST day's, by event_date — not source order, not min/max/alpha.
const DIVERGENT_CAMP_DAYS = [
  { id: 300, reference: 'FM-D2', camp_id: 2, event_date: '2026-07-16', total_price: 700, status: 'confirmed' },
  { id: 301, reference: 'FM-D1', camp_id: 2, event_date: '2026-07-14', total_price: 100, status: 'accepted' }, // earliest day, listed second
  { id: 302, reference: 'FM-D3', camp_id: 2, event_date: '2026-07-18', total_price: 700, status: 'review' },
];
const DIVERGENT_CAMPS = [{ id: 2, label: 'Divergent Camp' }];

test('a camp row sorts by its SUMMED total — total is the one column that is not "earliest day"', () => {
  const others = [
    { id: 1, reference: 'LOW', event_date: '2026-01-01', total_price: 1000 },
    { id: 2, reference: 'HIGH', event_date: '2026-01-02', total_price: 2000 },
  ];
  const rows = groupBookingsByCamp([...DIVERGENT_CAMP_DAYS, ...others], DIVERGENT_CAMPS);
  const camp = rows.find(r => r.isCamp);
  // 700 + 100 + 700, not 100 (the earliest day alone) and not 700 (the
  // first day in source order).
  assert.strictEqual(camp.total_price, 1500);
  const ascending = sortBookings([...rows], { key: 'total', dir: 'asc' }).map(r => r.isCamp ? 'CAMP' : r.reference);
  assert.deepStrictEqual(plain(ascending), ['LOW', 'CAMP', 'HIGH']);
  const descending = sortBookings([...rows], { key: 'total', dir: 'desc' }).map(r => r.isCamp ? 'CAMP' : r.reference);
  assert.deepStrictEqual(plain(descending), ['HIGH', 'CAMP', 'LOW']);
});

test("a camp row sorts by its earliest day's status, which is what the code does", () => {
  const rows = groupBookingsByCamp(DIVERGENT_CAMP_DAYS, DIVERGENT_CAMPS);
  const camp = rows.find(r => r.isCamp);
  // 14 Jul (earliest) is 'accepted' — not 'confirmed' (16 Jul, listed FIRST
  // in the source array) and not 'review' (18 Jul, the LAST day).
  assert.strictEqual(camp.status, 'accepted');

  const others = [
    { id: 1, reference: 'BEFORE', event_date: '2026-01-01', status: 'aaaa' },
    { id: 2, reference: 'AFTER', event_date: '2026-01-02', status: 'zzzz' },
  ];
  const ordered = sortBookings([...rows, ...others], { key: 'status', dir: 'asc' })
    .map(r => r.isCamp ? 'CAMP' : r.reference);
  // 'aaaa' < 'accepted' < 'zzzz' alphabetically — proves the sort actually
  // used the camp's .status field, not just left it in place.
  assert.deepStrictEqual(plain(ordered), ['BEFORE', 'CAMP', 'AFTER']);
});

// The filter-then-group contract: renderBookingsTable filters the flat list
// FIRST, then groups the survivors — so a filter matching only some of a
// camp's days must show the camp with just those days, never the whole camp
// and never nothing.
test('a filter matching only some days of a camp shows the camp with only those days', () => {
  const filtered = MAC_DAYS.filter(b => b.event_date <= '2026-07-16'); // 14, 15, 16 survive
  const rows = groupBookingsByCamp(filtered, CAMPS);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].days.length, 3);
  assert.strictEqual(rows[0].dateRangeLabel, '14–16 Jul');
});

test('a filter matching zero days of a camp shows nothing for that camp — not the whole camp', () => {
  const filtered = MAC_DAYS.filter(b => b.event_date >= '2026-09-01'); // none survive
  const rows = groupBookingsByCamp(filtered, CAMPS);
  assert.strictEqual(rows.length, 0);
});

// jfuller@eols.org: 14 separate summer shows in one week for one client, no
// camp_id on any of them. Grouping those would be the exact bug the spec
// calls out — this proves camp_id, not client/date proximity, is what groups.
test('bookings with no camp_id never group, however many share a client or a week', () => {
  const busyWeek = Array.from({ length: 14 }, (_, i) => ({
    id: 200 + i, reference: `FM-J${i}`, client_name: 'jfuller@eols.org',
    event_date: '2026-06-0' + (1 + (i % 7)),
  }));
  const rows = groupBookingsByCamp(busyWeek, []);
  assert.strictEqual(rows.length, 14);
  assert.ok(rows.every(r => r.isCamp === undefined));
});

test('campDateRangeLabel: a single day reads as just that day', () => {
  assert.strictEqual(campDateRangeLabel([{ event_date: '2026-07-14' }]), '14 Jul');
});

test('campDateRangeLabel: crossing months names both', () => {
  assert.strictEqual(
    campDateRangeLabel([{ event_date: '2026-07-30' }, { event_date: '2026-08-02' }]),
    '30 Jul–2 Aug'
  );
});

test('campDateRangeLabel: no dated days at all says so rather than crashing', () => {
  assert.strictEqual(campDateRangeLabel([]), 'no dates');
  assert.strictEqual(campDateRangeLabel([{ event_date: null }]), 'no dates');
});
