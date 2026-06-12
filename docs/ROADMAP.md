# Roadmap

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

## SMS (built, not wired)

`netlify/functions/_sms.js` is a complete Twilio sender that nothing calls.
To activate: Twilio account + number + A2P 10DLC registration, set
`TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_PHONE_NUMBER` in
Netlify, then wire into: staff gig-assignment notifications (staff
`comms_preference = 'sms'` already exists in the portal) and client deposit
link delivery.
