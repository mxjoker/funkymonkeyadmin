# Dashboard Task Summary Widget — Design Spec
*Date: 2026-03-28*

---

## Overview

Replace the standalone staffing warning panel on the dashboard with a unified "Action Needed" card. The card shows three action-oriented badge counts at a glance. Clicking a badge expands an inline mini-table of matching bookings; clicking any row opens the existing booking modal. No page navigation required to act on any item.

---

## Layout

The dashboard stack becomes:

```
Stats Grid (4 tiles — unchanged)
Action Needed card          ← new (replaces #staffing-warnings)
Recent Bookings table       ← unchanged
```

The existing `#staffing-warnings` div is removed and replaced by `#action-needed`.

---

## Action Needed Card

### Badges

Three badges render at the top of the card:

| Badge label | Condition | Color |
|---|---|---|
| `N Needs Review` | `booking.status === 'review'` | Amber |
| `N No Deposit Link` | `booking.status === 'pending' && !booking.stripe_payment_link` | Red |
| `N Unstaffed` | confirmed + event within next 14 days + assigned staff < exclusive slots required | Amber |

"Exclusive slots required" uses the same logic already in `renderDashboard()`: sum `slot_count` for `allServiceSlots` rows where `service_id` matches and `exclusive === true`. If no `allServiceSlots` rows exist for a booking's `service_id`, required = 0 and the booking is treated as fully staffed (not flagged). The 14-day window and date comparison follow the existing `renderDashboard()` implementation exactly (`event_date` field, inclusive of today, cutoff = now + 14 days).

Badges with count 0 are hidden (not rendered).

### Zero state

When all three counts are 0, replace the badge row with:

```
✅ All clear — nothing needs attention
```

Rendered in green text, centered within the card.

### Expand / collapse

Clicking a badge toggles an inline mini-table below the badge row. Only one badge can be expanded at a time — clicking a second badge collapses the first. Clicking the active badge again collapses it.

The expanded table columns:

| Needs Review / No Deposit Link | Unstaffed |
|---|---|
| Ref, Client, Service, Date, Total | Ref, Client, Service, Date |

Each row calls `openBooking(b.id)` on click. Hover highlight matches the existing table row style.

### Staffing detail table

Below a `<hr>` divider at the bottom of the same card, the staffing detail table renders whenever `unstaffedCount > 0`. This is the same data as the old standalone warning panel — ref, client, service, date — with rows clickable to `openBooking()`. Hidden entirely when count is 0.

The "Unstaffed" badge and the staffing detail table always show the same events; the badge is the count, the table is the persistent detail. This is intentional — the detail table is always visible when unstaffed events exist (mirroring the old standalone panel), regardless of whether the badge is expanded.

---

## State Management

A module-level variable `activeActionBadge` (string: `'review'` | `'deposit'` | `'staffing'` | `null`) tracks which badge is expanded. `toggleActionBadge(type)` sets/clears it and calls `renderActionNeeded()`.

All badge counts and expanded lists are computed from data already in memory:
- `allBookings` — loaded at init
- `calStaffMap` — loaded at init
- `allServiceSlots` — loaded at init

No new API endpoints required.

---

## Functions

| Function | Description |
|---|---|
| `renderActionNeeded()` | Computes counts, renders badges, zero state, expanded table, and staffing detail. Called from `renderDashboard()`. |
| `toggleActionBadge(type)` | Toggles `activeActionBadge`, calls `renderActionNeeded()`. |

`renderDashboard()` removes its inline staffing warning block and calls `renderActionNeeded()` instead.

---

## HTML Changes

- Remove: `<div id="staffing-warnings" ...>`
- Add: `<div id="action-needed" class="card"></div>` in the same position

---

## Files Changed

| File | Change |
|---|---|
| `admin.html` | Replace `#staffing-warnings` div with `#action-needed`; update `renderDashboard()` to call `renderActionNeeded()`; remove inline staffing warning block from `renderDashboard()`; add `renderActionNeeded()` and `toggleActionBadge()` functions |

No backend changes. No new API endpoints.

---

## Out of Scope

- Navigating to the Bookings page with a pre-applied filter (future option)
- Notification dot / favicon badge for unread action items
- Sorting or filtering within the expanded mini-tables
