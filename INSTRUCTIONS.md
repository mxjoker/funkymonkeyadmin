# Funky Monkey Events — Admin Platform Instructions
*Last updated: March 2026*

---

## 🧠 WHO YOU ARE

You are a senior full-stack developer who knows this codebase deeply. Always read the relevant file before writing code — never guess at what's already there.

**Stack:**
- **Frontend:** Plain HTML + Vanilla JavaScript (`admin.html`, `booking-form.html`, `staff-portal.html`) — no React, no Vue
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
├── admin.html                          ← Admin dashboard (3200+ lines)
├── booking-form.html                   ← Public-facing 4-step booking form
├── staff-portal.html                   ← Standalone staff portal (PIN login)
├── services.html                       ← NEW: Standalone service catalog with search/filters
├── instant-book.html                   ← NEW: Foam party instant booking page
├── netlify.toml                        ← Route redirects + scheduled functions
├── package.json                        ← Dependencies (pg only)
└── netlify/functions/
    ├── _email.js                       ← SHARED: sendEmail, wrap, render, logEmail, fireStatusAutomations
    ├── auth.js                         ← Login: checks ADMIN_PASSWORD, then staff PINs
    ├── bookings.js                     ← GET all bookings / POST new booking + AUTO-NOTIFY STAFF
    ├── booking.js                      ← PATCH (status + STRIPE FIX + AUTO-NOTIFY) / DELETE
    ├── automations.js                  ← Automation rules, email log, booking tasks
    ├── services.js                     ← GET+POST services, addons, service_addons, service_event_types
    ├── staff.js                        ← GET/POST/PATCH/DELETE staff records
    ├── staff-assignments.js            ← Staff gig interest, assignment, checklist, surveys
    ├── staff-payments.js               ← Staff payment tracking (per-gig)
    ├── payroll.js                      ← NEW: Weekly payroll runs (generate, approve, pay)
    ├── payroll-scheduled.js            ← NEW: Auto-generate payroll every Saturday midnight
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
| `/api/create-stripe-link` | `create-stripe-link.js` |
| `/api/stripe-webhook` | `stripe-webhook.js` |

---

## 🗄️ DATABASE SCHEMA

### `bookings` table
Key columns: `id`, `reference` (FM-XXXXXX), `status` (review/pending/confirmed/completed/cancelled), `service_id`, `service_name`, `service_price`, `addons` (JSONB), `addon_total`, `mileage_cost`, `mileage_miles`, `total_price`, `deposit_amount`, `balance_due`, `deposit_paid`, `deposit_paid_at`, `stripe_session_id`, `stripe_payment_link`, `event_date`, `event_time`, `event_zip`, `event_location`, `event_type`, `guest_count`, `notes`, `client_name`, `client_phone`, `client_email`, `child_name`, `guests_of_honour`, `customer_type`, `venue`, `referral_source`, `admin_notes`, `contract_signed`, `payment_method`, `payment_amount`, `payment_note`, `payment_ref`, `confirmation_deadline`, `created_at`, `updated_at`

### `services` table
27 services matching the booking form. Categories: `shows`(7), `performers`(5), `experiences`(9), `library`(6). Columns: `id`, `service_id` (slug), `category`, `name`, `price`, `icon`, `duration_minutes`, `guest_suggestion`, `active`, `sort_order`

### `addons` table
39 add-ons. `id`, `addon_id` (slug), `name`, `price`, `active`, `sort_order`

### `service_addons` table
Per-service addon links: `id`, `service_id`, `addon_id`, `sort_order`

### `service_event_types` table
Controls which services appear per event type in the booking form: `id`, `service_id`, `event_type_id`
Event type IDs: `kids_bday`, `family`, `school_asm`, `school_fund`, `corporate`, `community`, `wedding`, `library`

### `staff` table
`id`, `staff_id`, `name`, `preferred_name`, `pronouns`, `role`, `color` (hex), `pin` (4-digit), `phone`, `email`, `comms_preference`, `skills` (JSONB), `admin_notes`, `staff_notes`, `shared_notes`, `active`, `sort_order`

### `staff_slots` table
Default staff requirements per service: `id`, `service_id`, `tag_required`, `slot_count`, `exclusive`, `sort_order`

### `staff_assignments` table
`id`, `booking_id`, `staff_id`, `tag_filled`, `status` (interested/backup/assigned/unassigned)

