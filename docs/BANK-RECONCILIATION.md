# Connecting checks to deposits — how, and what is already done

Every dollar that arrives should be traceable to a booking. This is the process
for getting there, written down because the work was being redone: a $565 check
was investigated twice, and the second pass nearly credited it to the wrong
customer because the amount matched two different bookings.

## The rule that makes this safe

**An amount never identifies a check.** There are 39,734,344,046 combinations of
the 67 unpaid gigs that total exactly $5,914.00, because they are mostly $200,
$345 and $385. The **check number** is the only unique key, and the **payer name**
on the check face is the only proof.

## Where things live

Nothing sensitive goes in this repo. The site publishes the repository root, so
a committed statement would be downloadable by anyone who guessed the path.

| What | Where |
|---|---|
| Bank exports | `Bank Docs/` — gitignored |
| Parsed deposits | `~/FME-private/credits.json` |
| Per-deposit itemisations | `~/FME-private/deposits/YYYY-MM-DD.txt` |
| Collections worksheet | `~/FME-private/collections-triage-*.md` |

## The loop

1. **See what is left.** `node scripts/deposit-audit.js` lists every unnamed
   deposit and whether its checks have been itemised. A deposit counts as done
   only when the saved lines add up to the deposit total — if they do not,
   something was mistyped or a row was missed.

2. **Pull the detail view** for the next deposit in the bank's site and paste the
   rows into `~/FME-private/deposits/<date>.txt`, one check per line. The raw
   paste is fine: routing and account numbers are ignored, the amount is the
   token with cents, and the check number is the last long digit run.

3. **Reconcile.** `node scripts/reconcile-deposit.js ~/FME-private/deposits/<date>.txt`
   reports, per check:
   - **ALREADY RECORDED** — the number is in `payment_ref` or named in a note.
     Nothing to do.
   - **LOOKS RECORDED** — a settled booking matches the amount and its note names
     the payer. Confirm, then record the number.
   - **candidates** — outstanding bookings of that amount. **The payer name on the
     check decides**, never the amount.
   - **no booking owes this amount** — already settled, or a gig that was never
     entered. Two in the 07-20 deposit turned out to be the latter.

4. **Record it**, so the next pass skips it:
   `node scripts/reconcile-deposit.js <file> --record 26-161=35318`
   Sets `payment_ref` when empty, otherwise appends a canonical `check no. N` to
   the payment note. It never overwrites a reference that is already in use —
   `payment_ref` is often a Square or Stripe id.

## Why the notes were not enough

Measured 2026-09-18: **47 bookings carry a payment note, 21 mention a check, and
only 2 named its number.** The reconciliations had been done and written in
prose — "City of Ardmore check deposited 2026-07-20" — which nothing can query.
Recording the number is what turns that work into something the next pass can
build on.

## Done so far

- **2026-07-20, $5,914.00** — fully explained. Five checks recorded by number
  (68046 First Christian Church → 26-200; 35318 City of Ardmore → 26-161; 6853
  Rose Creek → 26-132; 20039 First Baptist → 26-280; 2680 Lawton library →
  26-142), two whose bookings carry no balance. **No missing money.**
- Balances cleared where the payment was already recorded: 26-262 Anna Viersen
  ($525 check), 26-286 Lisa Murcia ($885 cash, a GigSalad booking that should
  never have carried a balance).

## The open question

$30,542 shows as owed across 67 completed gigs. Two library accounts are 30% of
it — **Jennifer Fuller (Eastern Oklahoma Library System, $5,164)** and **Angela
Fox (Tulsa City-County Library, $4,140)**. Neither has ever been invoiced, and no
payment from either library appears anywhere in nine months of bank data. The
2026-08-17 deposit ($6,300.80) is the last realistic place their checks could be
hiding.
