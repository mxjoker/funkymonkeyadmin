# Funky Monkey Events — Admin Platform Instructions
*Last updated: May 15, 2026 — Gig scheduling system, custom payroll ranges, backfill migration*

---

## 🧠 WHO YOU ARE

You are a senior full-stack developer who knows this codebase deeply. Always read the relevant file before writing code — never guess at what's already there.

**Stack:**
- **Frontend:** Plain HTML + Vanilla JavaScript (`admin.html`) — no React, no Vue
- **Backend:** Netlify Functions — serverless Node.js in `netlify/functions/`
- **Database:** PostgreSQL via `pg` npm package (`DATABASE_URL` env var) — hosted on Neon
- **Payments:** Stripe (Checkout Sessions for deposits, webhook for confirmation)
- **Email:** Resend API (`RESEND_API_KEY` env var) — sending from `bookings@funkymonkeyevents.com`
- **Auth:** Password (admin) or 4-digit PIN (staff) — checked in `auth.js`
- **Config:** `netlify.toml`, `package.json`

**What this app does:**
Funky Monkey Events is a booking + operations platform for Joe Coover's entertainment business in OKC. Clients book online, Joe manages everything in the admin dashboard, and staff have their own portal to view gigs, express interest, and submit post-gig reports.

---

## 📁 FILE MAP

```
/
├── admin.html                          ← Admin dashboard (4400+ lines)
├── booking-form.html                   ← Public-facing 4-step booking form
├── confirmation.html                   ← Booking confirmation page (post-submit + post-payment)
├── my-booking.html                     ← Client booking lookup (reference + email verification)
├── staff-portal.html                   ← Standalone staff portal (PIN login)
├── services.html                       ← Standalone service catalog with search/filters
├── instant-book.html                   ← Foam party instant booking page
├── docs/
│   └── w9.pdf                         ← Joe's W-9 tax form (for client download)
├── scripts/
│   └── backfill-assignment-times.js   ← One-time migration: calc schedule times for existing assignments
├── netlify.toml                        ← Route redirects + scheduled functions
├── package.json                        ← Dependencies (pg, pdf-lib)
└── netlify/functions/
    ├── _email.js                       ← SHARED: sendEmail, wrap, render, logEmail, fireStatusAutomations
    ├── _sms.js                         ← SHARED: sendSMS (Twilio, optional)
    ├── auth.js                         ← Login: checks ADMIN_PASSWORD, then staff PINs
    ├── bookings.js                     ← GET all bookings / POST new booking + AUTO-NOTIFY STAFF
    ├── booking.js                      ← PATCH (status + STRIPE FIX + AUTO-NOTIFY) / DELETE
    ├── automations.js                  ← Automation rules, email log, booking tasks
    ├── services.js                     ← GET+POST services, addons, service_addons, service_event_types
    ├── staff.js                        ← GET/POST/PATCH/DELETE staff records
    ├── staff-assignments.js            ← Staff gig interest, assignment, checklist, surveys, scheduling
    ├── staff-payments.js               ← Staff payment tracking (per-gig)
    ├── payroll.js                      ← Payroll runs: generate (custom range), approve, pay
    ├── payroll-scheduled.js            ← Auto-generate payroll every Saturday midnight
    ├── generate-invoice.js             ← PDF invoice generation (pdf-lib)
    ├── coi-request.js                  ← Certificate of Insurance request tracking & notification
    ├── staff-feedback.js               ← Per-gig feedback, Google Review linking, bonus tracking
    ├── refund.js                       ← Stripe refund processing + manual refund tracking
    ├── create-stripe-link.js           ← Generates Stripe Checkout Session
    └── stripe-webhook.js               ← Handles checkout.session.completed → confirms booking
```

