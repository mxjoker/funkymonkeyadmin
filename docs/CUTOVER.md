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

## The ordering rule that governs everything below

**Moving the website links IS the freeze.** There is no separate "stop taking
PPM bookings" action — PPM receives bookings because 11 buttons on
funkymonkeyevents.com point at it, and it stops the moment they don't.

That forces the order. An earlier draft of this runbook said "freeze PPM" first
and "move the button" last, which is incoherent: either the links are down (and
the site has no booking path at all for the whole cutover) or they are up (and
PPM keeps taking bookings after you export it, silently losing them).

So: **prove the CRM first, move the links second, export third.** Nothing can
arrive in PPM after an export taken from a system nothing points at any more.

The cost is two deploys rather than one. Worth it — the alternative risks losing
a real booking.

---

## The 11 links

Every booking button on the site points at the same URL:

```
https://partypromanager.com/contact-provider?providerId=a8eb97a7-96b9-4cd2-86e2-9b8cfe6f0b83
```

| Page | Buttons |
|---|---|
| `/entertainment` | 5 |
| `/foam-party` | 3 |
| `/joecoover-magic` | 2 |
| `/contact` | 1 |

All 11 get the same replacement:

```
https://funkymonkeyadmin.netlify.app/booking-form.html
```

Verified by crawling all 13 pages on 2026-08-10. `/`, `/camps`, `/snow`,
`/faqs`, `/foam-faqs`, `/blog` and the three venue pages contain **no** booking
link at all — worth revisiting after the cutover, but not part of it.

---

## Order of operations

### 1. Merge and deploy the Phase 4 code — CLAUDE does the merge, JOE deploys

```bash
git checkout main && git merge feat/crm-takeover-phase-4 && git push
```

Then Netlify → **Trigger deploy**. `git push` does not deploy.

This publish carries: brand validation, the editable deposit, the `+ Booking`
buttons, the shared CSV parser. It does **not** carry the final export — that
ships in step 6.

### 2. Verify the deploy actually published — CLAUDE

A green checkmark is not proof the new bytes are being served.

```bash
curl -s https://funkymonkeyadmin.netlify.app/booking-form.html | grep -c "brand"
```

### 3. Run the gate on the CRM form directly — JOE

**Before any link moves.** Go straight to
`https://funkymonkeyadmin.netlify.app/booking-form.html` and place a real
booking, then take it through to a paid $1 deposit. All four conditions in the
Gate section below.

This is the go/no-go. If it fails, nothing has changed for any customer — the
site still points at PPM and you have lost nothing.

### 4. Move all 11 links — JOE

In the Wix editor, in **one sitting**. A half-moved site sends some customers to
the CRM and some to PPM, and the export in step 5 will miss whatever PPM took in
between.

Work page by page: `/entertainment` (5), `/foam-party` (3),
`/joecoover-magic` (2), `/contact` (1). Publish the Wix site.

Then tell Claude, who will re-crawl all 13 pages and confirm zero
`partypromanager.com` references remain. **Do not proceed on the assumption that
you got them all** — that is precisely what the re-crawl is for.

### 5. Export PPM — JOE

Only now, with nothing on the internet pointing at PPM.

Export **all** bookings to CSV and save it to the repo root as
`import-data.csv`, replacing the 29-row sample. Do not commit — Claude will.

### 6. Reconcile, then deploy the export — CLAUDE commits and reconciles, JOE deploys

```bash
node scripts/reconcile-ppm-export.js import-data.csv
```

Read all three buckets. **MISSING must reach 0 before the cutover is done.**

On DRIFTED rows, do not apply a blanket rule:

- **PPM leads** on intake and quoting — it owned the booking form until step 4.
- **The CRM leads on payment state.** Money reaches the CRM by routes PPM never
  sees: Stripe deposits, and GigSalad/Bark gigs marked paid by hand. `26-286`
  was paid through a third-party site and marked paid in the CRM while PPM still
  read `Processing`, with the event the next day. "PPM wins" would have reverted
  a paid booking to unpaid.

**A price difference is not automatically drift.** PPM's `Tot. price` includes
travel; the CRM's `total_price` excludes it. The script compensates; a
by-hand comparison must add `mileage_cost` back first.

Then commit the CSV and **Trigger deploy** — the importer reads the CSV from its
own deployed bundle, so it cannot see a file that has not shipped.

### 7. Import the missing bookings — JOE runs it (needs an admin token)

Dry run first:

```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" \
  "https://funkymonkeyadmin.netlify.app/api/import-bookings?dryrun=true" | python3 -m json.tool
```

Then the same URL without `?dryrun=true`.

**Re-importing the whole export is safe** — the handler skips any row whose
`reference` already exists. Import the complete export, never a hand-built delta
of the MISSING rows; hand-building one is how a booking gets missed.

