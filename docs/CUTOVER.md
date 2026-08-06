# PPM → CRM Cutover Runbook

**Written 2026-08-06, before the cutover, deliberately.** A runbook written
during a cutover is written under pressure.

**The only one-way door is the Wix button, and its rollback is repointing it.
Two minutes.** Everything before that step is reversible; nothing before it is
visible to a customer.

---

## Pre-cutover state

Recorded from `/api/health` immediately before starting. Fill this in — it is
the before-picture, and a rotation that silently breaks something is only
detectable against it.

```
(paste /api/health output here)
```

Known as of 2026-08-06, verified rather than assumed:

- Credentials rotated 2026-08-05/06. The old Stripe secret key was **revoked**;
  the old Resend key was left live until a real send is proven.
- `EMAIL_ALLOWLIST` deleted. **Every email this cutover sends is real.** Scope
  any email-touching test to a booking whose `client_email` is your own address.
- Deploy `6a73d70c…` published 2026-08-06 04:58 UTC, carrying the rotated keys.
  All 34 functions rebuilt after the rotation.
- `STRIPE_WEBHOOK_SECRET` present — the webhook returns `400 Missing signature`
  rather than `500 Webhook not configured`. This proves a secret exists, **not**
  that it is the new one. Only a real signed event proves that.
- `bookings` holds zero `pending` rows. All seven statuses are in use.

---

## Order of operations

### 1. Freeze PPM
Stop taking new bookings there. Announce nothing publicly yet — the button has
not moved, so nothing customer-facing has changed.

### 2. Final export
PPM → export all bookings to CSV. Save as `ppm-final-export.csv`.

### 3. Reconcile
```bash
node scripts/reconcile-ppm-export.js ppm-final-export.csv
```

Read all three buckets. **Do not proceed while MISSING > 0** — those are the
in-flight bookings a cutover loses.

**On DRIFTED rows, do not apply a blanket rule.** The obvious instinct — "PPM is
source of truth until the button moves" — is wrong, and following it would have
caused a real incident on 2026-08-05:

- **PPM leads** on intake and quoting. It owned the booking form until today.
- **The CRM leads on payment state.** Money reaches the CRM by routes PPM never
  sees: Stripe deposits taken through the CRM, and GigSalad/Bark gigs marked
  paid by hand. `26-286` was paid through a third-party site and marked paid in
  the CRM while PPM still read `Processing` — with the event the next day.
  "PPM wins" would have reverted a paid booking to unpaid.

Each drifted row is a judgement call. There will not be many.

**A price difference is not automatically drift.** PPM's `Tot. price` includes
the travel fee; the CRM's `total_price` excludes it, per
`balance_due = total_price + mileage_cost - deposit_amount`. The script already
compensates. If you ever compare the columns by hand, add `mileage_cost` back
first — otherwise every travelled booking looks drifted.

### 4. Close the MISSING gap
```bash
node netlify/functions/import-bookings.js          # dry run first
```
Then apply. Re-run the reconciler until MISSING is 0.

### 5. Link services
```bash
node scripts/backfill-service-ids.js               # dry run
node scripts/backfill-service-ids.js --apply
```
Newly imported rows already carry a `service_id` — the importer writes it as of
`b26083f`. This catches anything the map could not resolve and lists what needs
a human. Ambiguous names ("Custom Event", "Magic Show", one-off titles) stay
unlinked on purpose; link those by hand in the booking's Quote Breakdown.

### 6. Deploy
Netlify → **Trigger deploy**. `git push` does not deploy. This is Phase 4's
single publish.

### 7. Verify the deploy actually published
A green checkmark is not proof the new bytes are being served.
```bash
curl -s https://funkymonkeyadmin.netlify.app/booking-form.html | grep -c "brand"
```
Expect ≥ 1.

### 8. Run the gate
See below. **All four conditions.** A failure here stops the cutover — the
button has not moved, so nothing is lost.

### 9. Move the button
Wix → the Book Now button → retarget to:
```
https://funkymonkeyadmin.netlify.app/booking-form.html
```

### 10. Repeat the gate through the live Wix path
The button is the only thing that changed; prove the whole chain through it.

### 11. PPM read-only
Leave the account live for historical lookup. **Do not cancel the subscription**
until one full booking cycle has run through the CRM.

### 12. Revoke the old Resend key
Only now, with a real send proven. Also delete the unused "Local FM test" key
once Resend's Logs page shows no sends from it in 30 days.

---

## Gate

A real test booking placed through the live Wix button that:

1. Lands in the CRM with `brand = 'fme'`
2. Generates a working Stripe deposit link
3. Takes a real **$1** charge that flips status to `confirmed` via the webhook
4. Sends a confirmation email that actually arrives

Refund the $1 afterwards.

Condition 3 is the one that proves the rotated `STRIPE_WEBHOOK_SECRET` — nothing
short of a real signed event does. Condition 4 proves the rotated Resend key.

Condition 1 is only meaningful as of `e8e8def`/`7faa51e`: before those,
`booking-form.html` sent no brand at all and the server coerced everything to
`fme`, so this check could not fail.

---

## Rollback

| What | How |
|---|---|
| **The button** | Repoint at PPM. Two minutes. The only one-way door. |
| **Code** | `git revert <phase-4 commits>`, then Trigger deploy. |
| **Imported rows** | Identify by `reference` from the reconciler's MISSING list. **Never bulk-delete** — 668 rows are real customers. |
| **Service links** | `scripts/backfill-service-ids.js` only fills blanks, so re-running is safe and there is nothing to undo. |

---

## Outcome

Filled in after execution.

```
Date:
Test booking reference:
Stripe charge id:
Refunded:
Anything that surprised us:
```