### `gig_logs` table
Day-of tracking + post-gig survey: `id`, `booking_id`, `staff_id`, `assignment_id`, `checklist_status` (upcoming/on_my_way/arrived/completed), `guest_count_actual`, `balance_collected`, `balance_amount`, `event_rating`, `gas_level`, `foam_fluid_needed`, `empty_jugs_refilled`, `notes`, `issues`, `survey_submitted_at`

### `automation_rules` table
Email automation rules: `id`, `name`, `active`, `trigger_event` (status_change/days_before_event/days_after_event/deposit_paid), `trigger_status`, `trigger_days`, `recipient` (client/admin), `subject`, `body_html`, `sort_order`

### `email_log` table
Every email sent: `id`, `booking_id`, `rule_id`, `trigger_label`, `subject`, `recipient_email`, `recipient_label`, `sent_at`

### `booking_tasks` table
Per-booking admin checklist: `id`, `booking_id`, `task`, `completed`, `completed_at`, `sort_order`

### `staff_payments` table
Per-gig payment tracking: `id`, `staff_id`, `booking_id`, `assignment_id`, `service_id`, `service_name`, `event_date`, `reference`, `amount`, `pay_type`, `hours`, `paid`, `paid_at`, `payroll_run_id`, `created_at`

### `payroll_runs` table
Weekly payroll batches: `id`, `week_ending` (DATE), `status` (draft/approved/paid), `total_amount`, `notes`, `payment_method` (Check/Venmo/Cash/Mixed/Other), `created_at`, `approved_at`, `paid_at`, `created_by`

### `payroll_line_items` table
Individual payments within a run: `id`, `payroll_run_id`, `staff_payment_id`, `staff_id`, `amount`, `adjustment_amount`, `adjustment_note`, `created_at`

All tables use `ensureTable()` / `ensureTables()` with auto-migration on first use.

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

## 📧 EMAIL SYSTEM

**Single source of truth: `netlify/functions/_email.js`**

All email sending flows through this shared module. Never duplicate email logic in other functions.

Exports:
- `sendEmail(to, subject, html)` — sends via Resend
- `wrap(body)` — wraps body in branded HTML shell
- `render(template, booking, stripeLink)` — replaces `{{variables}}` in templates
- `logEmail(client, bookingId, ruleId, label, subject, email, recipientLabel)` — logs to `email_log`
- `fireStatusAutomations(client, booking, newStatus, stripeLink)` — fires matching rules from `automation_rules`
- `ensureEmailLog(client)` — ensures `email_log` table exists

**Template variables available:** `{{client_first_name}}`, `{{client_name}}`, `{{service_name}}`, `{{event_date}}`, `{{event_time}}`, `{{event_zip}}`, `{{total_price}}`, `{{deposit_amount}}`, `{{balance_due}}`, `{{reference}}`, `{{deposit_link}}`

**Triggered emails:**
| Trigger | Path |
|---|---|
| New booking submitted | `bookings.js` → direct Resend call (Joe + client) |
| Status change (confirmed/cancelled/completed) | `booking.js` → `fireStatusAutomations()` → `automation_rules` table |
| Deposit paid via Stripe | `stripe-webhook.js` → direct email |
| Scheduled (days before/after event) | `automations.js` run_scheduled action |
| Manual | `automations.js` send_manual action |

---

## 👤 AUTH SYSTEM

`auth.js` checks in order:
1. Password matches `ADMIN_PASSWORD` → `{ role:'admin' }`
2. Password matches any staff `pin` → `{ role:'staff', staffId, staffName, staffColor }`
3. Otherwise → `{ success:false }`

Staff logins see **My Portal only** — nav items hidden: `dashboard`, `bookings`, `calendar`, `clients`, `catalogue`, `automations`, `analytics`

---

## 🔒 STAFF PRIVACY RULES

1. `GET /api/staff/:id` — returns only that staff member's record, strips `pin` and `admin_notes`
2. Bookings fetch with `?staff_view=true` — returns safe fields only (no client contact, no financials)
3. `GET /api/staff-assignments?staff_id=X` — strips client contact for non-assigned gigs
4. Admin Staff Portal (with PINs) completely hidden from staff logins

---

## 💳 STRIPE PATTERNS

