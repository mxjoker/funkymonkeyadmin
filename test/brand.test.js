const { test } = require('node:test');
const assert = require('node:assert');
const { normaliseBrand } = require('../netlify/functions/bookings');

// ── Why this is tested ──────────────────────────────────────────────────────
// The business is one company (FME) with JCM as Joe's premium tier and FMMS
// taking lower-paid magic work so it does not erode JCM's rates. A brand field
// that silently collapses to 'fme' destroys exactly the distinction that
// protects those rates — and it does so invisibly, which is this codebase's
// recurring defect. The old bookings.js:412 read
//   b.brand === 'jcm' ? 'jcm' : 'fme'
// so every unrecognised value, including a future 'fmms', became 'fme'.

test('each real brand survives unchanged', () => {
  assert.strictEqual(normaliseBrand('fme'), 'fme');
  assert.strictEqual(normaliseBrand('jcm'), 'jcm');
  assert.strictEqual(normaliseBrand('fmms'), 'fmms');
});

test('case and surrounding space do not matter', () => {
  assert.strictEqual(normaliseBrand('  JCM '), 'jcm');
  assert.strictEqual(normaliseBrand('FMMS'), 'fmms');
});

test('an absent brand defaults to fme', () => {
  // Matches the column default and every historical row.
  assert.strictEqual(normaliseBrand(''), 'fme');
  assert.strictEqual(normaliseBrand(null), 'fme');
  assert.strictEqual(normaliseBrand(undefined), 'fme');
  assert.strictEqual(normaliseBrand('   '), 'fme');
});

test('an unrecognised brand throws instead of becoming fme', () => {
  // A typo'd brand is a revenue-attribution error. The previous behaviour
  // made it invisible; this makes it loud at the boundary.
  assert.throws(() => normaliseBrand('jmc'), /unknown brand/i);
  assert.throws(() => normaliseBrand('funky'), /unknown brand/i);
  assert.throws(() => normaliseBrand('FME '.repeat(3)), /unknown brand/i);
});

test('the thrown message names the offending value', () => {
  // The 400 handed back to the caller quotes this, so it has to be useful.
  assert.throws(() => normaliseBrand('jmc'), /jmc/);
});

test('the old silent coercion is gone from the source', () => {
  // Guards the specific line, not just the helper: re-introducing the ternary
  // anywhere in the insert path would restore the silent failure while every
  // test above still passed.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'netlify', 'functions', 'bookings.js'), 'utf8'
  );
  // Strip whole-line // comments before scanning: the fix's own comment quotes
  // the old ternary to explain what it did, and a naive scan flags that prose
  // as if it were live code.
  const code = src.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  assert.doesNotMatch(
    code, /brand\s*===\s*'jcm'\s*\?/,
    "the 'jcm' ternary silently coerced every other brand to fme"
  );
});
