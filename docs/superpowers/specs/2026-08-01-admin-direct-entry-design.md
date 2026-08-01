# Admin Direct Entry — Design

**Date:** 2026-08-01
**Status:** Approved for planning
**Relationship to the CRM takeover:** a prerequisite for
[`2026-07-31-crm-takeover-design.md`](2026-07-31-crm-takeover-design.md) Phase 4.
The CRM cannot take over intake while the only way to create a booking is the
public web form.

## Context

Three gaps were reported by the owner:

1. No way to add an event while on the phone with a client.
2. Event details are not editable after the fact.
3. The client sheet is not editable.

Party Pro Manager was walked screen by screen on 2026-08-01 to compare — the
event list, the add/edit slide-over, the Payments tab, and Contacts. Nothing was
created or saved in PPM during that walkthrough. What follows records what the
comparison found, because the findings changed the design.

### Finding 1 — PPM requires exactly one field to save an event

PPM's `+ EVENT` opens a slide-over in which **Event status is the only required
field**, defaulting to `Processing`. Name, email, date, package, and price are
all optional, and Pricing carries an explicit **"Skip Adding Pricing"** button.
The footer shows a live `[NEW] • NO DATE • Processing` strip. A call can end with
a half-record saved.

FME rejects that outright. `bookings.js:238-256` requires `client_name`,
`client_email`, a parseable `event_date`, and a `service_id` or `service_name`.
On a phone call the email is the field a caller most often cannot supply on the
spot. This is the only genuine backend gap of the three reported problems.

### Finding 2 — PPM edits everything, in place, section by section

PPM uses one slide-over for both creating and editing, titled "Editing Event" in
both cases. It holds fifteen independently editable sections — Contact Details,
Enquiry Details, Event Details, Display Info, Guests of Honour, Attendees, Date &
Time, Venue, Pathway/Package, Pricing, Other Info, Mailing Address, Accounting,
Privacy/Consent, Private Admin Notes — each with its own pencil and its own DONE.
Empty sections advertise their contents: *"Empty in this section: • Address •
Surface type"*.

FME's `openBooking()` (`admin.html:1418`) renders one flat read-only grid, and
`booking.js:90-114` accepts PATCHes only for status, notes, and payment fields.
Event date, time, location, guest count, client contact details, and every price
are unreachable after creation.

### Finding 3 — the client sheet is the one place FME is already ahead

PPM's Contacts tab is not a rich record. It is 385 rows with a search box and
columns for Client/Company, Email/Phone, Child 1/2, Last celebration, and Last
enquiry/event. Clicking a contact does not open a sheet — it jumps to the Events
list pre-filtered by that email. There are no notes, no tags, and no interaction
history.

FME's `clients` table already carries more: `notes`, `tags`, `birthday`,
`follow_up_date`, `preferred_profile`, `annual_event_month`,
`annual_event_note`, plus a `client_interactions` log. `client.js` serves all of
it over GET/PATCH/POST/DELETE and works today.

None of it is reachable. `renderClients()` (`admin.html:2464`) ignores the API
entirely and re-derives a read-only table by aggregating `allBookings` in
JavaScript. The rows are not clickable.

**This feature is a wiring job, not a build.** The only things worth taking from
PPM are the search box and a company-name field.

### Finding 4 — PPM separates approval state from payment state

PPM's status vocabulary:

| PPM | Meaning |
|---|---|
| Unprocessed | arrived, untouched |
| Processing | being worked |
| Pending | awaiting client approval |
| Pending+ | approved, awaiting payment |
| Confirmed | no upfront payment due |
| Confirmed+ | partially paid |
| Balance settled | paid in full |
| Dropped/Cancelled | dead |

FME has five: `review`, `pending`, `confirmed`, `completed`, `cancelled`. They
conflate two independent axes. `confirmed` cannot distinguish "they said yes but
have not paid" from "the deposit landed" from "paid in full", which is why PPM's
event list is legible at a glance and the CRM's is not.

PPM also ships a "Status-Related Validation Issues" filter that surfaces records
whose status contradicts their payment data. Noted, not adopted here.

The CRM takeover spec's Phase 3 `quoted → accepted` transition is precisely PPM's
`Pending → Pending+`, arrived at independently before this comparison.

## Goal

The owner can create a booking during a phone call, edit every field of it
afterwards, and open an editable client record — without leaving the admin
dashboard.

## Non-goals

- `booking_items` and multi-service quotes remain in CRM-takeover Phase 3.
  PPM's `Booking pathway → Chosen package` cascade is that same feature and
  waits for it.
- PPM's fifteen-section accordion is not reproduced. See Decision 2.
- Splitting `admin.html` remains a separate sub-project.
- PPM's "Status-Related Validation Issues" checker is not built.

## Decisions

### Decision 1 — seven statuses, not five and not PPM's eight

Adopted: `draft`, `review`, `quoted`, `accepted`, `confirmed`, `completed`,
`cancelled`.

`draft` is the phone-call shell record. `quoted` and `accepted` split approval
from payment and are what the CRM takeover spec already called for.

