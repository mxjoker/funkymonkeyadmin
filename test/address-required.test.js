const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { addressLooksComplete } = require('../netlify/functions/_address.js');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

// "Edmond" was in event_location on a real booking (2026-08-20). It is a town,
// and a crew driving to it has nowhere to go.
test('a town or a venue name is not an address', () => {
  for (const bad of ['Edmond', 'Home', 'OKC', 'grandmas house', 'the park']) {
    assert.strictEqual(addressLooksComplete(bad).ok, false, `"${bad}" passed as an address`);
    assert.strictEqual(addressLooksComplete(bad).reason, 'no_number');
  }
});

test('an empty address is reported as missing, not as malformed', () => {
  // The two are handled differently everywhere: missing blocks, malformed warns.
  assert.strictEqual(addressLooksComplete('').reason, 'missing');
  assert.strictEqual(addressLooksComplete('   ').reason, 'missing');
  assert.strictEqual(addressLooksComplete(null).reason, 'missing');
});

test('a bare ZIP is not an address either', () => {
  assert.strictEqual(addressLooksComplete('73013').reason, 'too_short');
});

// Deliberately permissive. Every one of these is a real address someone will
// type, and rejecting one at the checkout button costs a booking.
test('real addresses pass, including the awkward ones', () => {
  for (const good of [
    '2636 NW 56th St OKC',
    '12 Maple Ave, Edmond',
    'The MAC, 2701 W Danforth Rd',
    'corner of 5th and Main',
    '1 Rural Route 3, Guthrie OK 73044',
  ]) {
    assert.strictEqual(addressLooksComplete(good).ok, true, `"${good}" was rejected`);
  }
});

// ── The three copies ────────────────────────────────────────────────────────
// admin.html and my-booking.html are static pages with no shared import. Three
// implementations of one rule is how a client is told an address is fine on one
// page and refused on another.
// Brace-matched from the function keyword, so the extraction does not depend
// on how the file happens to be indented around it.
function extract(file) {
  const html = read(file);
  const start = html.indexOf('function addressLooksComplete');
  assert.ok(start !== -1, `addressLooksComplete is gone from ${file}`);
  let depth = 0, i = html.indexOf('{', start), end = -1;
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  assert.ok(end !== -1, `could not find the end of addressLooksComplete in ${file}`);
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(html.slice(start, end) + '\nout = addressLooksComplete;', ctx);
  return ctx.out;
}

test('all three copies of the rule agree, verdict for verdict', () => {
  const copies = { 'admin.html': extract('admin.html'), 'my-booking.html': extract('my-booking.html') };
  const cases = ['', '   ', 'Edmond', '73013', '2636 NW 56th St OKC', 'The MAC, 2701 W Danforth Rd', 'Home'];
  for (const [file, fn] of Object.entries(copies)) {
    for (const c of cases) {
      // Spread into this realm's Object: a value built inside a vm context has
      // a different prototype, and deepStrictEqual compares those too.
      assert.deepStrictEqual({ ...fn(c) }, { ...addressLooksComplete(c) },
        `${file} disagrees with _address.js on ${JSON.stringify(c)}`);
    }
  }
});

// ── Where it is mandatory ───────────────────────────────────────────────────
// One place only: the button that takes money. A paid deposit is a gig on the
// calendar, and that gig needs somewhere to be.
test('checkout is refused when the booking has no address', () => {
  const src = read('netlify/functions/finalise.js');
  const block = src.slice(src.indexOf("body.action === 'pay_link'"), src.indexOf('const deposit ='));
  assert.match(block, /booking\.event_location/, 'pay_link no longer checks for an address');
  assert.match(block, /field: 'event_location'/, 'the refusal should name the field so the page can focus it');
  // Emptiness only. Refusing a real rural address at the checkout button would
  // cost a booking to save a typo.
  assert.ok(!/addressLooksComplete/.test(block),
    'the shape check must not gate payment — it is a warning, not a rule');
});

test('the client page asks before spending a round trip on a refusal', () => {
  const page = read('my-booking.html');
  const pay = page.slice(page.indexOf('async function payDeposit'), page.indexOf('async function saveBooking'));
  assert.match(pay, /currentBooking\.event_location/, 'the page no longer checks the address before paying');
  assert.match(pay, /Save My Details/, 'the client must be told the address has to be SAVED, not just typed');
});

test('saving is blocked on a missing address but never on a malformed one', () => {
  const page = read('my-booking.html');
  const save = page.slice(page.indexOf('async function saveBooking'),
                          page.indexOf('async function saveBooking') + 1400);
  assert.match(save, /verdict\.reason === 'missing'/,
    'saving must block on an empty address and only on an empty one');
});
