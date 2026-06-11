# API Contract — Auth & Access Rules

Effective with the June 2026 hardening. Shared modules: `netlify/functions/_db.js`
(pool — every function MUST use `getPool()`/`withClient()`, never `new Pool`),
`netlify/functions/_auth.js` (sessions, CORS, helpers).

## Auth model

- `POST /api/auth` with `{password}` returns `{success, role, token, expiresAt, staffId?, staffName?, staffColor?}`.
- Protected calls send `Authorization: Bearer <token>`.
- `_auth.requireAuth(event, roles?)` validates; returns `{role, staffId, tokenHash}` or null.
- Handlers must: call `preflight(event)` first (returns 204 for OPTIONS), use the
  shared `CORS` headers from `_auth.js` on every response, and return
  `unauthorized()` / `forbidden()` from `_auth.js` on failure.
- Staff scoping rule: when `auth.role === 'staff'`, any `staff_id` taken from
  query/body/path MUST be ignored and replaced with `auth.staffId` (or the
  request rejected with `forbidden()` if it names another staff member).
  Admin sessions may act on any staff_id.

## Per-endpoint access

| Endpoint | Public | Staff token | Admin token |
|---|---|---|---|
| POST /api/auth (login/check/logout) | yes (rate-limited) | — | set_admin_password |
| GET /api/services | yes (read catalogue) | yes | yes |
| POST /api/services (catalogue writes) | no | no | yes |
| POST /api/bookings (new booking) | yes — validated, see below | yes | yes |
| GET /api/bookings?reference=X&email=Y | yes — BOTH params required, email must match booking (case-insensitive); returns PUBLIC FIELD SUBSET only | — | full row |
| GET /api/bookings (list/all/filters) | no | no | yes |
| GET /api/booking/:id | no | yes (only if assigned — if too complex, admin-only) | yes |
| PATCH/DELETE /api/booking/:id | no | no | yes |
| GET /api/staff | no | yes — SAFE FIELDS, never pin/access_code_hash | yes — never pin/access_code_hash |
| GET /api/staff/:id | no | self only | yes |
| PATCH /api/staff/:id | no | self only, LIMITED FIELDS: preferred_name, pronouns, color, phone, email, comms_preference, skills, shared_notes, staff_notes. Never: pay rates, role, active, pin, access_code_hash | yes (any field except direct hash writes) |
| POST /api/staff, DELETE /api/staff/:id | no | no | yes |
| POST /api/staff/:id {action:'regenerate_access_code'} | no | no | yes — returns plaintext code ONCE |
| GET /api/staff-assignments?staff_id=N | no | self only | yes |
| GET /api/staff-assignments (other reads: all, booking_id, service_slots, time_templates) | no | yes (read-only) | yes |
| POST /api/staff-assignments — staff actions (express_interest, update_checklist, submit_survey) | no | yes, scoped to own staffId | yes |
| POST /api/staff-assignments — assign/unassign/notify/admin actions | no | no | yes |
| GET /api/staff-payments?staff_id=N | no | self only | yes |
| All other staff-payments methods | no | no | yes |
| /api/payroll* (all) | no | GET ?staff_id= self only | yes |
| /api/automations (all) | no | no | yes |
| /api/refund | no | no | yes |
| /api/create-stripe-link | no | no | yes (validate booking exists, 0 < amount ≤ 10000) |
| GET /api/generate-invoice/:reference?email=Y | yes — email must match booking | — | yes (no email needed) |
| GET /api/accounting-export | no | no | yes |
| /api/add-indexes, /api/import-bookings | no | no | yes |
| POST /api/coi-request | yes — must include booking reference + matching client email | — | yes |
| GET/PATCH /api/coi-request | no | no | yes |
| /api/client, /api/booking-changelog | no | no | yes |
| /api/staff-feedback/* | no | survey submit, scoped | yes |
| /api/stripe-webhook | Stripe signature REQUIRED (fail-closed: reject if STRIPE_WEBHOOK_SECRET unset or signature missing/bad) | — | — |

## Public booking field subset

For unauthenticated `GET /api/bookings?reference&email` (and the data embedded in
invoice/COI flows), return ONLY:
`reference, status, service_id, service_name, event_type, event_date, start_time,
end_time, guest_count, venue_name, event_address, client_name, addons,
total_price, mileage_cost, deposit_amount, deposit_paid, balance_due,
payment_amount, created_at`.
Never expose: internal/admin notes, staff assignments or costs, other clients'
data, id-based enumeration (public lookups are by reference+email only).

## POST /api/bookings validation (public)

- Require: client_name (≤120 chars), valid-looking client_email (≤200),
  event_date parseable date, service_id/service_name present.
- Clamp numerics (guest_count 0–10000, prices 0–100000); reject if NaN.
- Trim all strings; cap any free-text field at 5000 chars.
- Booking creation must NOT fail if email/SMS notification fails (log instead).

## Email HTML safety

Any user-supplied value (client_name, notes, venue, etc.) interpolated into
email HTML must go through an HTML-escape helper (exported from `_email.js` as
`esc`). Same for values echoed into PDF/text where markup applies.

## Error & response conventions

- JSON errors: `{ error: string }` with appropriate status (400/401/403/404/429/500).
- Never leak raw error messages/stack traces from 500s; log via console.error.
- `client.release()` must be unreachable-safe: use `withClient()` from `_db.js`,
  or `let client` + `try { client = await getPool().connect(); ... } finally { if (client) client.release(); }`.

## Schema ownership

- `email_log` schema is owned by `_email.js`; other files must not CREATE it
  with a different shape — add columns via `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`.
- `booking_changes` schema is owned by `booking-changelog.js`
  (field_name/old_value/new_value); `_email.js`'s competing definition must be
  reconciled to it the same way.
