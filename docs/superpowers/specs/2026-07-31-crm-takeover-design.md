# CRM Takeover — Design

**Date:** 2026-07-31
**Status:** Approved for planning
**Sub-project 1 of 4** in the backend consolidation effort.

## Context

The Funky Monkey admin CRM (`funkymonkeyadmin.netlify.app`, this repo) was built
to replace Party Pro Manager (PPM). It never took over. Today PPM still owns the
three workflows that matter, and the CRM is a downstream shadow copy kept in sync
by a CSV export chain.

Who actually does what, as of 2026-07-31:

| Job | System |
|---|---|
| Booking intake (public link) | PPM |
| Quoting | PPM |
| Deposit collection | PPM |
| Staff scheduling | Connecteam |
| Paying staff | Manual |
| Lead intake | GigSalad, Bark, website form, phone/referral |
| Drafting & follow-up | Booked Solid (Otto), `~/BookingHQ` |
| Historical record | **The CRM** |

The CRM's sync machinery exists *because* it is downstream of PPM. That machinery
is the double-entry problem, not the fix for it.

The CRM is closer to a full replacement than its usage suggests. `bookings`
already carries `service_price`, `addons`, `addon_total`, `mileage_cost`,
`total_price`, `deposit_amount`, `balance_due`, `deposit_paid`,
`stripe_session_id`, `is_custom_quote`, and `extra_hours`. 25 services are seeded
with real prices. `booking.js:154` already auto-generates a Stripe deposit link on
status change. `booking-form.html` already posts to `/api/bookings`.
`my-booking.html` already authenticates clients by `reference` + `email`.

Most of the replacement was built. The switch was never thrown.

## Goal

The CRM becomes the system of record for intake, quoting, and deposits. PPM goes
read-only.

**Owner priority, stated explicitly:** traceability and correctness over speed.
An extra session is acceptable; an untraceable shortcut is not.

## Non-goals

- Connecteam stays. Staff scheduling is not moving.
- GigSalad and Bark stay manual — they are respond-in-platform by design.
- The Astro website deploy and DNS cutover are a separate project, scheduled
  after this one. Phase 4 patches the existing Wix button.
- `admin.html` (279 KB, single file) is not split here. Separate sub-project.
- Memory consolidation and the `~/BookingHQ` backup are separate sub-projects.
- The staffing subsystem is **retained** at the owner's request (see Decision 3).

## Decisions

### Decision 1 — `booking_items` table, not line-items-as-add-ons

A booking today holds exactly one primary service plus small upsells. The `addons`
catalogue is five items (Extra Hour $85, Glitter Tattoos $75, Balloon Animals $75,
Photo Booth $150, Second Performer $175) — it is not the services catalogue. A
multi-service package such as "Foam Party + Face Painting + Cotton Candy" cannot
be expressed.

Two options were considered. Reusing the `addons` JSONB blob for secondary
services would have required no schema change and about a day's work, but it
blurs revenue attribution and leaves quote history unreadable — a foam party sold
as an add-on reports under add-ons forever.

**Chosen: a real `booking_items` child table.** One row per service on a booking.
It costs roughly four days and a migration, and it is the option consistent with
the traceability priority: per-item rows give `booking-changelog.js` something
meaningful to record as a quote is revised.

### Decision 2 — `EMAIL_ALLOWLIST` guard before any email fix

`_email.js:101` checks `if (data.error)`. Resend returns errors as
`{statusCode, message, name}` — there is no `error` field. Every automation email,
booking confirmation, deposit link, and staff notification can fail while logging
`Email sent to: ... | id: undefined`. `_email.js:93` compounds this by returning
`undefined` when the key is missing, and `sendEmail` never throws, so the
try/catch at `create-stripe-link.js:96` can never fire.

Fixing this function wakes every dormant send in the system simultaneously. Rule 8
is active, automations have been running, and `staff-assignments.js:576` emails
real staff. A correct fix, deployed alone, could send Troy, Vanessa, and Amie a
backlog of notifications for gigs that already happened.

**Chosen: an `EMAIL_ALLOWLIST` env var checked inside `sendEmail`.** When set,
only listed addresses send; everything else logs what it would have sent and
returns. Set to the owner's address for Phases 1–3, cleared at cutover. One guard,
in the single function every send routes through.

### Decision 3 — Staffing subsystem retained

`staff.js`, `staff-assignments.js`, `staff-payments.js`, `staff-feedback.js`,
`payroll.js`, `payroll-scheduled.js`, and `staff-portal.html` are confirmed unused
— Connecteam won, and staff have never logged into the portal. They were slated
for deletion.

The owner wants them retained to continue experimenting. The runtime cost is
approximately zero: the weekly `payroll-scheduled` cron writes `payroll_runs` rows
and sends nothing. They are retained, excluded from Phase 1's trust verification,
and covered by the `EMAIL_ALLOWLIST` guard like everything else.

### Decision 4 — Wix button first, Astro later

`funkymonkeyevents.com` is still served by Wix; the Astro rebuild sits undeployed
at `funky-monkey-events.netlify.app`. Phase 4 repoints the existing Wix Book Now
button at the CRM. This keeps the cutover's rollback to a two-minute button
change and decouples it from a website launch.

## Data model changes

### New: `booking_items`

One row per service on a booking. Existing `bookings.service_*` columns remain
populated and in sync through a deprecation window rather than being dropped, so
a wrong migration loses nothing.

Backfill: each of the ~632 existing bookings becomes exactly one line item derived
from its `service_id` / `service_name` / `service_price`.

### Changed: `email_log`

Gains a `status` column and a failure reason. It currently records attempts, not
outcomes — a row reading "sent" proves nothing today.

### Changed: `bookings.brand`