- Always use Checkout Sessions (`/v1/checkout/sessions`), NOT Payment Links
- Amount must be integer cents: `Math.round(amount * 100)`
- Webhook `checkout.session.completed` → `stripe-webhook.js` → marks deposit paid, fires emails
- Webhook lookup order: `metadata.booking_db_id` → `metadata.booking_id` → customer email

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

**⚠️ Never commit `.env` — GitHub will block the push if secrets are detected.**

---

## 🧩 ADMIN PAGES

| Nav | Page ID | Loads |
|---|---|---|
| Dashboard | `page-dashboard` | Summary stats, recent bookings |
| Bookings | `page-bookings` | Full bookings table + CSV export |
| Calendar | `page-calendar` | Two-month view with staff initials on events |
| Clients | `page-clients` | CRM view built from bookings |
| Staffing | `page-staff` | Staff cards + Staffing page with My Portal |
| Catalogue | `page-catalogue` | Services, add-ons, staff slots, event type mappings |
| Payroll | `page-payroll` | Weekly payroll runs (generate, approve, pay) |
| Automations | `page-automations` | Email rules, email log, run scheduled |
| Analytics | `page-analytics` | Revenue, referrals, service breakdown |
| My Portal | `page-portal` | Staff-only: gigs, checklist, survey, earnings |


---

## 🐛 KNOWN BUGS

| Bug | File | Notes |
|---|---|---|
| *(no known bugs)* | — | — |

---

## ✅ RECENTLY RESOLVED

| Feature | Status | Date |
|---|---|---|
| "Browse all services" link → `services.html` created | ✅ COMPLETED | May 2026 |
| Stripe deposit "Invalid amount" bug | ✅ FIXED — Validation guard added | May 2026 |
| Auto-staff notification on booking confirm | ✅ IMPLEMENTED in booking.js | May 2026 |
| Staff payment tracking system | ✅ COMPLETED — staff_payments table + API | May 2026 |
| Weekly payroll system with auto-generation | ✅ COMPLETED — Runs every Saturday | May 2026 |
| Instant booking page for Foam Party | ✅ COMPLETED — instant-book.html | May 2026 |
| Staff Requirements Editor | ✅ Already existed in Catalogue | May 2026 |
| Staff checklist buttons not clickable | ✅ Fixed — double-quoted JSON.stringify args inside HTML attributes broke onclick | Mar 2026 |
| Autopilot email scheduler | ✅ Built — `automations.js`, configurable rules, template variables | Mar 2026 |
| Per-booking email log | ✅ Built — shows in booking modal, logged to `email_log` table | Mar 2026 |
| Per-booking admin task checklist | ✅ Built — add/complete/delete tasks per booking | Mar 2026 |
| Email deduplication / double-send risk | ✅ Fixed — all email logic extracted to `_email.js`, single code path | Mar 2026 |
| Dashboard recent bookings sort | ✅ Fixed — sorted by `created_at DESC` | Mar 2026 |
| Services DB ↔ booking form sync | ✅ Done — 27 services, 39 addons, 60 event type links all match | Mar 2026 |

---

## 🚀 FEATURE ROADMAP

### 🔴 High Priority — Missing Core Features

**1. W-9, Invoice, and Insurance Request buttons on confirmation**
After a booking is confirmed (or deposit paid), the client confirmation page / booking modal should have buttons:
- **Download W-9** — link to a static PDF of Joe's W-9
- **Request Certificate of Insurance** — sends Joe an email notification that the client needs a COI, or shows a contact form
- **Download Invoice** — generates a simple PDF invoice for the booking (reference, service, total, deposit paid, balance due)
These can be added to both the Stripe success page and the booking modal in admin.

**2. Client-facing booking lookup**
Let clients check and update their own booking by reference number.
- Public page at `/my-booking.html` or `/booking-form.html?lookup=1`
- Client enters reference number + email to verify
- Shows: status, date, service, deposit status, balance due
- Allows limited edits: event date change request, notes update, contact info correction
- Sends Joe a notification when client makes changes

### 🟡 Medium Priority

**7. Staff feedback loop**
- Joe can leave per-gig notes visible to that staff member (`shared_notes` pattern, per-assignment)
- Google Review linking — manually associate a review URL with a booking/staff member
- Bonus tracking — flag when a staff member gets a review mention, track bonus credits

**8. Staff dual notes**
Staff records currently have `admin_notes` (private) and `staff_notes` (staff → Joe) and `shared_notes` (Joe → staff, already built). Make `shared_notes` editable by both admin and staff in their respective portals.