**API routes (all proxied via netlify.toml):**
| Route | Function |
|---|---|
| `/api/auth` | `auth.js` |
| `/api/bookings` | `bookings.js` |
| `/api/booking/:id` | `booking.js` |
| `/api/services` | `services.js` |
| `/api/staff` | `staff.js` |
| `/api/staff/:id` | `staff.js` |
| `/api/staff-assignments` | `staff-assignments.js` |
| `/api/staff-payments` | `staff-payments.js` |
| `/api/payroll` | `payroll.js` |
| `/api/payroll/:id` | `payroll.js` |
| `/api/automations` | `automations.js` |
| `/api/generate-invoice/:id` | `generate-invoice.js` |
| `/api/coi-request` | `coi-request.js` |
| `/api/coi-request/:id` | `coi-request.js` |
| `/api/staff-feedback/*` | `staff-feedback.js` |
| `/api/create-stripe-link` | `create-stripe-link.js` |
| `/api/stripe-webhook` | `stripe-webhook.js` |

---

## 🗄️ DATABASE SCHEMA

### `bookings` table
Key columns: `id`, `reference` (FM-XXXXXX), `status` (review/pending/confirmed/completed/cancelled), `service_id`, `service_name`, `service_price`, `addons` (JSONB), `addon_total`, `mileage_cost`, `mileage_miles`, `total_price`, `deposit_amount`, `balance_due`, `deposit_paid`, `deposit_paid_at`, `stripe_session_id`, `stripe_payment_link`, `event_date`, `event_time`, `event_zip`, `event_location`, `event_type`, `guest_count`, `notes`, `client_name`, `client_phone`, `client_email`, `child_name`, `guests_of_honour`, `customer_type`, `venue`, `referral_source`, `admin_notes`, `contract_signed`, `payment_method`, `payment_amount`, `payment_note`, `payment_ref`, `confirmation_deadline`, `created_at`, `updated_at`

### `services` table
27 services. Categories: `shows`(7), `performers`(5), `experiences`(9), `library`(6). Columns: `id`, `service_id` (slug), `category`, `name`, `price`, `icon`, `duration_minutes`, `guest_suggestion`, `active`, `sort_order`

### `service_time_templates` table
Default gig time blocks per service (used for payroll + schedule calculation):
`id`, `service_id`, `load_minutes` (default 30), `unload_minutes` (setup @ venue, default 45), `pack_out_minutes` (default 20), `home_unload_minutes` (default 15), `updated_at`
Set in Catalogue → ⏱ Gig Time Templates section. Drive time is auto-calculated from ZIP.

### `staff_assignments` table
`id`, `booking_id`, `staff_id`, `tag_filled`, `status` (interested/backup/assigned/unassigned),
`slot_id`, `notified_at`, `assigned_at`,
**Schedule columns (auto-populated on assign):**
`load_minutes`, `unload_minutes` (setup), `pack_out_minutes`, `home_unload_minutes`,
`drive_minutes_each_way` (ZIP-calculated + 15 min gas buffer),
`total_minutes` (full door-to-door time), `schedule_start` (TIME — when staff must begin loading)

### `staff_slots` table
Default staff requirements per service: `id`, `service_id`, `tag_required`, `slot_count`, `exclusive`, `sort_order`

### `gig_logs` table
Day-of tracking + post-gig survey: `id`, `booking_id`, `staff_id`, `assignment_id`, `status` (upcoming/on_my_way/arrived/completed), `guest_count_actual`, `balance_collected`, `balance_amount`, `event_rating`, `gas_level`, `foam_fluid_needed`, `empty_jugs_refilled`, `notes`, `issues`, `survey_submitted_at`

### `staff_payments` table
Per-gig payment tracking: `id`, `staff_id`, `booking_id`, `assignment_id`, `amount`, `pay_type` (flat/hourly), `hours`, `paid`, `paid_at`, `payment_method`, `note`, `payroll_run_id`, `created_at`, `updated_at`

### `payroll_runs` table
Payroll batches (any date range): `id`, `week_ending` (DATE — end of range), `status` (draft/approved/paid), `total_amount`, `notes` (stores human label like "2026-05-12 – 2026-05-18"), `payment_method`, `created_at`, `approved_at`, `paid_at`, `created_by`

### `payroll_line_items` table
Individual payments within a run: `id`, `payroll_run_id`, `staff_payment_id`, `staff_id`, `amount`, `adjustment_amount`, `adjustment_note`, `created_at`

### `automation_rules` table
`id`, `name`, `active`, `trigger_event`, `trigger_status`, `trigger_days`, `recipient`, `subject`, `body_html`, `sort_order`

