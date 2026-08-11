# Roadmap

## Backlog

Open items, newest first. Nothing here is blocking.

### Added 2026-08-11 — the next three projects

**1. Back up `~/BookingHQ` — DONE 2026-08-11.**
Was: no remote, 10 commits, last 2026-07-05, 244 uncommitted files, 35 MB of
lead pipeline and client base, none of it reconstructible from the CRM.
- [x] Private remote — `github.com/mxjoker/bookinghq`
- [x] Ignore rules decided: `.backups/`, `.tmp/`, `.playwright-mcp/`,
      `.claude/worktrees/`, `_index/locks/`, `_index/edit-backup-*`, and the
      generated `brain-health.json` files. Kept `_index/index.json`,
      `correlations.json` and `files/` — no rebuild script, so not regenerable.
      All 1036 committed files scanned for live credentials first.
- [x] Automated — `scripts/backup-push.sh`, LaunchAgent
      `com.joecoover.bookinghq-backup`, daily 19:00. Verified by watching the
      agent commit and push on its own.

**2. One memory contract across every system — MOSTLY DONE 2026-08-11.**
- [x] Vault found (iCloud, 248 notes) and **revived rather than retired**. It had
      the best structure of the three brains and was the dead one — untouched
      2026-04-15 to 2026-08-11. Structure does not keep a brain alive; a writer
      does.
- [x] Contract written: `~/.claude/CLAUDE.md`, loaded in every session, every
      project. States which brain owns what and how to choose.
- [x] `Entities/` in the vault is the cross-project layer, registered on
      `00-DASHBOARD.md`. Claude memory is siloed across 10 project dirs that
      cannot see each other; entity pages are the shared home.
- [x] The librarian: `BookingHQ/scripts/brain-lint.mjs`, weekly via
      `com.joecoover.brainlint`, surfaced in The Booth. Reports, never edits.
- [ ] **Still open — the other consumers.** Otto and the website hooks do not
      know the contract exists; they still write where they always wrote. This
      is the "all systems on the same page" half and it is real work.

**3. Whole-system review for improvements and efficiencies.**
Three repos, three deploy stories, several integrations that grew separately.
- [ ] Map what talks to what, and where the same job is done twice
- [ ] Look for the duplication pattern this codebase keeps producing — one rule
      implemented in four places (see [[brand-rule-lives-in-one-place]]) and two
      CSV parsers that disagreed
- [ ] Deliverable is a ranked list with a cost estimate per item, not a rewrite

**Housekeeping from the cutover** — closed 2026-08-11 unless noted
- [x] $1 test charges — one refunded, the other left to settle into the account
- [x] `26-245` Meagan Lytton — **fee kept**, recorded as a cancellation fee
      transferable to a future booking. Status set to `cancelled`, decision in
      `payment_ref` and the changelog.
      **Still open:** neither the CRM nor the PPM export records the AMOUNT, so
      the credit cannot actually be applied. Find it in Stripe (2026-05-14,
      Corporate Magic Show) and set `deposit_amount`.
- [x] Resend keys rotated and the old ones cleared
- [x] Stripe restricted key in `_config/stripe.local.json` — **decided not to
      rotate** 2026-08-11. Only a partial key was ever exposed, and it was never
      committed. Recorded so it is not raised again.
- [ ] **Do not cancel the PPM subscription** until a full booking cycle has run
      through the CRM

**Known gaps, each with a reason it was left**
- [ ] **No booking link on the homepage**, `/camps`, `/snow`, `/faqs`,
      `/foam-faqs`, `/blog` or the three venue pages. Traffic with no path to
      book. Cheapest revenue available.
- [ ] **178 bookings unlinked to a catalogue service** — "Custom Event" (161),
      "Magic Show" (11) and one-off titles. Genuinely ambiguous; link by hand in
      the Quote Breakdown. Never guess these into `_service-map.js`.
- [ ] **Multi-service bookings only staff their first line item.**
      `rollupItems()` takes `services[0]`, so a foam party + face painting
      resolves staff for the foam party alone. Lives in the staffing subsystem,
      which Connecteam has already won.
- [ ] **Public form bookings carry no line items** until their quote is first
      edited. Reads fall back to legacy columns, so nothing breaks; Phase 3's
      machinery just starts on first edit.
- [ ] **`/api/health` has no UI.** Phase 1 built the endpoint; checking it still
      means curl or the browser console.
- [ ] ~32 residual status drifts and 103 price differences vs the final PPM
      export. Benign — see `docs/CUTOVER.md`.

**Separate sub-projects, specced but not started**
- [ ] Phase 5 — the `fmms` brand tier. `_brand.js` already accepts it; what
      remains is admin UI and tier-separated reporting.
- [ ] `admin.html` is ~300 KB in one file
- [ ] Repo and deploy cleanup — `docs/archive/` holds dead handoff documents

## Phase 4 — PPM cutover (COMPLETE, executed 2026-08-10/11)

Plan: `docs/superpowers/plans/2026-08-05-crm-takeover-phase-4.md`
Runbook and outcome: `docs/CUTOVER.md`

**The CRM is the system of record.** 18 website booking links moved off
`partypromanager.com`, the 702-row final export reconciled to MISSING=0, and the
CRM holds 708 bookings.

What shipped: `_csv.js` (one parser, shared with the reconciler);
`scripts/reconcile-ppm-export.js` (read-only three-bucket diff);
`_brand.js` (one brand rule, replacing four private copies);
`booking-form.html` declaring its brand; an editable deposit where `$0` genuinely
means no deposit; `+ Booking` on the calendar and dashboard.

Four defects surfaced only when real data went through the real path — a CSV
parser that fragmented 702 records into 1007, a dry run that could not fail,
$42,315.90 of revenue from cancelled gigs, and organisation bookings that could
not be imported at all. All four are written up in `docs/CUTOVER.md`.

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
