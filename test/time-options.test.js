const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');

// Event time is three selects (hour, minute, AM/PM) over a hidden input that
// holds the 24h "HH:MM" the VARCHAR column stores. syncTimeField does the
// composing, so it is the thing worth testing — a 12-hour clock has two hours
// that break naive arithmetic, and getting either wrong moves a gig by twelve
// hours while looking entirely reasonable on screen.
function loadTimeField() {
  const src = HTML.slice(HTML.indexOf('const MINUTE_OPTIONS'), HTML.indexOf('function bookingField'));
  const parts = {};
  const ctx = {
    esc: (x) => String(x == null ? '' : x),
    document: {
      getElementById: (id) => parts[id] || null
    }
  };
  vm.createContext(ctx);
  vm.runInContext(src + '\nout = { timeSelects, syncTimeField, MINUTE_OPTIONS };', ctx);
  return { ...ctx.out, parts };
}

const { timeSelects, syncTimeField, MINUTE_OPTIONS, parts } = loadTimeField();

// Drives syncTimeField the way the browser would.
function compose(h, m, a) {
  parts['tf-h-event_time'] = { value: h };
  parts['tf-m-event_time'] = { value: m };
  parts['tf-a-event_time'] = { value: a };
  parts['tf-v-event_time'] = { value: 'UNSET' };
  parts['tf-warn-event_time'] = { textContent: '' };
  syncTimeField('event_time');
  return { value: parts['tf-v-event_time'].value, warn: parts['tf-warn-event_time'].textContent };
}

test('the minute options are only quarter hours', () => {
  // Arrays built inside the vm carry that realm's prototype, so deepStrictEqual
  // rejects them as "same structure, not reference-equal" — round-trip first.
  assert.deepStrictEqual(JSON.parse(JSON.stringify(MINUTE_OPTIONS)), ['00', '15', '30', '45']);
});

test('midnight and noon compose correctly', () => {
  // The two that break `hour + (pm ? 12 : 0)`. 12 AM is 00, not 12 or 24.
  assert.strictEqual(compose('12', '00', 'AM').value, '00:00');
  assert.strictEqual(compose('12', '30', 'AM').value, '00:30');
  assert.strictEqual(compose('12', '00', 'PM').value, '12:00');
  assert.strictEqual(compose('12', '45', 'PM').value, '12:45');
});

test('ordinary times compose correctly', () => {
  assert.strictEqual(compose('9', '15', 'AM').value, '09:15');
  assert.strictEqual(compose('1', '45', 'PM').value, '13:45');
  assert.strictEqual(compose('11', '45', 'PM').value, '23:45');
});

test('a missing AM/PM saves nothing and says so', () => {
  // 2:30 with no meridiem is genuinely ambiguous. Guessing is a twelve-hour
  // error on a gig start that looks perfectly plausible on the booking.
  const r = compose('2', '30', '');
  assert.strictEqual(r.value, '', 'an ambiguous time must not be stored');
  assert.match(r.warn, /AM or PM/, 'the reason must be shown, not swallowed');
});

test('a missing minute fills 00 rather than nagging', () => {
  // Unambiguous, unlike the meridiem — on the hour is the only reading.
  const r = compose('3', '', 'PM');
  assert.strictEqual(r.value, '15:00');
  assert.strictEqual(r.warn, '');
});

test('clearing every part clears the value', () => {
  const r = compose('', '', '');
  assert.strictEqual(r.value, '', 'blanking the selects must clear the time, not set midnight');
  assert.strictEqual(r.warn, '');
});

test('an off-slot stored minute stays selectable', () => {
  // Booking 26-152 is stored as 20:10. If 10 were dropped from the options the
  // browser would fall to another value and saving anything on that booking
  // would silently move its start time.
  const html = timeSelects('event_time', '20:10');
  assert.ok(/<option value="10" selected>/.test(html), 'off-slot minute lost from the options');
  assert.ok(/<option value="8" selected>/.test(html), '20:10 should select hour 8');
  assert.ok(/<option value="PM" selected>/.test(html), '20:10 should select PM');
});

test('an empty time renders nothing preselected', () => {
  const html = timeSelects('event_time', '');
  assert.ok(!/selected/.test(html.replace(/value=""[^>]*selected/g, '')),
    'an empty time must not preselect an hour or meridiem');
});
