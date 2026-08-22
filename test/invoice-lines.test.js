const { test } = require('node:test');
const assert = require('node:assert');
const { buildInvoiceLines, invoiceDiscountTotal } = require('../netlify/functions/generate-invoice.js');
const { rollupItems } = require('../netlify/functions/_items.js');

const ITEMS = [
  { name: 'Foam Party — Double Cannon', price: 535, quantity: 1, kind: 'service' },
  { name: 'Magic School Assembly',      price: 385, quantity: 1, kind: 'service' },
  { name: 'Repeat client 10%',          price: 92,  quantity: 1, kind: 'discount' },
  { name: 'Travel (12 miles)',          price: 30,  quantity: 1, kind: 'travel' },
];

// The invoice is the document a client checks a bill against. A discount that
// printed positive beside a total that went down is the arithmetic they ring
// up about.
test('a discount prints as a negative line', () => {
  const line = buildInvoiceLines({ items: ITEMS }).find(l => l.discount);
  assert.strictEqual(line.amount, -92);
  assert.strictEqual(line.label, 'Repeat client 10%');
  assert.strictEqual(line.primary, false, 'a discount must not be styled as a headline service');
});

// The whole point of showing the line: the page has to add up.
test('the printed lines reconcile with the stored total', () => {
  const roll = rollupItems(ITEMS.map((i, n) => ({ ...i, sort_order: n })));
  const lines = buildInvoiceLines({ items: ITEMS });
  const printed = lines.reduce((s, l) => s + l.amount, 0);
  assert.strictEqual(printed, roll.total_price + roll.mileage_cost,
    'the lines on the invoice do not sum to what the booking says it costs');
});

test('the subtotal and the discount restore the pre-discount figure', () => {
  const roll = rollupItems(ITEMS.map((i, n) => ({ ...i, sort_order: n })));
  const discount = invoiceDiscountTotal({ items: ITEMS });
  assert.strictEqual(discount, 92);
  assert.strictEqual(roll.total_price + discount, 920, 'Subtotal on the invoice would be wrong');
});

test('a quantity multiplies a discount line the same way it multiplies a service', () => {
  const lines = buildInvoiceLines({ items: [{ name: 'Per referral', price: 25, quantity: 3, kind: 'discount' }] });
  assert.strictEqual(lines[0].amount, -75);
  assert.strictEqual(invoiceDiscountTotal({ items: [{ name: 'x', price: 25, quantity: 3, kind: 'discount' }] }), 75);
});

test('a booking with no discount prints no subtotal', () => {
  assert.strictEqual(invoiceDiscountTotal({ items: ITEMS.filter(i => i.kind !== 'discount') }), 0);
  assert.strictEqual(invoiceDiscountTotal({}), 0);
});

// The pre-items fallback path. These bookings predate booking_items and can
// never carry a discount, but they must still render.
test('a legacy booking with no items still builds its lines', () => {
  const lines = buildInvoiceLines({
    service_name: 'Foam Party', service_price: 400,
    addons: [{ name: 'Bubbles', price: 50 }], mileage_cost: 30, mileage_miles: 12,
  });
  assert.deepStrictEqual(lines.map(l => l.amount), [400, 50, 30]);
  assert.strictEqual(lines[0].primary, true);
  assert.ok(lines.every(l => !l.discount), 'a legacy booking cannot have a discount');
});