### `email_log` table
`id`, `booking_id`, `rule_id`, `trigger_label`, `subject`, `recipient_email`, `recipient_label`, `sent_at`

### `booking_tasks` table
`id`, `booking_id`, `task`, `completed`, `completed_at`, `sort_order`

### Other tables
`addons`, `service_addons`, `service_event_types`, `coi_requests`, `refunds`, `assignment_feedback`, `google_reviews`, `staff_bonuses`

All tables use `ensureTable()` / `ensureTables()` with `ADD COLUMN IF NOT EXISTS` auto-migration on first use.

---

## 🔐 ENVIRONMENT VARIABLES

| Variable | Used in | Notes |
|---|---|---|
| `DATABASE_URL` | All functions | Neon Postgres connection string |
| `STRIPE_SECRET_KEY` | `booking.js`, `create-stripe-link.js` | `sk_live_...` or `sk_test_...` |
| `STRIPE_WEBHOOK_SECRET` | `stripe-webhook.js` | From Stripe dashboard |
| `RESEND_API_KEY` | `_email.js` (shared) | All emails route through this |
| `ADMIN_PASSWORD` | `auth.js` | Joe's login password |
| `NOTIFY_EMAIL` | `_email.js` | Defaults to `Joe.Coover@gmail.com` |

---

## ⏱ GIG SCHEDULING SYSTEM (Added May 2026)

### How it works
When Joe assigns a staff member to a booking, the system **immediately** auto-calculates:
- **Drive time** — ZIP-to-ZIP haversine distance from home base 73118, at 35mph average, **+15 min gas buffer**
- **Total minutes** — load + drive + setup + party (service duration) + pack-out + drive home + home unload
- **Schedule start** — event_time minus (load + drive + setup) = when staff must arrive at home base to load

### Time block defaults (per service, set in Catalogue → ⏱ Gig Time Templates)
| Phase | Default | Notes |
|---|---|---|
| Load | 30 min | At home base before departing |
| Drive each way | Auto (ZIP) + 15 | Haversine + gas stop buffer |
| Setup | 45 min | Arriving at venue through event start |
| Party | From `services.duration_minutes` | Actual event duration |
| Pack-out | 20 min | Tear down at venue |
| Home unload | 15 min | Back at base |

### 5-hour minimum
Payroll enforces `Math.max(5, totalHours)`. If all phases add up to less than 5 hours, staff are paid for 5 hours. The payment note logs `(5h min applied)` when triggered.

### Per-gig overrides
Admin can click ✏️ Edit on any assigned staff card in the booking modal to override any time block for that specific gig. Saves to `staff_assignments` columns and recalculates immediately.

### Staff visibility
Staff see their full schedule (📦 Load → 🚗 Depart → 📍 Arrive → 🎪 Show) in:
1. Their **portal gig card** — read-only schedule block with times and paid hours
2. Their **assignment email** — same 2×2 grid with exact times in the notification email

### Key function: `autoCalcTimes(client, assignmentId, bookingId)`
Lives at the top of `staff-assignments.js`. Called automatically by the `assign` action. Uses `COALESCE` so manually-set overrides are never overwritten.

### Backfill script
`scripts/backfill-assignment-times.js` — run once to populate existing assignments:
```bash
DATABASE_URL=<your_url> node scripts/backfill-assignment-times.js
```
Already run May 15, 2026 — 16 assignments backfilled.

---

## 💰 PAYROLL SYSTEM (Updated May 2026)

### Generate payroll
Payroll page has FROM/TO date pickers with **This Week** and **This Month** quick-fill buttons. Any custom range is supported — not limited to calendar weeks.

### What generate does (7 steps)
1. Finds all `assigned` staff on `confirmed`/`completed` bookings in the date range
2. **Excludes gigs where staff is already paid** (LEFT JOIN anti-pattern on `staff_payments.paid = true`)
3. Loads service time templates
4. Loads service durations
5. Calculates drive time from ZIP + 15 min buffer
6. Auto-creates `staff_payments` records if none exist; updates `hours` on existing ones
7. Creates `payroll_run` + `payroll_line_items`

### Pay calculation
- **Hourly staff** — `max(5, totalHours) × hourly_rate`
- **Flat rate staff** — uses `staff.flat_rate` as default; admin sets manually per gig

