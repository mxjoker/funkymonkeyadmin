const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const HTML = fs.readFileSync(path.join(__dirname, '../admin.html'), 'utf8');

function extract(sig) {
  const a = HTML.indexOf(sig);
  assert.ok(a !== -1, sig + ' missing from admin.html');
  // Functions here are top-level, so the first column-0 '}' closes them.
  const b = HTML.indexOf('\n}\n', a) + 3;
  return HTML.slice(a, b);
}

const ctx = {};
vm.createContext(ctx);
vm.runInContext(extract('function parseDate(') + extract('function setPayrollRange(') +
  '\nout = { parseDate, setPayrollRange };', ctx);
const { parseDate, setPayrollRange } = ctx.out;

// Neon serialises a DATE column as UTC midnight. new Date() on that renders the
// PREVIOUS day anywhere west of Greenwich — a Sep 7 gig showed as "Sun, Sep 6"
// in the pay review, so gigs didn't line up with the pay period.
test('a DATE column renders as its own day, not the day before', () => {
  const d = parseDate('2026-09-07T00:00:00.000Z');
  assert.strictEqual(d.getDate(), 7);
  assert.strictEqual(d.toLocaleDateString('en-US', { weekday: 'short' }), 'Mon');
});

// toISOString() is UTC, so building the range from it pushed Mon–Sun a day
// forward for anyone loading the page after ~7pm CDT.
test('This Week is the local Mon–Sun, whatever the clock says', () => {
  const els = { 'payroll-date-from': {}, 'payroll-date-to': {} };
  ctx.document = { getElementById: id => els[id] };

  for (const hour of [0, 8, 23]) {
    const now = new Date(2026, 8, 13, hour, 30); // Sun Sep 13 2026, local
    ctx.Date = class extends Date {
      constructor(...a) { super(...(a.length ? a : [now])); }
    };
    setPayrollRange('week');
    assert.strictEqual(els['payroll-date-from'].value, '2026-09-07', `from @${hour}h`);
    assert.strictEqual(els['payroll-date-to'].value, '2026-09-13', `to @${hour}h`);
  }
});
