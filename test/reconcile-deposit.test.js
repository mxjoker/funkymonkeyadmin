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

// Most reconciliations were already done and just not written down in a
// findable way: measured 2026-09-18, 21 payment notes mention a check and only
// 2 name its number. Matching the AMOUNT against an already-settled booking is
// what catches those — without it the tool said "no booking owes this amount",
// which is true and useless, for four of seven checks in a real deposit.
test('a settled booking is recognised by amount when the number was never written down', () => {
  assert.match(SRC, /LOOKS RECORDED/);
  const block = SRC.split('// 2. Recorded, but without the number')[1].split('// 3.')[0];
  assert.match(block, /balance_due <= 0/, 'only already-settled bookings count as recorded');
  assert.match(block, /abs\(payment_amount - \$1\) < 0\.01/);
  assert.match(block, /payment_note LIKE/, 'and the amount as it appears in prose');
});

// The strong key is the check number, so a recognised-by-amount match should
// leave the number behind for next time.
test('it offers to write the number back after an amount match', () => {
  const block = SRC.split('// 2. Recorded, but without the number')[1].split('// 3.')[0];
  assert.match(block, /--record \$\{settled\[0\]\.reference\}=\$\{it\.checkNo\}/);
});

// payment_ref is frequently a Square or Stripe id already. Overwriting it would
// destroy a real reference to record a different one.
test('recording never overwrites a reference that is already in use', () => {
  assert.match(SRC, /coalesce\(payment_ref,''\) = ''/, 'payment_ref is only set when empty');
  assert.match(SRC, /check no\. ' \|\| \$1/, 'otherwise the number is appended to the note');
  assert.match(SRC, /payment_note !~\* \('check/, 'and never appended twice');
});

// A deposit cheque is recorded in deposit_ref, a balance cheque in payment_ref.
// Searching only one of them reported "no booking owes this amount" for check
// 4462 — the $100 show deposit for the Sep 27 Lawton festival — which had been
// recorded correctly all along.
test('a booking deposit cheque counts as recorded too', () => {
  assert.match(SRC, /coalesce\(deposit_ref,''\) <> '' AND replace\(deposit_ref, ' ', ''\) = \$1/);
  assert.match(SRC, /booking deposit/, 'and it should say which kind it was');
  assert.match(SRC, /the balance, correctly/, 'a deposit cheque leaves a balance outstanding on purpose');
});

// Joe navigates by date, not by reference number.
test('every booking named in the output carries its date', () => {
  for (const line of ['ALREADY RECORDED → ${k.reference} (${k.d})',
                      'LOOKS RECORDED → ${settled[0].reference} (${settled[0].d})',
                      '${c.reference} (${c.d})']) {
    assert.ok(SRC.includes(line), 'missing the date beside: ' + line);
  }
});

// Not every cheque is booking revenue. The Sooner Theatre residency pays
// contract labour and reimburses magic kits; a JCM job may never touch the CRM.
// Without a register of these, every pass re-investigates them and finds
// nothing, which looks exactly like a real gap.
test('known non-booking income is named, not re-investigated', () => {
  assert.match(SRC, /NOT A BOOKING/);
  assert.match(SRC, /non-booking-checks\.txt/);
  const block = SRC.split('const notBooking = new Map()')[1].split('for (const it of items)')[0];
  assert.match(block, /stripZeros\(m\[1\]\)/, 'check numbers there must normalise like everywhere else');
  assert.ok(SRC.indexOf('NOT A BOOKING') < SRC.indexOf('// 1. Already reconciled?'),
    'it should short-circuit before the database lookups');
});

// Amount matching has to be anchored in time and in evidence. Early versions
// tied a May cheque to an August booking, and tied three different cheques to
// one booking whose note happened to contain those figures — her note reads
// "$341.00 check ... paid in full ($385.00 + $56.00 travel)", so both amounts
// appear in it. A loose match is worse than none: it says a cheque is accounted
// for when it is not.
test('a match must fit the deposit date, not just the amount', () => {
  assert.match(SRC, /const depositDate = \(path\.basename\(file\)/, 'the deposit date comes from the file name');
  const q = SRC.split('const { rows: settled }')[1].split('LIMIT 3')[0];
  assert.match(q, /event_date <= \$4::date/, 'a cheque cannot pay for a gig that has not happened');
  assert.match(q, /INTERVAL '150 days'/, 'nor for one from a year earlier');
});

test('the strong claim requires the note to name BOTH this deposit and this amount', () => {
  const q = SRC.split('const { rows: settled }')[1].split('LIMIT 3')[0];
  assert.match(q, /payment_note LIKE '%' \|\| \$4 \|\| '%' AND/, 'the deposit date must appear');
  assert.match(q, /payment_note LIKE '%' \|\| \$2 \|\| '%' OR payment_note LIKE '%' \|\| \$3 \|\| '%'/, 'and the amount');
  assert.match(SRC, /names this very deposit/);
  assert.match(SRC, /MAYBE RECORDED/, 'a weaker match must be labelled as weaker');
});
