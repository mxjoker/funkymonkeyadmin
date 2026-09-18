#!/usr/bin/env node
// Reconcile one bank deposit's checks against the CRM.
//
// Why this exists: on 2026-09-18 a $565 check was traced from a deposit, matched
// to a booking by amount, and reported as an unrecorded payment. It was neither
// — check 68046 from First Christian Church had ALREADY been reconciled by an
// earlier session, which wrote the check number into a free-text payment_note
// nobody queries. The amount also matched a DIFFERENT booking that genuinely
// still owed $565, so the near-miss was crediting the wrong customer.
//
// Amount alone cannot identify a check: 67 unpaid gigs at $200/$345/$385 can hit
// almost any total (39.7 BILLION combinations reach $5,914 exactly). The check
// NUMBER is the only unique key, so that is what this tool matches on first and
// what --record writes into payment_ref, where the next pass can find it.
//
//   node scripts/reconcile-deposit.js items.txt
//   node scripts/reconcile-deposit.js items.txt --record 26-200=68046
//
// items.txt: one check per line, "amount check_number" (extra columns ignored),
// which is the shape a bank's itemised deposit screen copies out as.

const fs = require('fs');
const path = require('path');
if (!process.env.DATABASE_URL) {
  const p = path.join(__dirname, '..', '.env');
  const m = fs.existsSync(p) && fs.readFileSync(p, 'utf8').match(/^DATABASE_URL=(.*)$/m);
  if (m) process.env.DATABASE_URL = m[1].trim().replace(/^["']|["']$/g, '');
}
const { Pool } = require('pg');
const money = (n) => '$' + Number(n || 0).toFixed(2);
const stripZeros = (s) => String(s).replace(/^0+/, '');

// One check per line. The amount is the token with cents; the check number is a
// long digit run that is NOT part of the amount — take the amount out of the
// line first, or "1050.00" yields a check number of 1050, which is how the
// first version mis-read two rows of a real deposit.
function parseItems(file) {
  return fs.readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean)
    .map((line) => {
      const amtToken = (line.match(/[\d,]+\.\d{2}/g) || []).pop();
      if (!amtToken) return null;
      const withoutAmounts = line.replace(/[\d,]+\.\d{2}/g, ' ');
      const digits = withoutAmounts.match(/\d{4,}/g) || [];
      // The check number is the LAST long run: bank exports put routing and
      // account numbers first and the check number last.
      const checkNo = digits.length ? stripZeros(digits[digits.length - 1]) : null;
      return { amount: Number(amtToken.replace(/,/g, '')), checkNo, raw: line };
    })
    .filter((i) => i && i.amount > 0);
}

(async () => {
  const [file, ...rest] = process.argv.slice(2);
  if (!file) { console.error('usage: reconcile-deposit.js <items file> [--record REF=CHECKNO ...]'); process.exit(1); }
  const records = rest.filter((a) => a.includes('=')).map((a) => a.replace(/^--record=?/, '').split('='));
  const items = parseItems(file);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const client = await pool.connect();
  try {
    if (records.length) {
      for (const [ref, checkNo] of records) {
        const { rows } = await client.query(
          `UPDATE bookings SET payment_ref = $1, updated_at = NOW()
           WHERE reference = $2 AND coalesce(payment_ref,'') = '' RETURNING id, reference`, [checkNo, ref]);
        console.log(rows.length
          ? `recorded: ${ref} ← check ${checkNo}`
          : `skipped:  ${ref} (not found, or payment_ref already set — never overwritten)`);
      }
      console.log('');
    }

    for (const it of items) {
      // 1. Already reconciled? The check number is the only unique key.
      const { rows: known } = await client.query(`
        SELECT reference, client_name, balance_due::float bal FROM bookings
        WHERE (coalesce(payment_ref,'') <> '' AND replace(payment_ref, ' ', '') = $1)
           OR payment_note ~* ('check (no\\.?|#) *0*' || $1)`, [it.checkNo || '~none~']);
      if (known.length) {
        console.log(`${money(it.amount).padStart(10)} check ${String(it.checkNo).padEnd(8)} ALREADY RECORDED → ${known[0].reference} ${known[0].client_name}` +
          (known[0].bal > 0 ? `  ⚠ still shows ${money(known[0].bal)} owed` : ''));
        continue;
      }
      // 2. Not recorded — which outstanding gigs is it the right size for?
      const { rows: cand } = await client.query(`
        SELECT reference, client_name, event_date::text d, balance_due::float bal
        FROM bookings WHERE status IN ('completed','confirmed') AND balance_due > 0
          AND abs(balance_due - $1) < 0.01 ORDER BY event_date DESC LIMIT 5`, [it.amount]);
      if (!cand.length) {
        console.log(`${money(it.amount).padStart(10)} check ${String(it.checkNo || '—').padEnd(8)} no booking owes this amount — already settled, or never entered`);
      } else {
        console.log(`${money(it.amount).padStart(10)} check ${String(it.checkNo || '—').padEnd(8)} ${cand.length} candidate(s) — the PAYER NAME on the check decides:`);
        cand.forEach((c) => console.log(`${' '.repeat(12)}  ${c.reference.padEnd(12)} ${c.d} ${c.client_name}  owes ${money(c.bal)}`));
      }
    }
    console.log('\nAmount alone never identifies a check. Confirm the payer, then re-run with');
    console.log('--record <booking-ref>=<check-no> so this deposit is never re-examined by hand.');
  } finally {
    client.release();
    await pool.end();
  }
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