### 8. Re-reconcile until MISSING is 0 — CLAUDE

```bash
node scripts/reconcile-ppm-export.js import-data.csv
```

### 9. Link services — CLAUDE

```bash
node scripts/backfill-service-ids.js          # dry run
node scripts/backfill-service-ids.js --apply
```

A real CLI talking to the database directly, so no deploy needed. Newly imported
rows already carry a `service_id`. Ambiguous names ("Custom Event", "Magic
Show", one-off titles) stay unlinked on purpose — link those by hand in the
booking's Quote Breakdown.

### 10. Repeat the gate through the live site — JOE

Book through a real button on funkymonkeyevents.com, end to end. The links are
the only thing that changed since step 3; this proves the customer's actual
path.

### 11. PPM read-only — JOE

Leave the account live for historical lookup. **Do not cancel the subscription**
until one full booking cycle has run through the CRM.

### 12. Revoke the old Resend key — JOE

Also delete the unused "Local FM test" key once Resend's Logs page shows no
sends from it in 30 days.

---

## Gate

A real test booking — placed on the CRM form directly at step 3, and again
through a real site button at step 10 — that:

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
| **The links** | Repoint all 11 back at PPM. The only one-way door, and it is 11 edits, not two minutes. Budget for that. |
| **Code** | `git revert <phase-4 commits>`, then Trigger deploy. |
| **Imported rows** | Identify by `reference` from the reconciler's MISSING list. **Never bulk-delete** — 668 rows are real customers. |
| **Service links** | `scripts/backfill-service-ids.js` only fills blanks, so re-running is safe and there is nothing to undo. |

---

## Outcome — executed 2026-08-10/11

**The CRM is the system of record.** funkymonkeyevents.com feeds it, PPM has
been captured and drained, and PPM now receives nothing.

| | |
|---|---|
| Website booking links moved | 18, across 4 pages, all crawl-verified |
| PPM export | 702 bookings |
| Imported | 37 (27, then 10 organisation rows) |
| MISSING at close | **0** |
| Bookings in CRM | 708 |

### What the cutover found that had nothing to do with the cutover

- **The CSV parser could not read the real export.** PPM puts newlines inside
  quoted fields; the line-based parser turned 1070 lines into 1007 fragments, of
  which only 702 had a reference. `import-bookings.js` shared the defect
  independently and would have written the shrapnel to the bookings table. Fixed
  before anything was imported.
- **The import dry run could not fail.** Its duplicate check sat inside
  `if (!isDryRun)`, so it reported "692 rows ready to import" when 665 already
  existed and 27 were new. Fixed; the corrected dry run predicted 27/665/10 and
  the apply matched exactly.
- **$42,315.90 of revenue that never happened.** 126 bookings PPM records as
  cancelled were `completed` in the CRM — 114 updated inside the same two
  minutes on 2026-06-16, none with a Stripe session. A blanket "past event means
  completed" sweep. 125 restored to cancelled; completed revenue went
  $227,035.97 to $186,025.07. One row (26-245) refused because it carries
  `deposit_paid` — a cancelled gig that took money is a refund question.
- **Organisation bookings were unimportable.** PPM leaves Client name empty and
  fills Organisation; the validator rejected every one. Ten real bookings at The
  MAC were being dropped, and schools, libraries and venues all book this way.
- **Brand attribution could not fail.** `booking-form.html` sent no brand and the
  server coerced everything to `fme`. Four writers each kept their own broken
  copy of the rule.

### Deliberately not done

- **The end-to-end gate through a live website button.** Skipped on the owner's
  call, 2026-08-11. Every component was proven separately — form to CRM with
  correct brand and catalogue link, deposit link, webhook, payment, email — and
  all 18 links were crawl-verified to the exact destination. What remains
  unproven is only a human click-through.
- **~32 residual status drifts and 103 price differences.** Benign. 234 of the
  original 329 are PPM `confirmed` vs CRM `completed`, which is the CRM being
  correctly ahead on past gigs; the price ones are the legacy mileage-inclusive
  rows.

### Still open

- Refund the two $1 test charges (`FM-U8UD7BQZ` and the earlier gate booking).
- `26-245` Meagan Lytton — cancelled in PPM but `deposit_paid` in the CRM.
  Refund it, or keep it as a cancellation fee, and record which.
- Revoke the old Resend key, and the unused "Local FM test" key once its Logs
  page shows 30 days without a send.
- Leave PPM read-only. **Do not cancel the subscription** until one full booking
  cycle has run through the CRM.
- Phase 5: the `fmms` brand tier. `_brand.js` already accepts it; what remains is
  admin UI and tier-separated reporting.