Mirroring PPM's full eight was considered and rejected. `Confirmed+ (partially
paid)` and `Balance settled` encode payment progress that FME already derives
from `deposit_paid` and `balance_due` — two more status values would be a second,
divergent copy of facts the money columns already hold.

`status` is `VARCHAR(32) DEFAULT 'review'` with **no CHECK constraint**
(`bookings.js:32`), so the three new values require no DDL whatsoever.

### Decision 2 — one modal, inline fields, single save

PPM's fifteen-section accordion with per-section DONE buttons exists because PPM
has upwards of sixty fields. FME has roughly twenty. An accordion here would be
more chrome than content.

**Chosen: the existing detail modal renders inputs instead of divs, with one
Save.** The "add" form is that same modal opened against an empty record — which
is exactly what PPM does, titling both "Editing Event". One code path, learned
once, works in both places.

### Decision 3 — the deposit becomes its own payment record

`payment_method`, `payment_amount`, and `payment_ref` are a single generic
payment record, and `accounting-export.js:57` already treats them as the final
payment. PPM keeps two separate records — Deposit and Final Balance — each with
its own amount, date requested, date received, method, and reference.

**Chosen: three new deposit-side columns; `payment_*` stays as the balance
record.** `deposit_amount` and `deposit_paid` already exist. This costs three
columns rather than seven and leaves `accounting-export.js` semantics untouched.

### Decision 4 — a `STATUSES` constant, because it deletes code

Status values are hardcoded in eight places in `admin.html`: five CSS pill
classes (`:110-114`), the filter `<option>` list (`:400`), the pill row
(`:1436`), and four dashboard counters (`:1075`, `:1237`, `:1243`, `:1252`).
Adding three values means editing all eight.

One `STATUSES` constant replaces all eight lists. This is deduplication, not
abstraction — it is introduced because it removes more code than it adds.

## Data model changes

Six columns, added through the existing `ADD COLUMN IF NOT EXISTS` block at
`bookings.js:79-121`. No migration script and no new table.

| Column | Type | Why |
|---|---|---|
| `surface_type` | VARCHAR(64) | Grass vs concrete vs indoor changes foam party setup and liability |
| `organisation_name` | VARCHAR(255) | Corporate and library bookings have nowhere to record the org today |
| `occasion` | VARCHAR(64) | `event_type` currently does double duty as both occasion and package |
| `deposit_paid_at` | TIMESTAMP | Deposit as its own record (Decision 3) |
| `deposit_method` | VARCHAR(50) | Deposit as its own record |
| `deposit_ref` | VARCHAR(255) | Deposit as its own record |

No status DDL — see Decision 1.

## Components

Three files change. None are created.

### `netlify/functions/bookings.js`

POST gains an admin path. When the request carries a valid admin token **and**
`status: 'draft'`, the four required-field checks are skipped. Numeric clamping,
length caps, and every other sanitization stay in force. Public form submissions
are unaffected and continue to hit the full validation.

This is the entire backend of the phone-intake feature.

### `netlify/functions/booking.js`

The PATCH `colMap` grows to cover `event_date`, `event_time`, `event_location`,
`event_zip`, `client_name`, `client_phone`, `client_email`, `guest_count`,
`service_id`, `service_name`, `service_price`, `total_price`, and the six new
columns.

`booking-changelog.js` logs by field name, so each newly editable field becomes
traceable at no extra cost — which is the point. The CRM takeover spec states
traceability over speed, and widening the allowlist without the changelog would
invert that.

### `admin.html`

- A `STATUSES` constant replaces the eight hardcoded lists (Decision 4).
- `openBooking()` renders inputs rather than divs, with one Save issuing the
  PATCH.
- A `+ Booking` button opens that same modal against an empty record and POSTs
  as `draft`.
- `renderClients()` reads `client.js` instead of aggregating `allBookings`.
  Rows become clickable and open the `notes`, `tags`, `birthday`,
  `follow_up_date`, and interaction-log fields that already exist server-side.
  A search box and an organisation-name column are added, matching PPM's
  Contacts.

## Data flow

The phone call: `+ Booking` → type whatever the caller has given so far → Save →
the row lands as `draft`. Afterwards it is opened, completed, and moved to
`quoted`. The client accepts and it moves to `accepted`. The deposit clears and
the existing Stripe webhook moves it to `confirmed` — that path is already built
and is not touched here.

## Error handling

- Admin drafts bypass **required-field** checks only. Type coercion, numeric
  clamping, and length caps are unchanged, so a draft cannot write a malformed
  row.
- A draft POST without a valid admin token is rejected. The relaxation is
  authorization-gated, not status-gated, so a public form cannot post itself a
  `draft` to skip validation.
- PATCH continues to reject a body with no recognized fields (`booking.js:129`).
- Client-sheet writes go through `client.js`'s existing PATCH allowlist and its
  empty-string-to-null coercion for date and integer columns
  (`client.js:150-156`).

## Testing

One `test_*.js`, following the repo's existing script convention, asserting:

1. A draft POST carrying only `client_name` succeeds for an admin token.
2. The identical POST is rejected without an admin token.
3. A PATCH of `event_date` writes a `booking_changes` row.

## Risks

| Risk | Mitigation |
|---|---|
| The relaxed POST path becomes a validation bypass | Gated on a valid admin token, not on the `draft` value alone |
| Drafts accumulate as silent junk in the bookings table | `draft` is a distinct status and filterable; it is excluded from the dashboard counters that drive daily work |
| Widening the PATCH allowlist makes historical bookings silently editable | `booking-changelog.js` records every field-level change; this is why the changelog extension ships with the allowlist rather than after it |
| A wrong `event_date` edit desynchronizes a booking from a sent confirmation email | Out of scope here; the CRM takeover's `EMAIL_ALLOWLIST` guard is in force during this work |

## Assumptions

- `EMAIL_ALLOWLIST` from CRM-takeover Phase 1 is set to the owner's address while
  this work proceeds. Nothing in this design sends mail, but the editable fields
  feed templates that do.
- The `clients` table and `client.js` behave as their code reads. They have never
  been exercised through the UI, so the implementation plan verifies them against
  the live database before the client sheet is wired to them.
