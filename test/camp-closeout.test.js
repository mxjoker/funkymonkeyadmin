const { test } = require('node:test');
const assert = require('node:assert');
const { splitAcrossDays, planCloseOut, closeOutCamp } = require('../netlify/functions/camps.js');
const { buildCampInvoiceBooking, buildInvoiceLines } = require('../netlify/functions/generate-invoice.js');

// Phase 3 of camps: one flat rate per kid for the whole week, split across
// the days that actually ran. This is a money path — the split feeds
// bookings.total_price, which is what every revenue query and every invoice
// in this codebase reads.

// Hand-rolled fake client, same technique as test/finalise-camp.test.js:
// BEGIN snapshots, ROLLBACK restores, so "nothing was written" is a property
// the test can actually check rather than take on trust.
function fakeClient(campsSeed, bookingsSeed, opts = {}) {
  let camps = campsSeed.map(c => ({ ...c }));
  let bookings = bookingsSeed.map(b => ({ ...b }));
  let snapshot = null;
  return {
    get camps() { return camps; },
    get bookings() { return bookings; },
    async query(sql, params = []) {
      if (/^BEGIN/i.test(sql)) {
        snapshot = { camps: camps.map(c => ({ ...c })), bookings: bookings.map(b => ({ ...b })) };
        return { rows: [] };
      }
      if (/^COMMIT/i.test(sql)) { snapshot = null; return { rows: [] }; }
      if (/^ROLLBACK/i.test(sql)) {
        if (snapshot) { camps = snapshot.camps; bookings = snapshot.bookings; snapshot = null; }
        return { rows: [] };
      }
      if (/^\s*SELECT \* FROM camps WHERE id = \$1/i.test(sql)) {
        const row = camps.find(c => c.id === params[0]);
        return { rows: row ? [row] : [] };
      }
      if (/FROM bookings WHERE camp_id = \$1/i.test(sql)) {
        return {
          rows: bookings.filter(b => b.camp_id === params[0])
            .sort((a, b) => String(a.event_date).localeCompare(String(b.event_date)) || a.id - b.id),
        };
      }
      if (/^\s*UPDATE bookings SET total_price/i.test(sql)) {
        if (opts.failDayUpdate) throw new Error('simulated day update failure');
        const [amount, headcount, id] = params;
        const row = bookings.find(b => b.id === id);
        if (row) { row.total_price = amount; row.service_price = amount; row.guest_count = headcount; }
        return { rows: [] };
      }
      if (/^\s*UPDATE camps SET rate_per_kid/i.test(sql)) {
        const [rate, headcount, id] = params;
        const row = camps.find(c => c.id === id);
        if (!row) return { rows: [] };
        Object.assign(row, { rate_per_kid: rate, headcount, closed_out_at: '2026-08-29T00:00:00Z' });
        return { rows: [{ ...row }] };
      }
      throw new Error('unexpected SQL: ' + sql.trim().split('\n')[0]);
    },
  };
}

const CAMP = { id: 1, label: 'Funky Monkey Magic Camp', reference: 'CAMP-ABC123', client_email: 'a@b.com' };
const week = (n, over = {}) => Array.from({ length: n }, (_, i) => ({
  id: i + 1, camp_id: 1, reference: `FM-D${i + 1}`, event_date: `2026-07-1${i + 4}`,
  status: 'confirmed', total_price: 0, service_price: 0, guest_count: 0,
  payment_amount: 0, deposit_paid: false, ...over,
}));

const totalCents = (parts) => parts.reduce((s, p) => s + Math.round(p * 100), 0);

// ── the split ─────────────────────────────────────────────────────────────

// The invariant the whole feature rests on: the parts add up to the bill.
// $1,700 over 3 days is NOT three times $566.67 — that invoices $1,700.01,
// and a client who adds up their own days rings up about the cent.
test('the parts sum to the total exactly, remainder on the last day', () => {
  const parts = splitAcrossDays(1700, 3);
  assert.deepStrictEqual(parts, [566.66, 566.66, 566.68]);
  assert.strictEqual(totalCents(parts), 170000);
});