### Paid gig protection
Once a payroll run is marked **Paid**, all linked `staff_payments` are set `paid = true`. Those gigs will never appear in any future payroll run regardless of date range.

---

## 📧 EMAIL SYSTEM

**Single source of truth: `netlify/functions/_email.js`** — never duplicate email logic.

Assignment email (from `staff-assignments.js` `assign` action) now includes a **⏱ Your Schedule** block with a 2×2 grid showing exact Load Up / Depart / Arrive Venue / Show Starts times, plus pack-out, home unload, and paid hours. Falls back to a note if event_time or ZIP is missing.

---

## 👤 AUTH SYSTEM

`auth.js` checks in order:
1. Password matches `ADMIN_PASSWORD` → `{ role:'admin' }`
2. Password matches any staff `pin` → `{ role:'staff', staffId, staffName, staffColor }`
3. Otherwise → `{ success:false }`

Staff logins see **My Portal only** — nav items hidden: dashboard, bookings, calendar, clients, catalogue, automations, analytics.

---

## 🔒 STAFF PRIVACY RULES (NON-NEGOTIABLE)

1. `GET /api/staff/:id` — returns only that staff member's record, strips `pin` and `admin_notes`
2. Bookings fetch with `?staff_view=true` — returns safe fields only (no client contact, no financials)
3. `GET /api/staff-assignments?staff_id=X` — strips client contact for non-assigned gigs
4. Admin Staff Portal (with PINs) completely hidden from staff logins

---

## 💳 STRIPE PATTERNS

- Always use Checkout Sessions (`/v1/checkout/sessions`), NOT Payment Links
- Amount must be integer cents: `Math.round(amount * 100)`
- Webhook `checkout.session.completed` → `stripe-webhook.js` → marks deposit paid, fires emails

---

## 🖥️ LOCAL DEV SETUP

```bash
cd ~/Downloads/funky-monkey-email
npx netlify dev
# → http://localhost:8888/admin.html
```

- `.env` file lives in project folder — **never committed to git, must be copied manually**
- `.gitignore` excludes: `.env`, `node_modules/`, `.DS_Store`, `package-lock.json`

---

## 🐙 GIT & GITHUB

Repo: **https://github.com/mxjoker/funkymonkeyadmin**

```bash
git add netlify/functions/whatever-changed.js
git commit -m "fix: description"
git push
```
**⚠️ Never commit `.env`**

---

## 🧩 ADMIN PAGES

| Nav | Page ID | Loads |
|---|---|---|
| Dashboard | `page-dashboard` | KPI tiles, action-needed widget, upcoming events |
| Bookings | `page-bookings` | Full bookings table + CSV export + filters |
| Calendar | `page-calendar` | Two-month view with staff initials on events |
| Clients | `page-clients` | CRM view built from bookings |
| Staffing | `page-staff` | Staff cards + Staffing page with My Portal |
| Catalogue | `page-catalogue` | Services, add-ons, staff slots, event type mappings, time templates |
| Payroll | `page-payroll` | Custom date range payroll runs (generate, approve, pay) |
| Automations | `page-automations` | Email rules, email log, run scheduled |
| Analytics | `page-analytics` | Revenue, referrals, service breakdown |
| My Portal | `page-portal` | Staff-only: gigs + schedule, checklist, survey, earnings |

---

## 🐛 KNOWN BUGS

| Bug | File | Notes |
|---|---|---|
| **Confirmation page shows "Booking not found"** | `bookings.js` | GET endpoint doesn't support `?reference=` parameter — add query filter before `staff_view` check |

---

## ✅ RECENTLY RESOLVED

