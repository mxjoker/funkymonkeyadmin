const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { TEMPLATES } = require('../netlify/functions/_templates.js');

const FN = path.join(__dirname, '../netlify/functions');
const files = fs.readdirSync(FN).filter((f) => f.endsWith('.js'));
const keys = new Set(TEMPLATES.map((t) => t.template_key));

// A mistyped key does not throw: sendTemplate seeds, looks again, finds
// nothing, and returns { sent: false }. The caller logs it and the client
// simply never hears from us — the silent non-delivery this codebase keeps
// producing. Every key any function asks for must exist.
test('every template key a function sends exists in _templates.js', () => {
  for (const f of files) {
    const src = fs.readFileSync(path.join(FN, f), 'utf8');
    for (const m of src.matchAll(/sendTemplate\([^)]*?['"]([a-z_]+)['"]/g)) {
      assert.ok(keys.has(m[1]), `${f} sends template "${m[1]}", which does not exist`);
    }
  }
});

// The reverse: a template nothing sends is either dead copy or a caller that
// stopped calling it. balance_paid_receipt_full/_partial are named through a
// variable, so they are matched on their shared stem.
test('every template has something that sends it', () => {
  const all = files.map((f) => fs.readFileSync(path.join(FN, f), 'utf8')).join('\n');
  for (const t of TEMPLATES) {
    const stem = t.template_key.replace(/_(full|partial)$/, '');
    assert.ok(all.includes(`'${t.template_key}'`) || all.includes(`'${stem}`),
      `nothing sends ${t.template_key}`);
  }
});

// The properties the seed depends on. A row missing one of these lands in the
// database with a NOT NULL violation or in the wrong box in the Automations
// tab, and the grouping there is by sort_order decade.
test('every template is seedable and lands in a group', () => {
  for (const t of TEMPLATES) {
    assert.ok(t.name && t.subject && t.body_html, `${t.template_key} is missing name/subject/body`);
    assert.ok(['manual', 'system'].includes(t.trigger_event),
      `${t.template_key} has trigger_event "${t.trigger_event}" — a trigger loop would pick that up`);
    assert.ok(['client', 'admin', 'staff'].includes(t.recipient), `${t.template_key} has no valid recipient`);
    const decade = Math.floor(t.sort_order / 10);
    assert.ok(decade >= 1 && decade <= 4,
      `${t.template_key} sorts to ${t.sort_order}, which the Automations tab files under "Other"`);
  }
});

test('template keys are unique, or the seed keeps only one of them', () => {
  assert.strictEqual(keys.size, TEMPLATES.length, 'duplicate template_key');
});

// Client-facing money copy. A 5% card-only surcharge would breach the card
// network rules; a service fee on every payment method does not.
test('nothing calls the service fee a card or processing fee', () => {
  for (const t of TEMPLATES) {
    const text = (t.subject + t.body_html + (t.body_sms || '')).toLowerCase();
    for (const word of ['surcharge', 'card fee', 'processing fee', 'convenience fee']) {
      assert.ok(!text.includes(word), `${t.template_key} says "${word}"`);
    }
  }
});

// An admin alert reaching a customer is the failure sendTemplate's recipient
// routing exists to prevent, and these are the ones that would sting.
test('no client template links to the admin dashboard', () => {
  for (const t of TEMPLATES.filter((t) => t.recipient === 'client')) {
    assert.ok(!t.body_html.includes('{{admin_link}}'), `${t.template_key} sends a client to the admin dashboard`);
    assert.ok(!/admin\.html/.test(t.body_html), `${t.template_key} hardcodes an admin.html link`);
  }
});

// The literals are gone from the functions that used to hold them. Each of
// these sent a client-facing email built in code; a new one appearing here
// means the wording drifted back out of the tab.
test('the ported functions no longer build their own client emails', () => {
  for (const f of ['stripe-webhook.js', 'bookings.js', 'finalise.js', 'refund.js',
                   'coi-request.js', 'accept-quote.js', 'create-stripe-link.js',
                   'staff-assignments.js']) {
    const src = fs.readFileSync(path.join(FN, f), 'utf8');
    assert.ok(!/\bsendEmail\(/.test(src), `${f} builds and sends its own email again`);
  }
});

// A realistic row through every template. The failures this catches are the
// ones that reach an inbox looking fine to the code and wrong to a human:
// "Invalid Date" (a Date object where a string was assumed), "$NaN" (a NUMERIC
// string coerced twice), "undefined" (a column that is simply null).
const { render } = require('../netlify/functions/_email.js');
const REAL_ROW = {
  id: 42, reference: 'FM-MUDVW9PM', client_name: 'Corinne Allain',
  client_email: 'corinne@example.com', client_phone: '4055550123',
  service_name: 'Foam Party', event_date: new Date(2026, 8, 12),
  event_time: '2:00 PM', event_zip: '73013', event_location: '12 Maple Ave, Edmond',
  event_type: 'Birthday', guest_count: 40, service_price: '795.00',
  total_price: '845.00', deposit_amount: '100.00', balance_due: '745.00',
  mileage_cost: '30.00', mileage_miles: 12, addons: [{ name: 'Bubbles', price: 50 }],
  notes: 'Gate code 1234', referral_source: 'Facebook', status: 'confirmed',
};

test('no template renders undefined, NaN or an Invalid Date from a real row', () => {
  for (const t of TEMPLATES) {
    const extra = Object.fromEntries((t.extras || []).map((k) => [k, 'X']));
    const out = render(t.body_html, REAL_ROW, 'https://pay.stripe.com/x', extra) +
                render(t.subject, REAL_ROW, 'https://pay.stripe.com/x', extra);
    for (const bad of ['undefined', 'NaN', 'Invalid Date', '[object Object]']) {
      assert.ok(!out.includes(bad), `${t.template_key} renders "${bad}"`);
    }
  }
});
