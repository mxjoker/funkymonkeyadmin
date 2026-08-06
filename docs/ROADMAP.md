# Roadmap

## Phase 4 — PPM cutover (staged 2026-08-06, not yet executed)

Plan: `docs/superpowers/plans/2026-08-05-crm-takeover-phase-4.md`
Runbook: `docs/CUTOVER.md`

Code is committed and tested but **not deployed** — Phase 4 ships in one
publish at cutover time. What is staged:

- `_csv.js` — one CSV parser shared by `import-bookings.js` and the new
  reconciler, so a reconciliation diff can never be a parser disagreement.
- `scripts/reconcile-ppm-export.js` — read-only diff of a PPM export against
  `bookings` on `reference`, in three buckets. Never writes; remediation stays
  in `import-bookings.js`.
- `_brand.js` — the single brand rule. Four writers previously decided brand
  for themselves; `create-bookings.js` would have rejected `fmms` while
  `bookings.js` silently coerced it to `fme`.
- `booking-form.html` now declares `brand: 'fme'` instead of relying on a
  column default, which is what made the cutover gate capable of failing.

Two assumptions the first real run corrected, both recorded in the runbook:
PPM's `Tot. price` is travel-inclusive (a raw column diff flags every travelled
booking), and PPM does **not** win on payment state (money reaches the CRM by
routes PPM never sees).

Blocking nothing. Remaining work is executing the runbook.

## Phase 3 — booking_items and client quote accept (complete, 2026-08-02)

`booking_items` is live: a child table making multi-service packages
expressible, with write endpoints (`bookings.js` POST, `booking.js` PATCH)
deriving the legacy money columns (`total_price`, `balance_due`, etc.) from
items via `rollupItems`. Invoice PDF, accounting export, and the client/admin
booking views all read line items now, not just the legacy single
`service_name` + `service_price` columns.

**Backfill, as actually reported by the script (not estimated):**
- Initial backfill applied to production 2026-08-01: 933 `booking_items` rows
  across 666 of 667 bookings (the 667th, the designated test row, had no
  `service_name` and correctly got none). Additive only — `sum(total_price)`
  unchanged at $276,738.29, verified by md5 checksum over the money columns
  before/after.
- Task 7b mileage-normalisation fix (2026-08-02) corrected 83 bookings that
  stored `total_price` inclusive of `mileage_cost`, which had caused the
  backfill to double-count travel inside a balancing line. Net effect:
  `booking_items` row count 937 → 859, balancing ("Unitemised balance
  (pre-Phase-3 import)") lines 168 → 90, `total_price` fell by exactly
  $8,104.32 in aggregate. `balance_due` did not move for any booking —
  the corrected formula reproduces what was already stored.

**Legacy columns are still populated** — `service_name`, `service_price`,
`total_price`, `mileage_cost`, `balance_due`, `deposit_amount` continue to be
written on every quote/booking write, kept in sync from `booking_items` via
`rollupItems`. This is the deliberate rollback window: nothing downstream
that still reads the legacy columns directly will break. Once every consumer
is confirmed on items-based reads and this window has run long enough to
trust, the legacy columns can be deprecated — not scheduled yet.

Client-facing quote accept shipped in the same phase: `quoted` → `accepted`
via `my-booking.html`'s Accept button, `/api/accept-quote`, and an owner
email notification (`email_log`, trigger `Quote accepted`).

Gate (a 3-service package in all three consumers) run against test booking
`FM-E5EFPPQX` (id 717) 2026-08-02: client view, invoice PDF, accounting
financials export (`Line Items` column), and revenue-by-service export
(apportioned across the three services) all confirmed correct. Full detail
in `.superpowers/sdd/2026-08-01-crm-takeover-phase-3/task-8-report.md`.

## Instant Booking v2 (foam parties)

The original `instant-book.html` (now in `docs/attic/`) let anyone create a
booking with no contact info — retired June 2026. The replacement, per Joe:

**Goal:** for foam gigs that are **at least two weeks out** on a date with a
**clear calendar**, let the client book and pay the deposit instantly —
no quote round-trip.

Design notes agreed so far:

- **Availability gate (server-side):** booking date must be ≥ 14 days from
  today AND have no conflicting confirmed/pending booking on the calendar
  (check `bookings` by event_date; later refine to time-window overlap).
- **Mileage from a local zip table — no API lookups.** New table
  `zip_mileage (zip VARCHAR(5) PRIMARY KEY, miles NUMERIC, fee NUMERIC)`
  seeded from Joe's service area, editable from an admin Catalogue section.
  Quote = service price + zip fee. Zips not in the table → fall back to a
  manual-quote path (no instant booking).
  - Note: `payroll.js` already contains a hardcoded OKC-metro zip→lat/lng map
    used for drive-time estimates; the new table should become the single
    source of truth and that map can read from it later.
- **Flow:** client picks foam service + date (validated) → enters contact
  details (required, validated like /api/bookings) → server creates booking
  with status `pending` + creates a Stripe Checkout session for the deposit →
  webhook confirms to `confirmed` on payment (existing fail-closed webhook
  already handles this).
- **Safety rails:** rate-limit instant-book creation per IP; cap one
  unpaid instant booking per email; expire unpaid instant bookings after
  24h (the Stripe link already expires in 24h).

## SMS (removed)

`netlify/functions/_sms.js` was a complete Twilio sender that nothing ever
called. It was deleted on 2026-07-31 rather than left as dead code. To revive
it, recover the file from git history (`git log --diff-filter=D -- netlify/functions/_sms.js`)
and see `docs/archive/SMS_IMPLEMENTATION_GUIDE.md` for the wiring notes.
