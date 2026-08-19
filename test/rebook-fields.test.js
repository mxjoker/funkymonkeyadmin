const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// duplicateBooking() copies a past booking into a new draft. What it must NOT
// copy is the part with teeth, so it is pinned here rather than left to review.
function rebookFields() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');
  const block = src.split('const REBOOK_FIELDS = [')[1].split('];')[0];
  return [...block.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

test('a rebook never copies SMS consent', () => {
  // Consent is per booking: it was given for one event, on one form, with the
  // disclosures beside it. Carrying it into a new booking would text someone
  // who never agreed to be texted about this one — the exact thing the 10DLC
  // campaign was rejected for the first time round.
  const fields = rebookFields();
  for (const f of ['sms_consent', 'sms_consent_at', 'sms_consent_text']) {
    assert.ok(!fields.includes(f), `a rebook must not copy ${f}`);
  }
});

test('a rebook never copies a payment link or paid state', () => {
  // A copied deposit link points at the OLD booking's Stripe session and stays
  // re-payable forever, so paying it bills the wrong booking. Paid state would
  // mark a brand-new booking as already settled.
  const fields = rebookFields();
  for (const f of ['stripe_payment_link', 'stripe_balance_link', 'stripe_session_id',
                   'stripe_payment_intent_id', 'deposit_paid', 'deposit_paid_at',
                   'payment_amount', 'payment_ref', 'balance_due']) {
    assert.ok(!fields.includes(f), `a rebook must not copy ${f}`);
  }
});

test('a rebook never copies identity or date fields', () => {
  const fields = rebookFields();
  for (const f of ['id', 'reference', 'event_date', 'event_time', 'status', 'created_at']) {
    assert.ok(!fields.includes(f), `a rebook must not copy ${f}`);
  }
});

test('a rebook still copies the things that make it worth doing', () => {
  const fields = rebookFields();
  for (const f of ['client_name', 'client_email', 'service_name', 'event_location', 'items']) {
    assert.ok(fields.includes(f), `a rebook should copy ${f}`);
  }
});
