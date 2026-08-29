const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// The referral list exists in two files: REFERRAL_SOURCES in admin.html (what
// Joe picks from when taking a booking by phone) and the <select id="c-ref">
// in booking-form.html (what the client picks from). They must hold the same
// strings in the same order.
//
// Not a style preference. Analytics groups its Source breakdown on the raw
// string, so a value that exists on one side and not the other silently
// fragments the chart — admin.html's own comment says exactly this, and until
// now nothing enforced it. Two lists a thousand lines apart in different files
// is precisely the shape that drifts, and the drift is invisible: both pages
// keep working, the chart just quietly splits one source into two.

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

function adminSources() {
  const m = read('admin.html').match(/const REFERRAL_SOURCES = \[([\s\S]*?)\];/);
  assert.ok(m, 'REFERRAL_SOURCES not found in admin.html');
  // Strip the // comment lines before pulling quoted strings out.
  const body = m[1].split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  return [...body.matchAll(/'([^']+)'/g)].map(x => x[1]);
}

function formSources() {
  const sel = read('booking-form.html').match(/<select id="c-ref">([\s\S]*?)<\/select>/);
  assert.ok(sel, '<select id="c-ref"> not found in booking-form.html');
  return [...sel[1].matchAll(/<option(?: value="[^"]*")?>([^<]+)<\/option>/g)]
    .map(x => x[1].trim())
    .filter(v => v && v !== 'Select…');
}

test('the two referral lists hold the same values in the same order', () => {
  assert.deepStrictEqual(formSources(), adminSources());
});

test('both lists end with Other, so a new source is never appended after the catch-all', () => {
  assert.strictEqual(adminSources().at(-1), 'Other');
  assert.strictEqual(formSources().at(-1), 'Other');
});

test('the three performer-specific sources are present', () => {
  // "Seen a Performance" is the one that matters: someone booking because they
  // watched Joe work is the highest-intent lead there is, and it used to be
  // indistinguishable from "Other".
  for (const v of ['Seen a Performance', 'Promoter / Agency', 'ChatGPT / AI']) {
    assert.ok(adminSources().includes(v), `admin.html is missing "${v}"`);
    assert.ok(formSources().includes(v), `booking-form.html is missing "${v}"`);
  }
});

test('no duplicates in either list', () => {
  for (const [name, list] of [['admin.html', adminSources()], ['booking-form.html', formSources()]]) {
    assert.strictEqual(new Set(list).size, list.length, `${name} has a duplicate source`);
  }
});
