const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'scripts/reconcile-deposit.js'), 'utf8');

// The script is a CLI, so its parser is exercised by extracting it rather than
// by running the whole thing against a database.
function loadParser() {
  const body = SRC.slice(SRC.indexOf('const stripZeros'), SRC.indexOf('(async () =>'));
  const mod = { fs: require('node:fs') };
  return new Function('fs', body + '\nreturn { parseItems, stripZeros };')(mod.fs);
}

const write = (lines) => {
  const p = path.join(os.tmpdir(), 'dep-' + Math.random().toString(36).slice(2) + '.txt');
  fs.writeFileSync(p, lines.join('\n'));
  return p;
};

// A real deposit line from the bank: routing, account, date, reference, check
// number, amount. The first version read "1050" out of "1050.00" as the check
// number, so two checks in a genuine deposit were mis-identified.
test('the check number is not taken from the amount', () => {
  const { parseItems } = loadParser();
  const items = parseItems(write([
    'Check Item 103100195 0000000010776461 07-20-2026 5250009637211 0000006853 1850.00',
    'Check Item 082900432 0000004145024305 07-20-2026 5250009637210 0000035318 1050.00',
  ]));
  assert.strictEqual(items[0].amount, 1850);
  assert.strictEqual(items[0].checkNo, '6853', 'not 1850');
  assert.strictEqual(items[1].amount, 1050);
  assert.strictEqual(items[1].checkNo, '35318', 'not 1050');
});

test('a simple "amount checkno" line works too', () => {
  const { parseItems } = loadParser();
  const items = parseItems(write(['565.00 0000068046']));
  assert.deepStrictEqual({ a: items[0].amount, c: items[0].checkNo }, { a: 565, c: '68046' });
});

test('leading zeros are stripped so 0000068046 matches 68046', () => {
  const { stripZeros } = loadParser();
  assert.strictEqual(stripZeros('0000068046'), '68046');
});

test('lines with no amount are ignored, not guessed at', () => {
  const { parseItems } = loadParser();
  const items = parseItems(write(['Deposit Item 303087995 07-20-2026 201027947', '565.00 0000068046']));
  assert.strictEqual(items.length, 1, 'the header row must not become a check');
});

// The guard that makes the tool worth having: a check already reconciled must be
// recognised, whether the earlier session put the number in payment_ref or wrote
// it into a free-text note.
test('it looks for an already-recorded check before offering candidates', () => {
  assert.match(SRC, /replace\(payment_ref, ' ', ''\) = \$1/);
  assert.match(SRC, /payment_note ~\* \('check \(no/, 'prose notes from earlier reconciliations must still be found');
  assert.ok(SRC.indexOf('ALREADY RECORDED') < SRC.indexOf('candidate(s)'), 'recorded is checked first');
});

test('--record never overwrites an existing reference', () => {
  assert.match(SRC, /AND coalesce\(payment_ref,''\) = ''/);
});