test('every total-and-day-count combination still sums exactly', () => {
  for (let kids = 1; kids <= 40; kids++) {
    for (const rate of [85, 84.95, 33.33, 0, 7.07]) {
      for (let days = 1; days <= 7; days++) {
        const total = Math.round(rate * kids * 100) / 100;
        const parts = splitAcrossDays(total, days);
        assert.strictEqual(parts.length, days);
        assert.strictEqual(totalCents(parts), Math.round(total * 100),
          `${kids} kids @ $${rate} over ${days} days did not sum back to $${total}`);
        assert.ok(parts.every(p => p >= 0), 'no day may take a negative share');
      }
    }
  }
});

test('one day takes the whole total, and no days takes nothing', () => {
  assert.deepStrictEqual(splitAcrossDays(1700, 1), [1700]);
  assert.deepStrictEqual(splitAcrossDays(1700, 0), []);
  assert.deepStrictEqual(splitAcrossDays(1700, -2), []);
  assert.deepStrictEqual(splitAcrossDays('nope', 3), []);
});

// ── close-out ─────────────────────────────────────────────────────────────

test('a five-day camp splits 20 kids at $85 across its days', async () => {
  const c = fakeClient([CAMP], week(5));
  const res = await closeOutCamp(c, 1, { rate_per_kid: 85, headcount: 20 });

  assert.strictEqual(res.total, 1700);
  assert.strictEqual(totalCents(c.bookings.map(b => b.total_price)), 170000);
  assert.ok(c.bookings.every(b => b.total_price === 340), 'an even split should land evenly');
  assert.ok(c.bookings.every(b => b.service_price === b.total_price));
  assert.ok(c.bookings.every(b => b.guest_count === 20), 'the headcount is one number for the whole camp');
  assert.strictEqual(Number(c.camps[0].rate_per_kid), 85);
  assert.ok(c.camps[0].closed_out_at, 'closed_out_at is the only marker of "billed"');
});

// The MAC has five cancelled June days beside a week that ran. Splitting
// across all of them would halve every real day and put revenue on days
// nobody worked.
test('cancelled days get nothing and do not dilute the live ones', async () => {
  const days = [...week(3), ...week(2).map((d, i) => ({ ...d, id: 90 + i, status: 'cancelled' }))];
  const c = fakeClient([CAMP], days);
  const res = await closeOutCamp(c, 1, { rate_per_kid: 100, headcount: 17 });

  assert.strictEqual(res.days.length, 3);
  assert.strictEqual(res.cancelled_count, 2);
  const cancelled = c.bookings.filter(b => b.status === 'cancelled');
  assert.ok(cancelled.every(b => b.total_price === 0), 'a cancelled day must not be paid');
  assert.ok(cancelled.every(b => b.guest_count === 0), 'nor counted');
  assert.strictEqual(totalCents(c.bookings.map(b => b.total_price)), 170000);
});

test('a camp whose every day is cancelled refuses rather than dividing by zero', async () => {
  const c = fakeClient([CAMP], week(3, { status: 'cancelled' }));
  await assert.rejects(() => closeOutCamp(c, 1, { rate_per_kid: 85, headcount: 20 }),
    e => e.statusCode === 400 && /no active days/i.test(e.message));
});

// Re-closing is how a typo'd headcount gets corrected, so it must recompute
// and overwrite — never add to what is already there.
test('closing out twice overwrites, it never accumulates', async () => {
  const c = fakeClient([CAMP], week(5));
  await closeOutCamp(c, 1, { rate_per_kid: 85, headcount: 20 });
  const first = c.bookings.map(b => b.total_price);

  await closeOutCamp(c, 1, { rate_per_kid: 85, headcount: 20 });
  assert.deepStrictEqual(c.bookings.map(b => b.total_price), first, 'a repeat close-out changed the money');

  await closeOutCamp(c, 1, { rate_per_kid: 85, headcount: 18 });
  assert.strictEqual(totalCents(c.bookings.map(b => b.total_price)), 153000);
  assert.ok(c.bookings.every(b => b.guest_count === 18));
});

