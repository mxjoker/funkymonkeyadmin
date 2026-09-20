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
const os = require('os');
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
  // From the file name: 2026-05-21.txt. A cheque cannot pay for a gig that has
  // not happened yet, and a settled booking from a year earlier was not paid by
  // this deposit — without that, amount alone matched a May cheque to an August
  // booking and called it recorded.
  const depositDate = (path.basename(file).match(/\d{4}-\d{2}-\d{2}/) || [null])[0];
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const client = await pool.connect();
  try {
    if (records.length) {
      for (const [ref, checkNo] of records) {
        // payment_ref is the strong key, but it is often already a Square or
        // Stripe id. Rather than overwrite something real, fall back to a
        // canonical "check no. N" in the note — the exact phrasing the
        // already-recorded lookup above searches for.
        const { rows } = await client.query(
          `UPDATE bookings SET payment_ref = $1, updated_at = NOW()
           WHERE reference = $2 AND coalesce(payment_ref,'') = '' RETURNING reference`, [checkNo, ref]);
        if (rows.length) { console.log(`recorded: ${ref} ← check ${checkNo} (payment_ref)`); continue; }
        const { rows: noted } = await client.query(
          `UPDATE bookings
              SET payment_note = trim(coalesce(payment_note,'') || ' · check no. ' || $1),
                  updated_at = NOW()
            WHERE reference = $2
              AND payment_note !~* ('check \\(no\\.?|#\\) *0*' || $1)
            RETURNING reference`, [checkNo, ref]);
        console.log(noted.length
          ? `recorded: ${ref} ← check ${checkNo} (appended to the note; payment_ref was already in use)`
          : `skipped:  ${ref} (not found, or check ${checkNo} is already on it)`);
      }
      console.log('');
    }

    // Income that is not booking revenue — contract labour for the Sooner
    // Theatre residency, an expense reimbursement for magic kits, a JCM job that
    // never went through the CRM. Without this every pass re-investigates them
    // and finds nothing, which is indistinguishable from a real gap.
    const notesFile = path.join(os.homedir(), 'FME-private', 'non-booking-checks.txt');
    const notBooking = new Map();
    if (fs.existsSync(notesFile)) {
      for (const line of fs.readFileSync(notesFile, 'utf8').split('\n')) {
        const m = line.trim().match(/^(\d+)\s+(.*)$/);
        if (m) notBooking.set(stripZeros(m[1]), m[2]);
      }
    }

    for (const it of items) {
      if (it.checkNo && notBooking.has(it.checkNo)) {
        console.log(`${money(it.amount).padStart(10)} check ${String(it.checkNo).padEnd(8)} NOT A BOOKING — ${notBooking.get(it.checkNo)}`);
        continue;
      }

      // 1. Already reconciled? The check number is the only unique key.
      // deposit_ref as well as payment_ref: a deposit cheque is recorded in a
      // different column from a balance cheque, and searching only one of them
      // reported "no booking owes this amount" for check 4462 — the $100 deposit
      // for the Sep 27 Lawton festival, which was correctly recorded all along.
      const { rows: known } = await client.query(`
        SELECT reference, client_name, event_date::text AS d, balance_due::float bal,
               CASE WHEN replace(coalesce(deposit_ref,''), ' ', '') = $1 THEN 'deposit' ELSE 'payment' END AS kind
        FROM bookings
        WHERE (coalesce(payment_ref,'') <> '' AND replace(payment_ref, ' ', '') = $1)
           OR (coalesce(deposit_ref,'') <> '' AND replace(deposit_ref, ' ', '') = $1)
           OR payment_note ~* ('check (no\\.?|#) *0*' || $1)`, [it.checkNo || '~none~']);
      if (known.length) {
        const k = known[0];
        console.log(`${money(it.amount).padStart(10)} check ${String(it.checkNo).padEnd(8)} ALREADY RECORDED → ${k.reference} (${k.d}) ${k.client_name}` +
          (k.kind === 'deposit' ? ' — booking deposit' : '') +
          (k.bal > 0 ? `  · still owes ${money(k.bal)}${k.kind === 'deposit' ? ' (the balance, correctly)' : ' ⚠'}` : ''));
        continue;
      }
      // 2. Recorded, but without the number. Most older notes are like
      //    "City of Ardmore check deposited 2026-07-20" — the reconciliation was
      //    done, the number just was not written down. Measured 2026-09-18: 21
      //    notes mention a check and only 2 name it. Matching the AMOUNT against
      //    an already-settled booking catches these, and --record then writes
      //    the number back so the next pass matches on the strong key.
      const amtStr = it.amount.toFixed(2);
      const amtComma = it.amount.toLocaleString('en-US', { minimumFractionDigits: 2 });
      // Two tiers of evidence, and nothing below them.
      //
      // STRONG: the note names this deposit's date, and names this amount as a
      // CHEQUE — the figure followed by the word "check" with no other dollar
      // amount in between. Patricia Gross's note reads "Square 2026-03-07
      // $100.00 deposit + $585.00 check deposited 2026-03-16"; a plain
      // contains-the-amount test claimed a separate $100 cheque was hers, when
      // her $100 was a card payment.
      //
      // The leading boundary matters just as much: without it "100.00" matches
      // INSIDE "$1,100.00", and a $100 cheque was claimed by a booking paid
      // with an $1,100 one.
      // PLAUSIBLE: the recorded payment equals the cheque and the gig happened
      // in the months before the deposit.
      //
      // An earlier version also matched "the amount appears anywhere in the
      // note", which tied three different cheques to one booking because her
      // note happened to contain those figures. A loose match here is worse
      // than none: it tells someone a cheque is accounted for when it is not.
      const { rows: settled } = await client.query(`
        SELECT reference, client_name, event_date::text AS d, payment_note, balance_due::float bal,
               (payment_note LIKE '%' || $4 || '%' AND
                (payment_note ~ ('(^|[^0-9,.])\\$?' || $2 || '[^$]{0,40}check')
                 OR payment_note ~ ('(^|[^0-9,.])\\$?' || $3 || '[^$]{0,40}check'))) AS names_this_deposit
        FROM bookings
        WHERE balance_due <= 0
          AND (
            (payment_note LIKE '%' || $4 || '%' AND
             (payment_note ~ ('(^|[^0-9,.])\\$?' || $2 || '[^$]{0,40}check')
              OR payment_note ~ ('(^|[^0-9,.])\\$?' || $3 || '[^$]{0,40}check')))
            OR (abs(payment_amount - $1) < 0.01 AND $4 <> ''
                AND event_date <= $4::date AND event_date >= $4::date - INTERVAL '150 days')
          )
        ORDER BY names_this_deposit DESC, event_date DESC LIMIT 3`,
        [it.amount, amtStr, amtComma, depositDate || '1900-01-01']);

      if (settled.length) {
        const sure = settled[0].names_this_deposit;
        console.log(`${money(it.amount).padStart(10)} check ${String(it.checkNo || '—').padEnd(8)} ${sure ? 'RECORDED, and its note names this very deposit' : 'MAYBE RECORDED — amount and timing fit, nothing more'} → ${settled[0].reference} (${settled[0].d}) ${settled[0].client_name}`);
        console.log(`${' '.repeat(12)}  note: ${String(settled[0].payment_note || '').slice(0, 78)}`);
        if (it.checkNo && !new RegExp('check (no\\.?|#) *0*' + it.checkNo, 'i').test(settled[0].payment_note || '')) {
          console.log(`${' '.repeat(12)}  → confirm, then: --record ${settled[0].reference}=${it.checkNo}`);
        }
        continue;
      }

      // 3. Not recorded at all — which outstanding gigs is it the right size for?
      const { rows: cand } = await client.query(`
        SELECT reference, client_name, event_date::text d, balance_due::float bal
        FROM bookings WHERE status IN ('completed','confirmed') AND balance_due > 0
          AND abs(balance_due - $1) < 0.01 ORDER BY event_date DESC LIMIT 5`, [it.amount]);
      if (!cand.length) {
        console.log(`${money(it.amount).padStart(10)} check ${String(it.checkNo || '—').padEnd(8)} no booking owes this amount — already settled, or never entered`);
      } else {
        console.log(`${money(it.amount).padStart(10)} check ${String(it.checkNo || '—').padEnd(8)} ${cand.length} candidate(s) — the PAYER NAME on the check decides:`);
        cand.forEach((c) => console.log(`${' '.repeat(12)}  ${c.reference} (${c.d}) ${c.client_name}  owes ${money(c.bal)}`));
      }
    }
    console.log('\nAmount alone never identifies a check. Confirm the payer, then re-run with');
    console.log('--record <booking-ref>=<check-no> so this deposit is never re-examined by hand.');
  } finally {
    client.release();
    await pool.end();
  }
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
