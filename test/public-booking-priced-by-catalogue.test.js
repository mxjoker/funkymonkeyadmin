const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { catalogueQuote } = require('../netlify/functions/bookings.js');

// Until 2026-09-28 a public booking stored whatever prices the browser posted.
// The form reads the same catalogue, so honest requests are unaffected; what
// this pins is that a posted figure is never the one we keep.
const FOAM = { service_id: 'foam_double', name: 'Foam Party — Double Cannon', price: '535.00',
               extra_hour_rate: '150.00', is_quote: false, active: true };
const ADDONS = [
  { addon_id: 'pb_kiosk', name: 'Photo Booth Kiosk', price: '250.00', active: true },
  { addon_id: 'retired',  name: 'Old thing',         price: '99.00',  active: false },
];

test('the catalogue prices it, whatever the request says', () => {
  const q = catalogueQuote(FOAM, ADDONS, {
    service_price: 1, total_price: 1, deposit_amount: 1, extra_hours: 2,
    addons: [{ id: 'pb_kiosk', name: 'Photo Booth Kiosk', price: 0 }],
  });
  assert.strictEqual(q.servicePrice, 535);
  assert.strictEqual(q.extraHoursCost, 300);
  assert.deepStrictEqual(q.addons, [{ id: 'pb_kiosk', name: 'Photo Booth Kiosk', price: 250 }]);
  assert.strictEqual(q.totalPrice, 1085, 'service + extra hours + add-ons; travel stays out of total_price');
  assert.strictEqual(q.depositAmount, 100, 'a posted $1 deposit is ignored');
});

test('an inactive, unknown or made-up add-on is dropped, not priced', () => {
  const q = catalogueQuote(FOAM, ADDONS, { addons: [{ id: 'retired' }, { id: 'nope', price: 5 }, null] });
  assert.deepStrictEqual(q.addons, []);
  assert.strictEqual(q.addonTotal, 0);
});

test('extra hours only exist where the catalogue has a rate, and are bounded', () => {
  assert.strictEqual(catalogueQuote({ ...FOAM, extra_hour_rate: null }, [], { extra_hours: 3 }).extraHoursCost, 0);
  assert.strictEqual(catalogueQuote(FOAM, [], { extra_hours: 500 }).extraHours, 12);
  assert.strictEqual(catalogueQuote(FOAM, [], { extra_hours: -4 }).extraHours, 0);
});

test('a quote-only service books at zero, and a switched-off one cannot be booked', () => {
  const q = catalogueQuote({ ...FOAM, is_quote: true }, [], {});
  assert.strictEqual(q.isQuote, true);
  assert.strictEqual(q.totalPrice, 0);
  assert.ok(catalogueQuote({ ...FOAM, active: false }, [], {}).error);
  assert.ok(catalogueQuote(undefined, [], {}).error);
});

test('only an admin keeps posted prices', () => {
  const src = fs.readFileSync(path.join(__dirname, '../netlify/functions/bookings.js'), 'utf8');
  assert.ok(/if \(!adminAuth\) \{\s*const \[\{ rows: svcRows \}, \{ rows: addonRows \}\]/.test(src),
    'the public path re-prices from the catalogue');
  assert.ok(/JSON\.stringify\(addons\)/.test(src), 'the stored add-ons are the priced ones, not the posted ones');
});
