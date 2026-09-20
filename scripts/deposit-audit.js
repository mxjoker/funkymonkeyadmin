#!/usr/bin/env node
// Which bank deposits have been connected to bookings, and which have not.
//
// The audit this supports: every dollar that arrived should be traceable to a
// booking. The bank export gives deposit TOTALS; the individual checks live in
// the bank's itemised view, which has to be pulled per deposit. This tracks
// which ones have been pulled, what they explained, and what is left — so the
// work is resumable instead of restarted, which is how a $565 check ended up
// being investigated twice.
//
// Itemisations live in ~/FME-private/deposits/YYYY-MM-DD.txt, one check per
// line, exactly as the bank's detail screen copies out. Nothing sensitive is
// kept in the repo.
//
//   node scripts/deposit-audit.js

const fs = require('fs');
const path = require('path');
const os = require('os');
const HOME = os.homedir();
const DEPOSITS = path.join(HOME, 'FME-private', 'deposits');
const CREDITS = path.join(HOME, 'FME-private', 'credits.json');
const money = (n) => '$' + Number(n || 0).toFixed(2);

if (!fs.existsSync(CREDITS)) {
  console.error(`No parsed bank data at ${CREDITS}.`);
  console.error('Parse the Bank Docs exports first — see docs/BANK-RECONCILIATION.md');
  process.exit(1);
}
const credits = JSON.parse(fs.readFileSync(CREDITS, 'utf8'));
const iso = (m) => { const [a, b, c] = String(m).split('/'); return `${c}-${a}-${b}`; };

// Only unnamed deposits need itemising. An ACH credit already names its payer,
// and a Stripe or Square settlement is reconciled by the processor, not by eye.
const batches = credits
  .filter((c) => /^DEPOSIT$/i.test(c.desc) && !c.text)
  .map((c) => ({ ...c, iso: iso(c.date) }))
  .sort((a, b) => a.iso.localeCompare(b.iso));

// A file is matched to a deposit by DATE AND TOTAL, not by date alone: two
// deposits landed on 2026-07-20 (one per account) and a date-only match claimed
// both were done when only one was. Summing the checks also verifies the
// itemisation — if the lines do not add up to the deposit, something was
// mistyped or a row was missed, and that is worth knowing before the numbers
// are used to decide a customer owes money.
const parseAmounts = (file) => (fs.readFileSync(file, 'utf8').match(/[\d,]+\.\d{2}/g) || [])
  .map((a) => Number(a.replace(/,/g, '')));

const files = fs.existsSync(DEPOSITS)
  ? fs.readdirSync(DEPOSITS).filter((f) => f.endsWith('.txt')).map((f) => {
      const amounts = parseAmounts(path.join(DEPOSITS, f));
      return { name: f, date: f.slice(0, 10), sum: amounts.reduce((t, a) => t + a, 0), count: amounts.length };
    })
  : [];

// A deposit total often appears as a header line in the pasted detail, so the
// items may sum to either the total or twice it. Both count as a clean match.
//
// A file may also cover SEVERAL deposits banked the same day — 2026-07-27 had
// four, and three of them were pasted into one file. Without this the audit
// reported all four as outstanding when three were done, which is the opposite
// of the problem this tracker exists to solve.
const sameDay = (iso) => batches.filter((b) => b.iso === iso);
const subsetHits = (file) => {
  const pool = sameDay(file.date);
  for (let mask = 1; mask < (1 << pool.length); mask++) {
    const pick = pool.filter((_, i) => mask & (1 << i));
    const total = pick.reduce((t, d) => t + d.amt, 0);
    if (Math.abs(total - file.sum) < 0.01 || Math.abs(total * 2 - file.sum) < 0.01) return pick;
  }
  return null;
};
const covered = new Set();
for (const file of files) {
  const pick = subsetHits(file);
  if (pick) pick.forEach((d) => covered.add(d.iso + '|' + d.amt + '|' + d.acct));
}
const matchFor = (dep) => {
  const key = dep.iso + '|' + dep.amt + '|' + dep.acct;
  if (!covered.has(key)) return null;
  return files.find((x) => x.date === dep.iso) || { count: '?' };
};

let done = 0, doneValue = 0, todo = 0, todoValue = 0;
console.log('DEPOSIT AUDIT — connecting checks to bookings\n');
for (const b of batches) {
  const m = matchFor(b);
  const has = !!m;
  if (has) { done++; doneValue += b.amt; } else { todo++; todoValue += b.amt; }
  console.log(`  ${has ? '✓' : ' '} ${b.iso}  ${money(b.amt).padStart(10)}  ${b.acct.padEnd(20)} ${has ? `itemised — ${m.count} checks, they add up` : 'needs the bank\'s detail view'}`);
}
const total = doneValue + todoValue;
console.log(`\n  ${done} of ${batches.length} deposits itemised — ${money(doneValue)} of ${money(total)} (${total ? Math.round(doneValue / total * 100) : 0}%)`);
if (todo) {
  console.log(`  ${todo} left, ${money(todoValue)}. Biggest first:`);
  batches.filter((b) => !matchFor(b)).sort((a, b) => b.amt - a.amt).slice(0, 5)
    .forEach((b) => console.log(`      ${b.iso}  ${money(b.amt).padStart(10)}  ${b.acct}`));
  console.log(`\n  Save each as ${DEPOSITS}/<date>.txt, then:`);
  console.log('      node scripts/reconcile-deposit.js ~/FME-private/deposits/<date>.txt');
}
