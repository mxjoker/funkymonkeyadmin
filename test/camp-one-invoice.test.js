const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// One camp, one rate per kid, ONE invoice.
//
// The per-day total_price a close-out writes is an internal allocation — the
// camp's single agreed price split so monthly revenue lands in the right
// months. It is not a price anyone was quoted. Two things follow, and this
// file pins both:
//
//   1. A camp day must never invoice on its own, or a client gets a bill for
//      $566.66 that nobody agreed to.
//   2. If the day set changes after close-out the split stops adding back to
//      the price, and the admin has to be told.

// ── 1. a camp day serves its camp's invoice ───────────────────────────────

function loadInvoiceHandler(fakeClient, { admin = true } = {}) {
  const mods = ['../netlify/functions/generate-invoice.js', '../netlify/functions/_db.js',
                '../netlify/functions/_auth.js', '../netlify/functions/_items.js'];
  for (const m of mods) delete require.cache[require.resolve(m)];
  const dbMod = require('../netlify/functions/_db.js');
  dbMod.withClient = async (fn) => fn(fakeClient);
  const authMod = require('../netlify/functions/_auth.js');
  authMod.requireAuth = async () => (admin ? { role: 'admin' } : null);
  authMod.preflight = () => null;
  return require('../netlify/functions/generate-invoice.js');
}

const CAMP = {
  id: 7, label: 'Funky Monkey Magic Camp', reference: 'CAMP-ABC123',
  client_name: 'The MAC', client_email: 'a@b.com', rate_per_kid: 85, headcount: 20,
  closed_out_at: '2026-07-19T00:00:00Z', created_at: '2026-07-01T00:00:00Z',
};
// A day as close-out leaves it: holding its share, not a price of its own.
const DAY = {
  id: 41, reference: 'FM-DAY1', camp_id: 7, client_email: 'a@b.com',
  event_date: '2026-07-14', status: 'confirmed', total_price: 340, service_price: 340,
  service_name: 'Magic Camp', guest_count: 20, created_at: '2026-07-01T00:00:00Z',
};

function fakeClient(bookings, camps) {
  return {
    async query(sql, params = []) {
      if (/CREATE TABLE|CREATE INDEX|ALTER TABLE/i.test(sql)) return { rows: [] };
      if (/FROM camps WHERE id = \$1/i.test(sql)) return { rows: camps.filter(c => c.id === params[0]) };
      if (/FROM camps WHERE reference = \$1/i.test(sql)) return { rows: camps.filter(c => c.reference === params[0]) };
      if (/FROM bookings WHERE camp_id = \$1/i.test(sql)) return { rows: bookings.filter(b => b.camp_id === params[0]) };
      if (/FROM bookings WHERE reference = \$1/i.test(sql)) return { rows: bookings.filter(b => b.reference === params[0]) };
      if (/FROM bookings WHERE id = \$1/i.test(sql)) return { rows: bookings.filter(b => b.id === params[0]) };
      if (/FROM booking_items/i.test(sql)) return { rows: [] };
      throw new Error('unexpected SQL: ' + sql.trim().split('\n')[0]);
    },
  };
}

const invoiceFor = async (ref, opts) => {
  const days = [DAY, { ...DAY, id: 42, reference: 'FM-DAY2', event_date: '2026-07-15' },
                { ...DAY, id: 43, reference: 'FM-DAY3', event_date: '2026-07-16', total_price: 1020 }];
  const mod = loadInvoiceHandler(fakeClient(days, [CAMP]), opts);
  return mod.handler({ httpMethod: 'GET', path: '/api/generate-invoice/' + ref, queryStringParameters: opts && opts.qs });
};

test('a camp day invoices as its CAMP, not as a day', async () => {
  const res = await invoiceFor('FM-DAY1');
  assert.strictEqual(res.statusCode, 200);
  assert.match(res.headers['Content-Disposition'], /CAMP-ABC123/,
    'the day billed itself instead of its camp');
  assert.doesNotMatch(res.headers['Content-Disposition'], /FM-DAY1/);
});

test('the client sees the same one invoice the admin does', async () => {
  const res = await invoiceFor('FM-DAY1', { admin: false, qs: { email: 'a@b.com' } });
  assert.strictEqual(res.statusCode, 200);
  assert.match(res.headers['Content-Disposition'], /CAMP-ABC123/,
    'a client holding a day reference could bill themselves for one day');
});

