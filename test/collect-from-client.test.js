const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { collectFromClient, balanceCharge } = require('../netlify/functions/_items.js');

// What the crew ask the client for at the door. Two screens print this — the
// calendar feed and the staff portal — and they must never disagree, so the
// rule lives in one function and both read it.

test('the figure is the balance, never the balance plus the service fee', () => {
  // The 5% exists only on a Stripe checkout session (_items.js SERVICE_FEE_RATE).
  // Collecting it in cash takes money we cannot account for and have no way to
  // refund.
  assert.strictEqual(collectFromClient({ balance_due: 745 }).amount, 745);
  assert.strictEqual(balanceCharge({ balance_due: 745 }).total, 782.25,
    'the card figure, for contrast');
});

test('a NUMERIC string from pg is money, not text', () => {
  // balance_due comes back as a string unless a query casts it.
  assert.strictEqual(collectFromClient({ balance_due: '745.00' }).amount, 745);
});

test('a platform booking is never collected from', () => {
  // GigSalad took the client\'s money and added its own fees. Asking for a
  // balance bills them twice for one gig — and a crew member standing in a
  // living room has no way to know that.
  const r = collectFromClient({ balance_due: 800, source: 'gigsalad' });
  assert.strictEqual(r.amount, 0);
  assert.match(r.note, /Paid through GigSalad/);
});

test('settled, unpriced and platform-paid are distinguishable, not all "$0"', () => {
  // A crew member acts on the difference: "paid in full" is settled, "not
  // priced yet" means nobody should be inventing a figure at the door.
  const note = (row) => collectFromClient(row).note;
  assert.match(note({ balance_due: 0 }), /Paid in full/);
  assert.match(note({ balance_due: null }), /Not priced yet/);
  assert.match(note({}), /Not priced yet/);
  assert.notStrictEqual(note({ balance_due: 0 }), note({ balance_due: null }));
});

test('junk never becomes a demand for money', () => {
  for (const v of ['abc', NaN, Infinity, -50]) {
    assert.strictEqual(collectFromClient({ balance_due: v }).amount, 0, String(v));
  }
});

// ── The staff portal must not leak it to someone who only raised a hand ─────
// staff-assignments.js strips client contact and money from a gig whose
// assignment is not yet 'assigned'. The collect fields carry the same money
// and had to join that list; a test pins it because the redaction is a
// destructure, and a field added to the row but not to the destructure walks
// straight through.
test('collect_amount and collect_note are redacted alongside balance_due', () => {
  const src = fs.readFileSync(path.join(__dirname, '../netlify/functions/staff-assignments.js'), 'utf8');
  const m = src.match(/const \{([^}]*)\.\.\.safe \} = g;/);
  assert.ok(m, 'the non-assigned redaction is gone — has the portal stopped hiding client money?');
  for (const field of ['balance_due', 'collect_amount', 'collect_note']) {
    assert.ok(m[1].includes(field), `${field} is not redacted for a non-assigned gig`);
  }
});
