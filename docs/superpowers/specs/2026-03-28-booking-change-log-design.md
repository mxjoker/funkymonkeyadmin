# Booking Change Log / Audit Trail — Design Spec
*Date: 2026-03-28*

---

## Overview

Add a read-only activity log to each booking that records high-signal changes — status transitions, payments, contract, admin notes, and Stripe deposit. Displayed as an "Activity" section at the bottom of the booking modal.

---

## Database

New table: `booking_changes`

```sql
CREATE TABLE IF NOT EXISTS booking_changes (
  id         SERIAL PRIMARY KEY,
  booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  action     VARCHAR(100) NOT NULL,
  detail     TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_booking_changes_booking_id ON booking_changes(booking_id);
```

`ON DELETE CASCADE` ensures rows are cleaned up when a booking is deleted. Both statements must use the `IF NOT EXISTS` guard — called on every handler invocation, including warm starts.

---

## Backend

### `logChange(client, bookingId, action, detail)` — lives in `_email.js`

Exported from `_email.js` alongside `sendEmail`, `logEmail`, etc. Both `booking.js` and `stripe-webhook.js` import it — no cross-function dependency.

```javascript
async function logChange(client, bookingId, action, detail = '') {
  await client.query(
    'INSERT INTO booking_changes (booking_id, action, detail) VALUES ($1, $2, $3)',
    [bookingId, action, detail || '']
  );
}
```

### `ensureBookingChanges(client)` — lives in `_email.js`

```sql
CREATE TABLE IF NOT EXISTS booking_changes (...);
CREATE INDEX IF NOT EXISTS idx_booking_changes_booking_id ON booking_changes(booking_id);
```

Called at the top of both `booking.js` and `stripe-webhook.js` handlers before any `logChange()` call. Both statements must be idempotent (`IF NOT EXISTS`).

### Logged events

| Where | Trigger | `action` | `detail` |
|---|---|---|---|
| `booking.js` PATCH | Status change | `"Status changed"` | `"pending → confirmed"` |
| `booking.js` PATCH | Payment recorded | `"Payment recorded"` | `"$450.00 cash — Ref: #1234"` |
| `booking.js` PATCH | Contract signed | `"Contract signed"` | — |
| `booking.js` PATCH | Contract unsigned | `"Contract unsigned"` | — |
| `booking.js` PATCH | Admin notes saved | `"Admin notes updated"` | — |
| `stripe-webhook.js` | Deposit paid | `"Deposit paid via Stripe"` | `"$150.00"` |

### Payment detection logic

A "Payment recorded" log entry is emitted when `payment_amount` **and** `payment_method` are both present in the same PATCH payload. Detail format: `"$<amount> <method>"` with ref appended as `" — Ref: <ref>"` if `payment_ref` is present.

### Admin notes caveat

`saveAdminNotes` patches unconditionally — spurious "Admin notes updated" entries may be logged if the user saves unchanged content. Acceptable for a single-admin tool.

### GET handler in `booking.js`

`GET /api/booking/:id?activity=true` returns `{ changes: [...] }` ordered by `created_at DESC`.

`booking.js` currently has no GET branch at all (an existing gap — plain GET returns 405). This task does not add a plain GET handler; it only adds the `?activity=true` branch. The 405 on plain GET is an unresolved gap, not an intentional design decision, and is left for a future task.

---

## `stripe-webhook.js` cleanup (in scope for this task)

`stripe-webhook.js` currently defines its own local `sendEmail` and `wrap` functions, duplicating what `_email.js` exports — in violation of the project's architectural rule ("Email goes through `_email.js`. Never duplicate email sending logic."). Since this task already adds imports from `_email.js` to this file, clean up the duplication at the same time:

- Remove local `sendEmail` and `wrap` definitions
- Import `sendEmail`, `wrap`, `logEmail`, `logChange`, `ensureBookingChanges` from `_email.js`
- Add `logEmail` calls after the deposit-paid confirmation emails (these sends are currently not logged to `email_log`, creating a gap visible in the booking modal)

---

## Frontend (`admin.html`)

### Modal HTML

New "Activity" section added inside the `currentUser?.role === 'admin'` guard, after the existing "Emails Sent" section:

```
✅ Admin Checklist
📧 Emails Sent
📋 Activity          ← new
```

### Loading

`loadBookingActivity(bookingId, container)` called in `openBooking()` alongside `loadBookingEmailLog()`. Same pattern.

Fetches `GET /api/booking/:bookingId?activity=true`.

### Display

Each entry rendered consistently with the email log format:
- Timestamp: `toLocaleDateString('en-US', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' })`
- Action: bold
- Detail: muted text on the same line, omitted if empty

Newest entries at top. Empty state: `"No activity recorded."` Read-only.

---

## Files Changed

| File | Change |
|---|---|
| `netlify/functions/_email.js` | Add `logChange()`, `ensureBookingChanges()`, export both |
| `netlify/functions/booking.js` | Import `logChange`, `ensureBookingChanges`; call `ensureBookingChanges` at handler start; add GET `?activity=true` handler; add `logChange` calls at 5 action points |
| `netlify/functions/stripe-webhook.js` | Remove local `sendEmail`/`wrap` duplicates; import `sendEmail`, `wrap`, `logEmail`, `logChange`, `ensureBookingChanges` from `_email.js`; add `logChange` call on deposit paid; add `logEmail` calls for deposit emails |
| `admin.html` | Activity section in modal HTML (inside admin guard), `loadBookingActivity()` function, call in `openBooking()` |

---

## Out of Scope

- Plain `GET /api/booking/:id` handler — existing gap, future task
- "Booking submitted" entry on creation — future consideration
- `changed_by` attribution — always Admin, no column needed at this stage
