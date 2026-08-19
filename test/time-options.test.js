const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// The Event Time field is a <select> of quarter hours. Building the same list
// the page builds and asserting on it, so a change to the generator that
// reintroduces off-slot minutes fails here rather than in a booking.
function timeOptions() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');
  const expr = src.split('const TIME_OPTIONS = ')[1].split(');\n')[0] + ')';
  return eval(expr); // eslint-disable-line no-eval -- reads the page's own generator
}

test('every option is on a quarter hour', () => {
  const opts = timeOptions();
  assert.strictEqual(opts.length, 96, 'a full day of quarter hours is 96 slots');
  for (const o of opts) {
    assert.ok(['00', '15', '30', '45'].includes(o.v.slice(3)),
      `${o.v} is not on a quarter hour`);
    assert.ok(/^([01]\d|2[0-3]):[0-5]\d$/.test(o.v), `${o.v} is not HH:MM`);
  }
});

test('stored values are 24-hour, labels are 12-hour', () => {
  const opts = timeOptions();
  const at = (v) => opts.find((o) => o.v === v);
  // The DB column is VARCHAR storing "HH:MM"; an option value must match it
  // exactly or the dropdown cannot preselect the booking's current time.
  assert.strictEqual(at('00:00').t, '12:00 AM', 'midnight must not read as 0:00 AM');
  assert.strictEqual(at('12:00').t, '12:00 PM', 'noon must not read as 0:00 PM');
  assert.strictEqual(at('13:45').t, '1:45 PM');
  assert.strictEqual(at('09:15').t, '9:15 AM');
  assert.strictEqual(opts[95].v, '23:45', 'the last slot is 23:45, never 24:00');
});

test('the select still shows a time that matches no slot', () => {
  // Booking 26-152 really is stored as 20:10. bookingField adds an unmatched
  // value as an extra selected option; without that the browser would fall to
  // the empty option and a save would silently blank a real event time.
  const src = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');
  assert.ok(/const unmatched = opts && v && !opts\.some\(o => optValue\(o\) === v\)/.test(src),
    'the unmatched-option fallback is gone — off-slot times would be blanked on save');
});
