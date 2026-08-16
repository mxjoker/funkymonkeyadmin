const { test } = require('node:test');
const assert = require('node:assert');
const { normalisePhone, isQuietHours, renderSms, parseLetters } = require('../netlify/functions/_sms.js');

// ── normalisePhone ──────────────────────────────────────────────────────────
// These four formats are all present in the live client_phone column today.
test('every live phone format resolves to one E.164 value', () => {
  for (const raw of ['4055417953', '405-541-7953', '1-405-541-7953', '405.541.7953', '(405) 541-7953', '+14055417953']) {
    assert.strictEqual(normalisePhone(raw), '+14055417953', `failed on ${raw}`);
  }
});

// The deleted _sms.js did `if (digits.length >= 11) return '+' + digits`, which
// turns junk into a plausible-but-wrong number. A wrong number is worse than
// no number: it sends a stranger a client's event details.
test('unusable input returns null, never a plausible number', () => {
  for (const raw of ['', null, undefined, 'TBD', 'none', '405', '5417953', '12345678901234']) {
    assert.strictEqual(normalisePhone(raw), null, `should reject ${JSON.stringify(raw)}`);
  }
});

// ── isQuietHours (America/Chicago, 8am–9pm allowed) ─────────────────────────
// August is CDT (UTC-5). Boundaries are exact, not approximate.
test('quiet hours boundaries are exact', () => {
  assert.strictEqual(isQuietHours(new Date('2026-08-15T12:59:00Z')), true,  '07:59 CDT is quiet');
  assert.strictEqual(isQuietHours(new Date('2026-08-15T13:00:00Z')), false, '08:00 CDT sends');
  assert.strictEqual(isQuietHours(new Date('2026-08-16T01:59:00Z')), false, '20:59 CDT sends');
  assert.strictEqual(isQuietHours(new Date('2026-08-16T02:00:00Z')), true,  '21:00 CDT is quiet');
});

// January is CST (UTC-6). A fixed offset would be an hour wrong for four months.
test('quiet hours follow the DST change', () => {
  assert.strictEqual(isQuietHours(new Date('2026-01-15T13:59:00Z')), true,  '07:59 CST is quiet');
  assert.strictEqual(isQuietHours(new Date('2026-01-15T14:00:00Z')), false, '08:00 CST sends');
});

// ── renderSms ───────────────────────────────────────────────────────────────
// render() in _email.js HTML-escapes every token. Reusing it would text
// O'Brien as "O&#39;Brien".
test('an apostrophe survives as an apostrophe', () => {
  const out = renderSms("Hi {{client_first_name}}!", { client_name: "Siobhan O'Brien" });
  assert.strictEqual(out, "Hi Siobhan!");
  assert.strictEqual(renderSms('{{client_name}}', { client_name: "Siobhan O'Brien" }), "Siobhan O'Brien");
});

test('renderSms fills money, date and review tokens', () => {
  const booking = { client_name: 'Dana Ruiz', service_name: 'Foam Party', event_date: '2026-08-23', balance_due: 250, service_id: 'foam_party' };
  const out = renderSms('{{client_first_name}} owes ${{balance_due}} for {{service_name}} on {{event_date}}', booking);
  assert.strictEqual(out, 'Dana owes $250.00 for Foam Party on Sun, 8/23/2026');
});

test('a deposit of zero is never rendered as a default amount', () => {
  assert.strictEqual(renderSms('${{deposit_amount}}', { deposit_amount: 0 }), '$0.00');
});

// ── Fix 4: {{deposit_link}}, {{payment_link}} and {{finalise_link}} all ─────
// resolve everywhere. renderSms previously only knew {{payment_link}}; an
// email body pasted into the SMS box would text a client the literal string
// "{{deposit_link}}".
test('renderSms also resolves {{deposit_link}}, not just its own {{payment_link}}', () => {
  const booking = { client_name: 'Dana Ruiz', client_email: 'dana@example.com', reference: 'FM-1234' };
  const link = 'https://checkout.stripe.com/c/pay/cs_test_xyz';

  const out = renderSms('{{deposit_link}} {{payment_link}} {{finalise_link}}', booking, link);

  assert.doesNotMatch(out, /{{\w+}}/, 'no template token should survive unresolved');
  assert.ok(out.includes(link), '{{deposit_link}} in an SMS must resolve to the raw URL, not an HTML button');
  assert.match(out, /my-booking\.html/, '{{finalise_link}} must resolve to the finalisation page');
});

// ── parseLetters ────────────────────────────────────────────────────────────
const OFFER = { a: { booking_id: 1, tag_filled: 'Foam Operator' }, b: { booking_id: 1, tag_filled: 'Setup' }, c: { booking_id: 1, tag_filled: 'Driver' } };

test('letter replies parse in every shape people actually type', () => {
  assert.deepStrictEqual(parseLetters('a', OFFER).picked,     ['a']);
  assert.deepStrictEqual(parseLetters('ab', OFFER).picked,    ['a', 'b']);
  assert.deepStrictEqual(parseLetters('AC', OFFER).picked,    ['a', 'c']);
  assert.deepStrictEqual(parseLetters(' a c ', OFFER).picked, ['a', 'c']);
  assert.deepStrictEqual(parseLetters('a, b', OFFER).picked,  ['a', 'b']);
  assert.deepStrictEqual(parseLetters('abc', OFFER).picked,   ['a', 'b', 'c']);
});

test('a repeated letter registers once', () => {
  assert.deepStrictEqual(parseLetters('aa', OFFER).picked, ['a']);
});

test('an unrecognised letter is reported, not silently dropped', () => {
  const r = parseLetters('ad', OFFER);
  assert.deepStrictEqual(r.picked, ['a']);
  assert.deepStrictEqual(r.unknown, ['d']);
  assert.strictEqual(r.freeform, false);
});

test('a sentence is freeform, not a pile of unknown letters', () => {
  const r = parseLetters("sorry can't make it that weekend", OFFER);
  assert.strictEqual(r.freeform, true, 'must be forwarded to Joe, not letter-parsed');
  assert.deepStrictEqual(r.picked, []);
});

test('an empty reply is freeform', () => {
  assert.strictEqual(parseLetters('', OFFER).freeform, true);
  assert.strictEqual(parseLetters('   ', OFFER).freeform, true);
});