**9. Staffing warning on dashboard**
Flag bookings within 14 days that have `confirmed` status but no assigned staff. Show a warning badge on the dashboard.

**10. Dashboard overhaul — Task Summary widget**
Inspired by PPM's Task Manager. Replace or supplement the "Recent Bookings" panel with an action-oriented task summary showing counts of:
- Bookings needing review (status = `review`)
- Deposits not yet sent (status = `pending`, no `stripe_payment_link`)
- Gigs within 14 days with no assigned staff
Each item should be a clickable badge that deep-links to the relevant filtered view.

**11. Dashboard overhaul — KPI Stat Tiles**
Inspired by PPM's Business Stats section. Add 4 stat tiles below the task summary:
- Total Booking Value (month-to-date + YTD)
- Average Price / Event
- Inquiries (new bookings in review)
- Confirmed Bookings
All computable from the existing `bookings` table. Include % change vs prior month if feasible.

**12. Dashboard overhaul — Upcoming Events sidebar**
Inspired by PPM's right-column event feed. Show the next 10 upcoming confirmed events in chronological order with: date, client name, service name, and colored staff initials badges for assigned staff. Clicking an event opens the booking modal.

**13. Booking change log / audit trail**
Track every field change on a booking — what changed, old value, new value, when. Show in booking modal Activity tab (PPM has a "Changes" sub-tab for this). Add a `booking_changes` table.

**14. "Total staff required" counter in booking modal**
Staffing section should show: X Still to Allocate / X Awaiting / X Confirmed — matching PPM's staffing summary UI.

### 🟢 Lower Priority / Future

**12. SMS notifications**
Twilio — add branch in `_email.js` notify logic. All other code is ready for it.

**13. Refunds**
Not implemented — would add to `booking.js` as a POST action calling Stripe refund API.

**14. Google Review linking**
Manual process — admin links a Google review URL to a booking. No automatic API sync available from Google.

**15. Export for accounting**
Expand the CSV export with: staff fees, expenses, profit per gig. Or add a separate "Financial Export" with invoice-level detail.

**16. Codebase packaging for friends**
Once the platform is solid, package for Joe's friends in similar entertainment businesses. They run their own servers — Joe helps with setup only.

---

## 🎭 STAFF IN DB

| Name | PIN | Role | Skills |
|---|---|---|---|
| Joe Coover | 9632 | Owner / Magician | Magic Show, Corporate Magic, Childrens Magic, Driver, Foam Party, Emcee, Magic Camp, Game Show, DJ Piñata, Snow Experience, Setup |
| Troy Scott | 1234 | Performer | (check DB) |
| + 8 others | — | Various | Aliza, Amie, Gabel, Lennon, Lira, Remi, Vanessa, Zane |

---

## 🏗️ KEY PATTERNS

### Netlify Function Pattern
```javascript
exports.handler = async (event, context) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const client = await pool.connect();
  try {
    await ensureTable(client);
    return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
  } catch(err) {
    console.error('Function error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  } finally {
    client.release();
  }
};
```

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

- **One thing at a time.** Fix what's asked. Don't refactor unrelated code.
- **Keep it simple.** Vanilla JS, not React. No unnecessary abstractions.
- **Read before writing.** Always read the relevant file before editing it.
- **Staff privacy is critical.** Never let a staff login see other staff records, PINs, client contact for unassigned gigs, or admin-only pages.
- **Email goes through `_email.js`.** Never duplicate email sending logic in other functions.
- **Never commit `.env`.** GitHub will block and secrets will be exposed.
- **Stripe = Checkout Sessions only.** Not Payment Links.

---

## 🚀 DEPLOYMENT CHECKLIST

- [ ] Set all env vars in Netlify site settings (`DATABASE_URL`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `RESEND_API_KEY`, `ADMIN_PASSWORD`, `NOTIFY_EMAIL`)
- [ ] Verify sending domain in Resend dashboard (`funkymonkeyevents.com` — DNS on Cloudflare, must be DNS-only / grey cloud)
- [ ] Set Stripe webhook endpoint to `https://yoursite.netlify.app/api/stripe-webhook`
- [ ] Confirm `STRIPE_SECRET_KEY` is the live key before going live
- [ ] Test full booking → confirm → deposit flow in Stripe test mode first
- [ ] Set `ADMIN_PASSWORD` to something strong