| Feature | Status | Date |
|---|---|---|
| Gig scheduling system | ✅ COMPLETED — auto-calc on assign, portal + email display, editable overrides | May 15, 2026 |
| Custom payroll date ranges | ✅ COMPLETED — FROM/TO pickers + This Week/Month shortcuts | May 15, 2026 |
| 5-hour minimum pay | ✅ COMPLETED — enforced in payroll generate | May 15, 2026 |
| Paid-gig payroll exclusion | ✅ COMPLETED — LEFT JOIN anti-pattern prevents double-pay | May 15, 2026 |
| Schedule block in assignment email | ✅ COMPLETED — 2×2 time grid with load/depart/arrive/show | May 15, 2026 |
| Backfill migration script | ✅ RAN — 16 existing assignments populated | May 15, 2026 |
| Gig Time Templates in Catalogue | ✅ COMPLETED — per-service defaults, saves with Save Changes | May 15, 2026 |
| Bookings filters & sorting | ✅ COMPLETED | May 7, 2026 |
| Historical data import | ✅ COMPLETED — 635 bookings imported | May 7, 2026 |
| Database indexes | ✅ DEPLOYED — 27 indexes | May 7, 2026 |
| Staff Feedback Loop | ✅ COMPLETED | May 6, 2026 |
| Enhanced COI Request System | ✅ COMPLETED | May 6, 2026 |
| PDF Invoice Generator | ✅ COMPLETED | May 6, 2026 |
| Refunds system | ✅ COMPLETED | May 6, 2026 |
| Booking change log / audit trail | ✅ COMPLETED | May 6, 2026 |
| Dashboard KPI tiles + staffing warnings | ✅ COMPLETED | May 6, 2026 |
| Slot-based Staff Assignment UI | ✅ COMPLETED | May 2026 |
| Staff payment tracking + payroll | ✅ COMPLETED | May 2026 |
| Instant booking (Foam Party) | ✅ COMPLETED | May 2026 |

---

## 🚀 FEATURE ROADMAP

### 🟢 Lower Priority / Future

**1. SMS notifications** — code ready in `_sms.js`, awaiting Twilio credentials in Netlify env vars

**2. Financial export** — expand CSV export with staff fees, expenses, profit per gig

**3. Codebase packaging** — package for Joe's friends in similar entertainment businesses

---

## 🎭 STAFF IN DB

| Name | PIN | Role |
|---|---|---|
| Joe Coover | 9632 | Owner / Magician |
| Troy Scott | 1234 | Performer |
| + 8 others | — | Aliza, Amie, Gabel, Lennon, Lira, Remi, Vanessa, Zane |

---

## 🏗️ KEY PATTERNS

### Netlify Function Pattern
```javascript
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  const client = await pool.connect();
  try {
    await ensureTable(client);
    return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
  } catch(err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  } finally {
    client.release(); // ✅ return to pool, never .end()
  }
};
```

**Critical:** Always use `pool.connect()` + `client.release()`. Never use `new Client()` — it crashes on reuse in serverless.

### PATCH endpoints — use colMap pattern
Only update fields explicitly provided. See `booking.js` `colMap` for reference.

### Frontend helpers
```javascript
async function callApi(path, method = 'GET', payload = null) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (payload) opts.body = JSON.stringify(payload);
  const res = await fetch('/api/' + path, opts);
  if (!res.ok) { const e = await res.json().catch(()=>({})); throw new Error(e.error || 'Request failed'); }
  return res.json();
}
function esc(str) {
  return String(str||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
```
Always use `esc()` when injecting user data into HTML strings.

---

## 💡 GENERAL RULES

- **Read before writing.** Always read the relevant file before editing it.
- **One thing at a time.** Fix what's asked. Don't refactor unrelated code.
- **Keep it simple.** Vanilla JS, not React. No unnecessary abstractions.
- **Staff privacy is non-negotiable.** Enforced at every layer.
- **Email goes through `_email.js`.** Never duplicate email logic.
- **Never commit `.env`.**
- **Stripe = Checkout Sessions only.**

---

## 🚀 DEPLOYMENT CHECKLIST

- [ ] Set all env vars in Netlify: `DATABASE_URL`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `RESEND_API_KEY`, `ADMIN_PASSWORD`, `NOTIFY_EMAIL`
- [ ] Verify sending domain in Resend dashboard (`funkymonkeyevents.com` — DNS on Cloudflare, must be grey cloud / DNS-only)
- [ ] Set Stripe webhook endpoint to `https://yoursite.netlify.app/api/stripe-webhook`
- [ ] Confirm `STRIPE_SECRET_KEY` is live key before going live
- [ ] Test full booking → confirm → deposit flow in Stripe test mode first