Grows a third value, `fmms`, so Funky Monkey Magic Shows is expressible alongside
`fme` and `jcm`. The business is one company (FME) with JCM as a Joe-only premium service;
Funky Monkey Magic Shows exists specifically to take lower-paid magic work without
eroding JCM's rates. A two-value field cannot express the distinction that
protects those rates.

### New: `booking_items` changelog coverage

`booking-changelog.js` extends to log line-item add, remove, and reprice events.

## Phases

Each phase has one hard gate. A failed gate stops that phase; it is not deferred.

### Phase 1 — Clear & trust (~2 days)

1. `EMAIL_ALLOWLIST` guard in `sendEmail` (first, before any other email change)
2. Fix `sendEmail`: correct the Resend error shape to `!res.ok || data.statusCode
   || data.name`, and throw instead of returning `undefined`
3. `email_log.status` column + failure reason
4. Fix `create-stripe-link.js:69` — its description hardcodes "50% deposit" while
   `booking.js:14` and the schema default use a flat $100. A client paying $100 on
   a $3,500 game show currently receives an email calling it a 50% deposit.
5. Add `GET /api/health` (admin-only): Resend key + domain verification, Stripe
   key present and live-vs-test, `STRIPE_WEBHOOK_SECRET` present, DB reachable,
   which `automation_rules` are active, last successful email, last webhook
   received
6. Repo hygiene: `FME Passcodes/` into `.gitignore` or moved out of the repo
   entirely (recommended — 8 screenshots of staff passcodes currently sit
   untracked and un-ignored, one `git add -A` from publication). Commit or revert
   the 23 pending working-tree files. Reconcile `docs/ROADMAP.md`, which documents
   an SMS sender that has been deleted.

**Gate:** `sendEmail` throws on a bad key (self-check); `/api/health` reports every
dependency truthfully; the allowlist demonstrably blocks a non-listed address.

### Phase 2 — Prove the money path (~2 days)

One real end-to-end run in live mode: booking form → quote → deposit link → **real
$1 charge** → webhook fires → status flips to `confirmed` → confirmation email
received. Refund afterward.

This is the project's real go/no-go. If live Stripe does not work, Option B stops
here having cost four days rather than three weeks.

**Gate:** the full loop completes once, for real, with the charge visible in
Stripe and the status change visible in the DB.

### Phase 3 — `booking_items` + client-facing accept (~4 days)

1. `booking_items` table, backfill, changelog coverage
2. Admin UI: build a multi-service quote
3. Client accept flow: a `quoted` → `accepted` status transition, an Accept button
   on the existing `my-booking.html`, an endpoint, and a notification to the owner.
   The client-side authentication (`reference` + `email`) already exists and is
   reused.

**Gate:** a 3-service package quote renders correctly in the client view, the
invoice PDF, and the accounting export — all three, because all three read line
items.

### Phase 4 — Cutover (~2 days)

Repoint the Wix Book Now button at the CRM booking form. PPM becomes read-only.
Final PPM export reconciled against the CRM by `reference` (= PPM `Ref.`), which
is the established strong key. Clear `EMAIL_ALLOWLIST`.

**Gate:** a real test booking placed through the Wix button lands in the CRM with
correct brand attribution.

### Phase 5 — Brand tiers (~1 day)

Third `brand` value, admin UI support, and reporting that separates JCM revenue
from Funky Monkey Magic Shows revenue.

**Gate:** a booking can be created under each of the three brands and reports
separate correctly.

**Total: ~2.5 weeks.**

## Rollback

A git tag precedes each phase, following the existing `pre-hardening` convention.

Phase 4 is the only one-way door, and its rollback is repointing the Wix button —
a two-minute change. Phase 3's migration keeps the legacy `service_*` columns
populated throughout the deprecation window, so the new table can be abandoned
without data loss.

## Risks

| Risk | Mitigation |
|---|---|
| Fixing `sendEmail` blasts dormant mail at real clients and staff | `EMAIL_ALLOWLIST` lands first, in the same function |
| Live Stripe has never taken money through the CRM | Phase 2 is a hard gate before any further investment |
| Resend domain may still be unverified | Phase 1 `/api/health` reports it explicitly rather than assuming |
| `booking_items` migration corrupts 632 real historical bookings | Legacy columns retained and kept in sync; backfill is one item per booking; tagged rollback point |
| Booking history is real imported data, not test data | Never bulk-delete. `created_at` is uniformly the 2026-05-07 import date, so urgency must be judged by `event_date` |
| Cutover loses in-flight PPM bookings | Final reconciliation by `reference` before the button moves |

## Assumptions

- PPM offers no API; final reconciliation uses the CSV export the existing co-work
  session already produces. If an API exists, reconciliation gets easier, not
  harder — this assumption is safe in the pessimistic direction.
- Netlify CLI is not logged in on this machine, so production environment
  variables must be read and set through the Netlify web dashboard by the owner.

## Related, out of scope

Sub-projects 2–4, to be specced separately:

2. **Memory consolidation** — Claude memory is split across 10 project
   directories, and this repo's own memory directory is empty; facts about
   FME-Backend live under unrelated projects. `~/BookingHQ` has commits but **no
   git remote** — the brain, including 441 deduped clients, is unbacked-up. The
   Obsidian vault (245 notes, last touched 2026-04-15) needs a revive-or-retire
   call.
3. **`admin.html` split** — 279 KB in one file.
4. **Repo and deploy cleanup** — `docs/archive/` holds 23 dead handoff documents;
   three repos have three different deploy stories.

One unrelated fix folded into Phase 1 because it is a one-line change: Otto's
sweep moves from 07:00 to the previous evening. The owner leaves early for shows
and has been reading the "morning" briefing as a nightly report.
