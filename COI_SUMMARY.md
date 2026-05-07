# Enhanced COI Request System — Technical Summary

## Overview
Replaced placeholder COI button with complete database-backed system that tracks requests and notifies Joe via email.

## What It Does
1. **Client requests COI** → Button on confirmation or my-booking page
2. **Request logged to database** → `coi_requests` table with timestamp
3. **Email sent to Joe** → Branded notification with all booking details
4. **Joe tracks in admin** → View all requests, mark as fulfilled

## Files Created
- `netlify/functions/coi-request.js` (311 lines)

## Files Modified
- `netlify.toml` — Added 2 routes
- `confirmation.html` — Replaced alert with API call
- `my-booking.html` — Replaced alert with API call
- `admin.html` — Added COI tracking section
- `INSTRUCTIONS.md` — Full documentation

## Database Schema
```sql
CREATE TABLE coi_requests (
  id SERIAL PRIMARY KEY,
  booking_id INTEGER REFERENCES bookings(id),
  requested_at TIMESTAMPTZ DEFAULT NOW(),
  requested_by_email TEXT NOT NULL,
  requested_from TEXT,
  fulfilled BOOLEAN DEFAULT FALSE,
  fulfilled_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

## API Endpoints
- `POST /api/coi-request` — Create request
- `GET /api/coi-request/:booking_id` — Get all requests for booking
- `PATCH /api/coi-request/:id` — Mark as fulfilled

## Email Notification
- Subject: `🔐 COI Request — FM-XXXXXX (Client Name)`
- Includes: booking reference, client info, service, date, venue, location
- Shows: who requested, from which page, timestamp
- Logged to `email_log` table

## Admin UI
- Auto-loads when opening booking modal
- Pending requests: yellow background, "Mark Fulfilled" button
- Fulfilled requests: green background, timestamp shown
- Shows full request history per booking

## Production Deploy
```bash
git add netlify/functions/coi-request.js netlify.toml confirmation.html my-booking.html admin.html INSTRUCTIONS.md COI_REQUEST_HANDOFF.md COI_SUMMARY.md
git commit -m "feat: Enhanced COI request system with DB tracking and email notifications"
git push
```

## What's Next
All high-priority core features are complete! Next medium-priority feature: Staff Feedback Loop.
