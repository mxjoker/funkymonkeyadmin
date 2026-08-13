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
    HTML.slice(a, b) + '\nout = { BOOKING_COLUMNS, sortBookings, nextSort, roundTo15, incompleteReasons };',
    ctx
  );
  return ctx.out;
}

const { BOOKING_COLUMNS, sortBookings, nextSort, roundTo15 } = loadHelpers();

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
    ['reference', 'client', 'service', 'event', 'total', 'status']
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

test('unknown sort key falls back to created_at rather than throwing', () => {
  assert.deepStrictEqual(order(ROWS, { key: 'created', dir: 'desc' }), ['A', 'C', 'B']);
  assert.deepStrictEqual(order(ROWS, { key: 'nonsense', dir: 'desc' }), ['A', 'C', 'B']);
});

test('clicking the active column flips it; a new column does not', () => {
  assert.deepStrictEqual(plain(nextSort({ key: 'event', dir: 'asc'  }, 'event')),  { key: 'event',  dir: 'desc' });
  assert.deepStrictEqual(plain(nextSort({ key: 'event', dir: 'desc' }, 'event')),  { key: 'event',  dir: 'asc'  });
  assert.deepStrictEqual(plain(nextSort({ key: 'event', dir: 'desc' }, 'client')), { key: 'client', dir: 'asc'  });
});

test('total opens biggest-first, every other column opens ascending', () => {
  assert.strictEqual(nextSort({ key: 'client', dir: 'asc' }, 'total').dir, 'desc');
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

// ── Event time snapping (admin booking modal) ────────────────────────────────

test('minutes snap to the nearest quarter hour', () => {
  assert.strictEqual(roundTo15('13:00'), '13:00');
  assert.strictEqual(roundTo15('13:07'), '13:00');
  assert.strictEqual(roundTo15('13:08'), '13:15');
  assert.strictEqual(roundTo15('13:22'), '13:15');
  assert.strictEqual(roundTo15('13:23'), '13:30');
  assert.strictEqual(roundTo15('13:38'), '13:45');
});

test('rounding up past :45 rolls the hour', () => {
  assert.strictEqual(roundTo15('13:53'), '14:00');
});

test('late-night rounding never rolls into the next day', () => {
  // 23:53 -> 24:00 is not a time any input can hold, and an event must not
  // silently move to tomorrow because of rounding.
  assert.strictEqual(roundTo15('23:53'), '23:45');
});

test('Postgres time values with seconds are accepted', () => {
  assert.strictEqual(roundTo15('14:30:00'), '14:30');
  assert.strictEqual(roundTo15('09:07:42'), '09:00');
});

test('single-digit hours are zero-padded so the input accepts them', () => {
  assert.strictEqual(roundTo15('9:15'), '09:15');
});

test('empty and junk stay empty rather than becoming 00:00', () => {
  // Clearing the field must clear it, not silently set midnight.
  for (const v of ['', null, undefined, 'not a time']) {
    assert.strictEqual(roundTo15(v), '', `${JSON.stringify(v)} should round to ''`);
  }
});

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