test('a day of a camp that is NOT closed out still invoices as itself', async () => {
  const openCamp = { ...CAMP, closed_out_at: null };
  const mod = loadInvoiceHandler(fakeClient([DAY], [openCamp]));
  const res = await mod.handler({ httpMethod: 'GET', path: '/api/generate-invoice/FM-DAY1', queryStringParameters: {} });
  assert.strictEqual(res.statusCode, 200);
  assert.match(res.headers['Content-Disposition'], /FM-DAY1/,
    'before close-out the camp has no price, so the day is the honest answer');
});

test('an ordinary booking is untouched by any of this', async () => {
  const plain = { ...DAY, id: 99, reference: 'FM-PLAIN', camp_id: null };
  const mod = loadInvoiceHandler(fakeClient([plain], []));
  const res = await mod.handler({ httpMethod: 'GET', path: '/api/generate-invoice/FM-PLAIN', queryStringParameters: {} });
  assert.strictEqual(res.statusCode, 200);
  assert.match(res.headers['Content-Disposition'], /FM-PLAIN/);
});

// ── 2. noticing a changed day set ─────────────────────────────────────────

function loadHelpers() {
  const HTML = fs.readFileSync(path.join(__dirname, '../admin.html'), 'utf8');
  const a = HTML.indexOf('// ══ PURE HELPERS');
  const b = HTML.indexOf('// ══ END PURE HELPERS');
  assert.ok(a !== -1 && b !== -1, 'pure-helper sentinels missing from admin.html');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(HTML.slice(a, b) + '\nout = { campNeedsReclose };', ctx);
  return ctx.out;
}
const { campNeedsReclose } = loadHelpers();

const closedCamp = { rate_per_kid: 85, headcount: 20, closed_out_at: '2026-07-19T00:00:00Z' };
const split = (amounts, status = 'confirmed') => amounts.map(t => ({ total_price: t, status }));

test('a camp still square says nothing', () => {
  assert.strictEqual(campNeedsReclose(closedCamp, split([340, 340, 340, 340, 340])), null);
  assert.strictEqual(campNeedsReclose(closedCamp, split([566.66, 566.66, 566.68])), null,
    'the uneven split is square too — the remainder is part of the total');
});

test('a camp that was never closed out says nothing', () => {
  assert.strictEqual(campNeedsReclose({ ...closedCamp, closed_out_at: null }, split([0, 0, 0])), null);
  assert.strictEqual(campNeedsReclose(null, []), null);
});

// The one that actually loses money: revenue queries exclude cancelled rows,
// so that day's share silently vanishes from every total.
test('cancelling a day after close-out is caught, and names the stranded money', () => {
  const days = [...split([340, 340, 340, 340]), ...split([340], 'cancelled')];
  const r = campNeedsReclose(closedCamp, days);
  assert.ok(r, 'a cancelled day walked off with $340 and nothing noticed');
  assert.strictEqual(r.expected, 1700);
  assert.strictEqual(r.allocated, 1360);
  assert.strictEqual(r.orphaned, 340);
});

test('adding a day after close-out is caught', () => {
  const r = campNeedsReclose(closedCamp, split([340, 340, 340, 340, 340, 0]));
  assert.ok(r, 'a new day joined at $0 and the split is now a lie');
  assert.strictEqual(r.allocated, 1700);
  assert.strictEqual(r.day_count, 6);
});

test('a re-close settles it', () => {
  const stale = campNeedsReclose(closedCamp, split([340, 340, 340, 340, 340, 0]));
  assert.ok(stale);
  // What closing out again produces: 1700 over 6 days.
  const { splitAcrossDays } = require('../netlify/functions/camps.js');
  const parts = splitAcrossDays(1700, 6);
  assert.strictEqual(campNeedsReclose(closedCamp, split(parts)), null,
    'closing out again did not settle the camp');
});

test('float round-tripping is not mistaken for a changed day set', () => {
  // 3 x 566.666... is what NUMERIC/float round-tripping can hand back.
  assert.strictEqual(campNeedsReclose({ rate_per_kid: 84.95, headcount: 20, closed_out_at: 'x' },
    split([566.33, 566.33, 566.34])), null);
});
