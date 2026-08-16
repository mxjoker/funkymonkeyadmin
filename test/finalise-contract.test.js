const { test } = require('node:test');
const assert = require('node:assert');
const { CLIENT_EDITABLE, sanitiseClientEdit, zipChanged } = require('../netlify/functions/_finalise.js');

// The whitelist IS the security boundary. This test exists so that adding a
// field to it is a deliberate act with a visible diff, never a side effect.
test('the client-editable whitelist is exactly these fields', () => {
  assert.deepStrictEqual([...CLIENT_EDITABLE].sort(), [
    'child_name', 'client_email', 'client_name', 'client_phone',
    'event_location', 'event_time', 'event_zip', 'guest_count',
    'guests_of_honour', 'notes', 'surface_type', 'venue',
  ]);
});

// Every one of these has moved a price or a workflow in this system before.
test('money and workflow fields are rejected, never silently dropped', () => {
  const r = sanitiseClientEdit({
    client_name: 'Dana Ruiz',
    total_price: 1, deposit_amount: 0, balance_due: 0, service_price: 1,
    mileage_cost: 0, items: [], status: 'confirmed', deposit_paid: true,
    admin_notes: 'x', reference: 'FM-OTHER', id: 99,
  });
  assert.deepStrictEqual(Object.keys(r.fields), ['client_name']);
  assert.ok(r.rejected.includes('total_price'));
  assert.ok(r.rejected.includes('status'));
  assert.ok(r.rejected.includes('deposit_paid'));
  assert.ok(r.rejected.includes('reference'), 'the reference is the auth key and must never be writable');
  assert.ok(r.rejected.includes('id'));
});

test('an allowed field passes through untouched', () => {
  const r = sanitiseClientEdit({ notes: 'Garden is on a slope', guest_count: 24 });
  assert.deepStrictEqual(r.fields, { notes: 'Garden is on a slope', guest_count: 24 });
  assert.deepStrictEqual(r.rejected, []);
});

// An empty submit must be distinguishable from a rejected one, so the caller
// can answer "nothing changed" rather than reporting a success that did nothing.
test('an empty body yields no fields and no rejections', () => {
  assert.deepStrictEqual(sanitiseClientEdit({}), { fields: {}, rejected: [] });
  assert.deepStrictEqual(sanitiseClientEdit(null), { fields: {}, rejected: [] });
});

// guest_count drives per-guest pricing on some add-ons. It is editable because
// it genuinely changes, but it must arrive as a number.
test('guest_count is coerced to a number and rejected when it is not one', () => {
  assert.strictEqual(sanitiseClientEdit({ guest_count: '24' }).fields.guest_count, 24);
  const bad = sanitiseClientEdit({ guest_count: 'lots' });
  assert.ok(!('guest_count' in bad.fields));
  assert.ok(bad.rejected.includes('guest_count'));
});

// client_email is half the auth key. A malformed one locks the client out AND
// sends the re-issued link nowhere, so it never reaches the database.
test('a malformed email is rejected rather than stored', () => {
  for (const bad of ['notanemail', 'no@domain', 'two @spaces.com', '', '@x.com']) {
    const r = sanitiseClientEdit({ client_email: bad });
    assert.ok(!('client_email' in r.fields), `should reject ${JSON.stringify(bad)}`);
    assert.ok(r.rejected.includes('client_email'));
  }
});

// Stored lowercase because authenticate() compares lowercased. Storing "Dana@
// Example.com" verbatim would authenticate fine today and break the moment
// anything compares it case-sensitively.
test('an accepted email is normalised to lowercase and trimmed', () => {
  assert.strictEqual(sanitiseClientEdit({ client_email: '  Dana@Example.COM ' }).fields.client_email, 'dana@example.com');
});

// ── zipChanged ──────────────────────────────────────────────────────────────
test('a real ZIP change is reported with both values', () => {
  const r = zipChanged({ event_zip: '73120' }, { event_zip: '73072' });
  assert.strictEqual(r.changed, true);
  assert.strictEqual(r.from, '73120');
  assert.strictEqual(r.to, '73072');
});

test('an unchanged ZIP is not a change', () => {
  assert.strictEqual(zipChanged({ event_zip: '73120' }, { event_zip: '73120' }).changed, false);
});

// A booking that never had a ZIP gaining one is the finalisation working as
// intended, not a re-quote trigger.
test('filling in a ZIP that was empty is not a change worth alerting on', () => {
  assert.strictEqual(zipChanged({ event_zip: '' }, { event_zip: '73120' }).changed, false);
  assert.strictEqual(zipChanged({ event_zip: null }, { event_zip: '73120' }).changed, false);
});

test('a ZIP+4 matching the stored five digits is not a change', () => {
  assert.strictEqual(zipChanged({ event_zip: '73120' }, { event_zip: '73120-4455' }).changed, false);
});

// ── Fix 1: guest_count type validation ───────────────────────────────────
// Number('') and Number(null) are both 0, which silently zeros pricing.
// An empty box is absence and omitted; anything else non-numeric is rejected.
test('an empty guest_count is omitted without rejection', () => {
  const r = sanitiseClientEdit({ guest_count: '', notes: 'A' });
  assert.deepStrictEqual(r.fields, { notes: 'A' });
  assert.deepStrictEqual(r.rejected, []);
});

test('guest_count rejects null, false, true, arrays, and objects', () => {
  for (const bad of [null, false, true, [], {}]) {
    const r = sanitiseClientEdit({ guest_count: bad });
    assert.ok(!('guest_count' in r.fields), `should reject ${JSON.stringify(bad)}`);
    assert.ok(r.rejected.includes('guest_count'));
  }
});

// ── Fix 2: text field type validation ────────────────────────────────────
// node-postgres would stringify an object into a TEXT column rather than
// rejecting it, so objects and arrays land looking plausible.
test('text fields reject arrays and objects', () => {
  const textFields = ['client_name', 'client_phone', 'event_time', 'event_location', 'venue', 'surface_type', 'child_name', 'guests_of_honour', 'notes', 'event_zip'];
  for (const field of textFields) {
    for (const bad of [['array'], { evil: 1 }]) {
      const r = sanitiseClientEdit({ [field]: bad });
      assert.ok(!(field in r.fields), `should reject ${field} = ${JSON.stringify(bad)}`);
      assert.ok(r.rejected.includes(field));
    }
  }
});

test('a genuine text field with an object in a string still passes', () => {
  const r = sanitiseClientEdit({ notes: '{"not": "code"}' });
  assert.deepStrictEqual(r.fields, { notes: '{"not": "code"}' });
  assert.deepStrictEqual(r.rejected, []);
});

// ── Fix 3: email regex tightened ─────────────────────────────────────────
test('an email with a quote in the local part is rejected', () => {
  const r = sanitiseClientEdit({ client_email: '"bad@example.com' });
  assert.ok(!('client_email' in r.fields));
  assert.ok(r.rejected.includes('client_email'));
});

test('legitimate emails with tags and subdomains still pass', () => {
  for (const good of ['a+tag@sub.example.co.uk', 'o.brien@example.com', 'dana@example.com', 'a.b_c%d@x-y.io']) {
    const r = sanitiseClientEdit({ client_email: good });
    assert.ok('client_email' in r.fields, `should accept ${good}`);
    assert.ok(!r.rejected.includes('client_email'));
  }
});
