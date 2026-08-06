const { test } = require('node:test');
const assert = require('node:assert');
const { parseCSVLine, parseCSV } = require('../netlify/functions/_csv');

// ── Why this is tested ──────────────────────────────────────────────────────
// The reconciler and the importer must read the PPM export identically. Two
// parsers that disagree would report drift that is really just a parsing
// difference — and the reconciliation is the last gate before the Wix button
// moves, so a false clean bill of health there loses in-flight bookings.

test('a quoted field containing a comma stays one field', () => {
  // Real PPM data: "Addr. line 1" is routinely "306 Stephany dr, Apt 2".
  assert.deepStrictEqual(
    parseCSVLine('"a","b, still b","c"'),
    ['a', 'b, still b', 'c']
  );
});

test('unquoted fields are trimmed', () => {
  assert.deepStrictEqual(parseCSVLine('a, b ,c'), ['a', 'b', 'c']);
});

test('trailing empty fields are preserved, not dropped', () => {
  // PPM exports 80 columns and pads the tail with empties. Dropping them
  // shifts every subsequent column and silently mis-maps the whole row.
  assert.deepStrictEqual(parseCSVLine('a,b,,'), ['a', 'b', '', '']);
});

test('an empty line yields one empty field, never a crash', () => {
  assert.deepStrictEqual(parseCSVLine(''), ['']);
});

test('parseCSV maps rows onto headers by name', () => {
  const { headers, rows } = parseCSV('"Ref.","Client name"\n"26-250","Kiley Mixon"');
  assert.deepStrictEqual(headers, ['Ref.', 'Client name']);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0]['Ref.'], '26-250');
  assert.strictEqual(rows[0]['Client name'], 'Kiley Mixon');
});

test('a row with fewer fields than headers yields empty strings, not undefined', () => {
  // '' matches this schema's DEFAULT '' convention; undefined would make
  // COALESCE-style guards downstream behave differently for short rows.
  const { rows } = parseCSV('"a","b","c"\n"1"');
  assert.strictEqual(rows[0].b, '');
  assert.strictEqual(rows[0].c, '');
});

test('a blank trailing line does not become a phantom row', () => {
  const { rows } = parseCSV('"Ref."\n"26-250"\n\n');
  assert.strictEqual(rows.length, 1);
});

test('the real PPM export parses to its documented shape', () => {
  // Guards the join key specifically: reconciliation is an exact match on
  // "Ref.", so a parser change that moves that column breaks the cutover gate
  // rather than any test that only checks synthetic input.
  const fs = require('node:fs');
  const path = require('node:path');
  const sample = path.join(__dirname, '..', 'import-data.csv');
  if (!fs.existsSync(sample)) return; // sample is not required to be present

  const { headers, rows } = parseCSV(fs.readFileSync(sample, 'utf8'));
  assert.strictEqual(headers.length, 80, 'PPM exports 80 columns');
  assert.strictEqual(headers.indexOf('Ref.'), 32, '"Ref." is column 33');
  assert.ok(rows.length > 0);
  assert.match(rows[0]['Ref.'], /^\d{2}-\d+$/, 'references look like 26-250');
});