// Same hazard as the quote-edit guard in booking.js: recomputing a day out
// from under a payment re-bills someone who has already paid.
test('a day with money recorded against it blocks the whole close-out', async () => {
  for (const paidDay of [{ payment_amount: 400 }, { deposit_paid: true }]) {
    const days = week(5);
    Object.assign(days[2], paidDay);
    const c = fakeClient([CAMP], days);

    await assert.rejects(() => closeOutCamp(c, 1, { rate_per_kid: 85, headcount: 20 }),
      e => e.statusCode === 409 && /FM-D3/.test(e.message));
    assert.ok(c.bookings.every(b => Number(b.total_price) === 0),
      'the guard must refuse before writing anything, not part-way through');
    assert.ok(!c.camps[0].closed_out_at);
  }
});

test('a failed day write rolls the whole camp back', async () => {
  const c = fakeClient([CAMP], week(5), { failDayUpdate: true });
  await assert.rejects(() => closeOutCamp(c, 1, { rate_per_kid: 85, headcount: 20 }));
  assert.ok(c.bookings.every(b => b.total_price === 0), 'a half-billed camp is worse than an unbilled one');
  assert.ok(!c.camps[0].closed_out_at);
});

test('rate and headcount are validated before anything is read or written', async () => {
  const c = fakeClient([CAMP], week(5));
  for (const bad of [{ rate_per_kid: 85, headcount: 0 }, { rate_per_kid: 85, headcount: 'lots' },
                     { rate_per_kid: -5, headcount: 20 }, { rate_per_kid: 'x', headcount: 20 }]) {
    await assert.rejects(() => closeOutCamp(c, 1, bad), e => e.statusCode === 400);
  }
  await assert.rejects(() => planCloseOut(c, 999, { rate_per_kid: 85, headcount: 20 }),
    e => e.statusCode === 404);
});

// The preview the admin confirms against must be the same arithmetic that
// gets saved — a browser-side copy of the split is how the catalogue prices
// drifted from the database.
test('the preview writes nothing and matches what the save produces', async () => {
  const c = fakeClient([CAMP], week(4));
  const preview = await planCloseOut(c, 1, { rate_per_kid: 85, headcount: 20 });
  assert.ok(c.bookings.every(b => b.total_price === 0), 'preview must not write');
  assert.ok(!c.camps[0].closed_out_at);

  const saved = await closeOutCamp(c, 1, { rate_per_kid: 85, headcount: 20 });
  assert.deepStrictEqual(saved.days.map(d => d.amount), preview.days.map(d => d.amount));
  assert.strictEqual(saved.total, preview.total);
});

// ── the invoice ───────────────────────────────────────────────────────────

test('the camp invoice is one line for the week, and it adds up', () => {
  const camp = { ...CAMP, rate_per_kid: 85, headcount: 20, closed_out_at: '2026-07-19T00:00:00Z' };
  const days = [...week(5), { ...week(1)[0], id: 99, status: 'cancelled' }];
  const booking = buildCampInvoiceBooking(camp, days);
  const lines = buildInvoiceLines(booking);

  assert.strictEqual(lines.length, 1, 'a camp is billed as one thing, not once per day');
  assert.strictEqual(lines[0].qty, 20);
  assert.strictEqual(lines[0].amount, 1700);
  assert.strictEqual(lines[0].primary, true);
  assert.match(lines[0].label, /5 days/, 'the cancelled day must not be billed for');
  assert.strictEqual(lines.reduce((s, l) => s + l.amount, 0), booking.total_price,
    'the invoice lines do not sum to the total printed on it');
});

test('the camp invoice bills the camp reference and the whole amount', () => {
  const camp = { ...CAMP, rate_per_kid: 84.95, headcount: 20, closed_out_at: '2026-07-19T00:00:00Z' };
  const booking = buildCampInvoiceBooking(camp, week(5));
  // 20 x 84.95 is 1698.9999999999998 in float — it must not print as a
  // balance a cent short of the total.
  assert.strictEqual(booking.total_price, 1699);
  assert.strictEqual(booking.balance_due, 1699);
  assert.strictEqual(booking.deposit_amount, 0, 'a camp takes no deposit — its days do not bill separately');
  assert.strictEqual(booking.reference, 'CAMP-ABC123');
  assert.strictEqual(booking.guest_count, 20);
  assert.strictEqual(booking.event_date, '2026-07-14', 'the invoice dates from the first day that ran');
});
