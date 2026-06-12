# Funky Monkey Events — Admin Platform Instructions
*Last updated: June 2026 — Production hardening: token auth, idempotent Stripe webhook, money-math fixes*

---

## WHO YOU ARE

You are a senior full-stack developer who knows this codebase deeply. Always read the relevant file before writing code — never guess at what's already there.

**Stack:**
- **Frontend:** Plain HTML + Vanilla JavaScript (`admin.html`, `staff-portal.html`) — no React, no Vue
- **Backend:** Netlify Functions — serverless Node.js in `netlify/functions/`
- **Database:** PostgreSQL via `pg` npm package (`DATABASE_URL` env var) — hosted on Neon
- **Payments:** Stripe (Checkout Sessions for deposits; webhook for confirmation)
- **Email:** Resend API (`RESEND_API_KEY` env var) — sending from `bookings@funkymonkeyevents.com`
- **Auth:** Bearer session tokens (post-June 2026 hardening) — see Auth section below
- **Config:** `netlify.toml`, `package.json`

**What this app does:**
Funky Monkey Events is a booking + operations platform for Joe Coover's entertainment business in OKC. Clients book online, Joe manages everything in the admin dashboard, and staff have their own portal to view gigs, express interest, and submit post-gig reports.

---

## ARCHITECTURE AT A GLANCE

```
Client browser
    │
    ▼
Netlify Edge (netlify.toml redirect rules)
    │
    ▼
Netlify Functions (serverless Node.js)
    ├── Shared modules
    │   ├── _db.js       — DB pool; every function uses getPool() / withClient()
    │   ├── _auth.js     — session table, CORS headers, requireAuth(), rate limiting
    │   ├── _email.js    — sendEmail, esc(), logEmail, fireStatusAutomations
    │   └── _sms.js      — Twilio SMS helper (built, NOT wired up — needs credentials)
    │
    └── Individual function handlers (see FILE MAP below)
          │
          ▼
    Neon Postgres (DATABASE_URL)
    Resend (email)
    Stripe (deposits + webhook)
```

**Key shared-module rules (enforced by API_CONTRACT.md):**
- Every function MUST use `getPool()` / `withClient()` from `_db.js`. Never `new Pool()` or `new Client()`.
- Every function MUST call `preflight(event)` first (returns 204 for OPTIONS) and use the shared `CORS` headers from `_auth.js` on every response.
- Email always goes through `_email.js`. Never duplicate email logic elsewhere.

---

## FILE MAP

```
/
├── admin.html                          ← Admin dashboard (4400+ lines)
├── booking-form.html                   ← Public-facing 4-step booking form (no login)
├── confirmation.html                   ← Booking confirmation page (post-submit + post-payment)
├── my-booking.html                     ← Client booking lookup (reference + email — no login)
├── staff-portal.html                   ← Standalone staff portal (access-code login)
├── services.html                       ← Standalone service catalog with search/filters
├── docs/
│   ├── API_CONTRACT.md                 ← Authoritative access rules (read this first)
│   ├── ROADMAP.md                      ← Planned features (instant-book v2, SMS wiring)
│   ├── attic/
│   │   └── instant-book.html          ← RETIRED — anonymous foam booking page (June 2026)
│   └── w9.pdf                         ← Joe's W-9 tax form (for client download)
├── scripts/
│   ├── migrate-auth.js                ← Idempotent: creates auth tables, generates access codes
│   ├── cleanup-backlog.js             ← Dry-run/--apply backlog status cleanup with rollback JSON
│   ├── payroll-migration.js           ← Payroll schema migration
│   └── backfill-assignment-times.js   ← One-time migration: calc schedule times for existing assignments
├── netlify.toml                        ← Route redirects + scheduled functions
├── package.json                        ← Dependencies (pg, pdf-lib, stripe)
└── netlify/functions/
    ├── _db.js                          ← SHARED: getPool(), withClient() — use these everywhere
    ├── _auth.js                        ← SHARED: sessions, CORS, requireAuth, rate limiting
    ├── _email.js                       ← SHARED: sendEmail, esc, wrap, render, logEmail, fireStatusAutomations
    ├── _sms.js                         ← SHARED: sendSMS (Twilio) — wired to nothing yet
    ├── auth.js                         ← POST /api/auth — login, logout, token check, set_admin_password
    ├── bookings.js                     ← GET all bookings / POST new booking + AUTO-NOTIFY STAFF
    ├── booking.js                      ← PATCH (status + STRIPE FIX + AUTO-NOTIFY) / DELETE
    ├── automations.js                  ← Automation rules, email log, booking tasks
    ├── services.js                     ← GET+POST services, addons, service_addons, service_event_types
    ├── staff.js                        ← GET/POST/PATCH/DELETE staff records
    ├── staff-assignments.js            ← Staff gig interest, assignment, checklist, surveys, scheduling
    ├── staff-payments.js               ← Staff payment tracking (per-gig)
    ├── payroll.js                      ← Payroll runs: preflight, generate (custom range), approve, pay, add_adjustment
    ├── payroll-scheduled.js            ← Auto-generate payroll every Saturday (most-recently-completed Mon–Sun week)
    ├── generate-invoice.js             ← PDF invoice generation (pdf-lib)
    ├── coi-request.js                  ← Certificate of Insurance request tracking & notification
    ├── staff-feedback.js               ← Per-gig feedback, Google Review linking, bonus tracking
    ├── refund.js                       ← Stripe refund (post-June 2026 payments) or manual refund log
    ├── create-stripe-link.js           ← Generates Stripe Checkout Session for deposit (24h expiry, emails client)
    ├── stripe-webhook.js               ← checkout.session.completed → confirms booking (signature-required, idempotent)
    ├── accounting-export.js            ← Financial export
    ├── booking-changelog.js            ← Audit trail for booking changes
    └── client.js                       ← CRM-style client view built from bookings
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
| `/api/accounting-export` | `accounting-export.js` |
| `/api/booking-changelog` | `booking-changelog.js` |
| `/api/client` | `client.js` |

---

## AUTH SYSTEM (June 2026 — token auth on all protected endpoints)

### How login works

`POST /api/auth` with `{ password }` returns:
```json
{ "success": true, "role": "admin", "token": "...", "expiresAt": "..." }
```
or for staff:
```json
{ "success": true, "role": "staff", "token": "...", "expiresAt": "...", "staffId": 5, "staffName": "Troy", "staffColor": "#7c3aed" }
```

- Tokens are stored (hashed) in the `sessions` table, **7-day expiry**.
- All subsequent protected calls send `Authorization: Bearer <token>`.
- `_auth.requireAuth(event, roles?)` validates the token; returns `{ role, staffId, tokenHash }` or null.
- **Rate limiting:** 10 login attempts per 15 minutes per IP. Exceeding this returns 429.

### Admin login
- Admin logs in with the **admin password**. This password is stored (hashed) in the `admin_settings` DB table.
- The `ADMIN_PASSWORD` env var is a legacy fallback; the DB-stored hash takes precedence after `migrate-auth.js` has run.
- Admin can change their password via the sidebar **"Change Password"** link (requires a valid admin session; min 10 characters).

### Staff login
- Staff log in with a **personal access code** in the format `word-word-word-NN` (e.g. `maple-river-torch-42`).
- **4-digit PINs are retired.** Access codes replaced them in June 2026.
- Admin generates or regenerates a staff member's access code from the **Staff edit modal** (`POST /api/staff/:id` with `action: 'regenerate_access_code'`). The plaintext code is returned **once** — copy it before closing.
- Access codes are stored as scrypt hashes (`staff.access_code_hash`). The original code is never stored.

### Public (no-auth) surfaces
These work without any token:
- `booking-form.html` — new booking submission
- `GET /api/services` — service catalogue
- `GET /api/bookings?reference=X&email=Y` — booking lookup (both params required; email must match booking; returns public fields only — no admin notes, no staff data)
- `GET /api/generate-invoice/:reference?email=Y` — invoice download (email must match booking)
- `POST /api/coi-request` — COI request (must include booking reference + matching client email)
- `POST /api/stripe-webhook` — Stripe webhook (Stripe signature required)

**Everything else returns 401 without a valid token.**

### Staff scoping rule
When `auth.role === 'staff'`, any `staff_id` in a query/body/path MUST be ignored and replaced with `auth.staffId`. A staff token may never act on another staff member's data — enforce with `forbidden()` from `_auth.js`.

---

## PUBLIC BOOKING FIELD SUBSET

For unauthenticated `GET /api/bookings?reference&email` (and invoice/COI flows), return ONLY:
`reference, status, service_id, service_name, event_type, event_date, start_time, end_time, guest_count, venue_name, event_address, client_name, addons, total_price, mileage_cost, deposit_amount, deposit_paid, balance_due, payment_amount, created_at`

Never expose: admin notes, staff assignments, costs, id-based enumeration.

---

## STAFF PRIVACY RULES (NON-NEGOTIABLE)

1. `GET /api/staff/:id` with a staff token — returns only that staff member's own record; strips `access_code_hash` and `admin_notes`.
2. `PATCH /api/staff/:id` with a staff token — limited to: `preferred_name`, `pronouns`, `color`, `phone`, `email`, `comms_preference`, `skills`, `shared_notes`, `staff_notes`. **Never** pay rates, `role`, `active`, `pin`, `access_code_hash`.
3. Bookings fetch with `?staff_view=true` — safe fields only (no client contact, no financials).
4. `GET /api/staff-assignments?staff_id=X` — staff token: own assignments only.
5. Admin Staff Portal section (staff management) completely hidden from staff-role sessions.

---

## DATABASE SCHEMA

### `bookings` table
Key columns: `id`, `reference` (FM-XXXXXX), `status` (review/pending/confirmed/completed/cancelled), `service_id`, `service_name`, `service_price`, `addons` (JSONB), `addon_total`, `mileage_cost`, `mileage_miles`, `total_price`, `deposit_amount`, `balance_due`, `deposit_paid`, `deposit_paid_at`, `stripe_session_id`, `stripe_payment_intent_id`, `stripe_payment_link`, `event_date`, `event_time`, `event_zip`, `event_location`, `event_type`, `guest_count`, `notes`, `client_name`, `client_phone`, `client_email`, `child_name`, `guests_of_honour`, `customer_type`, `venue`, `referral_source`, `admin_notes`, `contract_signed`, `payment_method`, `payment_amount`, `payment_note`, `payment_ref`, `confirmation_deadline`, `created_at`, `updated_at`

### `sessions` table (added June 2026)
`id`, `token_hash`, `role`, `staff_id`, `expires_at`, `last_used_at`, `created_at`

### `admin_settings` table (added June 2026)
`key`, `value` — stores `admin_password_hash` (and optionally others).

### `login_attempts` table (added June 2026)
`id`, `ip`, `attempted_at`, `success` — used for rate limiting.

### `services` table
27 services. Categories: `shows`(7), `performers`(5), `experiences`(9), `library`(6). Columns: `id`, `service_id` (slug), `category`, `name`, `price`, `icon`, `duration_minutes`, `guest_suggestion`, `active`, `sort_order`

### `service_time_templates` table
Default gig time blocks per service (used for payroll + schedule calculation):
`id`, `service_id`, `load_minutes` (default 30), `unload_minutes` (setup @ venue, default 45), `pack_out_minutes` (default 20), `home_unload_minutes` (default 15), `updated_at`
Set in Catalogue → Gig Time Templates section. Drive time is auto-calculated from ZIP.

### `staff_assignments` table
`id`, `booking_id`, `staff_id`, `tag_filled`, `status` (interested/backup/assigned/unassigned),
`slot_id`, `notified_at`, `assigned_at`, `access_code_hash` (on `staff` table, not here)
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
Schema owned by `_email.js`. Other files add columns via `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` — never re-CREATE with a different shape.
`id`, `booking_id`, `rule_id`, `trigger_label`, `subject`, `recipient_email`, `recipient_label`, `sent_at`

### `booking_tasks` table
`id`, `booking_id`, `task`, `completed`, `completed_at`, `sort_order`

### `booking_changes` table
Schema owned by `booking-changelog.js`. Columns: `field_name`, `old_value`, `new_value` (plus booking/timestamp metadata). Do not redefine this shape elsewhere.

### Other tables
`addons`, `service_addons`, `service_event_types`, `coi_requests`, `refunds`, `assignment_feedback`, `google_reviews`, `staff_bonuses`

All tables use `ensureTable()` / `ensureTables()` with `ADD COLUMN IF NOT EXISTS` auto-migration on first use.

---

## ENVIRONMENT VARIABLES

| Variable | Used in | Notes |
|---|---|---|
| `DATABASE_URL` | All functions | Neon Postgres connection string |
| `STRIPE_SECRET_KEY` | `booking.js`, `create-stripe-link.js` | `sk_live_...` or `sk_test_...` |
| `STRIPE_WEBHOOK_SECRET` | `stripe-webhook.js` | **Required** — webhook is fail-closed (rejects if unset) |
| `RESEND_API_KEY` | `_email.js` (shared) | All emails route through this |
| `ADMIN_PASSWORD` | `auth.js` | Legacy env-var fallback only — DB-stored hash takes precedence after migration |
| `NOTIFY_EMAIL` | `_email.js` | Defaults to `Joe.Coover@gmail.com` |

SMS variables (not yet active — see `_sms.js` and ROADMAP):
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`

---

## GIG SCHEDULING SYSTEM (Added May 2026)

### How it works
When Joe assigns a staff member to a booking, the system **immediately** auto-calculates:
- **Drive time** — ZIP-to-ZIP haversine distance from home base 73118, at 35 mph average, **+15 min gas buffer**
- **Total minutes** — load + drive + setup + party (service duration) + pack-out + drive home + home unload
- **Schedule start** — event_time minus (load + drive + setup) = when staff must arrive at home base to load

### Time block defaults (per service, set in Catalogue → Gig Time Templates)
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
Admin can click Edit on any assigned staff card in the booking modal to override any time block for that specific gig. Saves to `staff_assignments` columns and recalculates immediately.

### Staff visibility
Staff see their full schedule (Load → Depart → Arrive → Show) in:
1. Their **portal gig card** — read-only schedule block with times and paid hours
2. Their **assignment email** — same 2×2 grid with exact times

### Key function: `autoCalcTimes(client, assignmentId, bookingId)`
Lives at the top of `staff-assignments.js`. Called automatically by the `assign` action. Uses `COALESCE` so manually-set overrides are never overwritten.

### Backfill script
`scripts/backfill-assignment-times.js` — run once to populate existing assignments.
Already run May 15, 2026 — 16 assignments backfilled.

---

## PAYROLL SYSTEM

### Scheduled run
`payroll-scheduled.js` runs automatically every Saturday. It covers the **most recently completed Monday–Sunday week**.

### Manual generation
Payroll page has FROM/TO date pickers with **This Week** and **This Month** quick-fill buttons. Any custom range is supported.

### Preflight (dry-run review)
Before committing a payroll run, call `POST /api/payroll` with `{ action: 'preflight', date_from, date_to }`. Returns per-event pay review including unassigned events — identical logic to `generate` but **writes nothing to the database**. Use this to verify the run before creating it.

### What generate does (7 steps)
1. Finds all `assigned` staff on `confirmed`/`completed` bookings in the date range
2. **Excludes gigs where staff is already paid** (LEFT JOIN anti-pattern on `staff_payments.paid = true`)
3. Loads service time templates
4. Loads service durations
5. Calculates drive time from ZIP + 15 min buffer
6. Auto-creates `staff_payments` records if none exist; updates `hours` on existing ones
7. Creates `payroll_run` + `payroll_line_items`

### Per-line-item adjustments
After a run is generated, add a bonus or tip to an individual line item: `POST /api/payroll` with `{ action: 'add_adjustment', line_item_id, adjustment_amount, adjustment_note }`.

### Pay calculation
- **Hourly staff** — `max(5, totalHours) × hourly_rate`
- **Flat rate staff** — uses `staff.flat_rate` as default; admin sets manually per gig

### Paid gig protection
Once a payroll run is marked **Paid**, all linked `staff_payments` are set `paid = true`. Those gigs will never appear in any future payroll run regardless of date range.

---

## STRIPE PATTERNS

### Deposit links
- Created from the **booking modal** in the admin dashboard.
- `create-stripe-link.js` generates a Stripe Checkout Session, stores the session ID on the booking, and **emails the client a payment link** (24-hour expiry).
- Always use integer cents: `Math.round(amount * 100)`.

### Webhook
- `stripe-webhook.js` handles `checkout.session.completed` → marks deposit paid, fires status automations.
- **Fail-closed:** if `STRIPE_WEBHOOK_SECRET` is not set in Netlify env vars, the webhook rejects all requests. Must be configured.
- **Idempotent:** duplicate Stripe events are handled safely — re-processing the same `session_id` will not double-confirm a booking.

### Refunds
- Admin-initiated via `refund.js`.
- Stripe refunds work for bookings that have a `stripe_payment_intent_id` on record — i.e., payments processed through the current webhook flow (post-June 2026).
- **Older bookings** (imported historical data or payments processed before June 2026) will not have a payment intent ID. The refund endpoint detects this and falls back to **manual logging**: it records the refund in the `refunds` table with `status = 'manual'` and returns a message instructing Joe to process the payment outside the system (check, Venmo, etc.).

---

## EMAIL SYSTEM

**Single source of truth: `netlify/functions/_email.js`** — never duplicate email logic.

All user-supplied values interpolated into email HTML must go through `esc()` (exported from `_email.js`). Same rule applies to values echoed into PDF/text.

Assignment email (from `staff-assignments.js` `assign` action) includes a **Your Schedule** block with a 2×2 grid showing exact Load Up / Depart / Arrive Venue / Show Starts times, plus pack-out, home unload, and paid hours. Falls back gracefully if event_time or ZIP is missing.

---

## INSTANT-BOOK.HTML — RETIRED

`instant-book.html` created anonymous foam party bookings with no contact info required. It was **retired in June 2026** and moved to `docs/attic/instant-book.html`. It is no longer linked or deployed.

A planned **Instant Booking v2** is described in `docs/ROADMAP.md`: foam gigs at least 2 weeks out on a clear calendar, with a zip-based mileage fee table and required contact info. See that file for the agreed design; do not invent details not in it.

---

## ADMIN PAGES

| Nav | Page ID | Loads |
|---|---|---|
| Dashboard | `page-dashboard` | KPI tiles, action-needed widget, upcoming events |
| Bookings | `page-bookings` | Full bookings table + CSV export + filters |
| Calendar | `page-calendar` | Two-month view with staff initials on events |
| Clients | `page-clients` | CRM view built from bookings |
| Staffing | `page-staff` | Staff cards + Staffing page with My Portal |
| Catalogue | `page-catalogue` | Services, add-ons, staff slots, event type mappings, time templates |
| Payroll | `page-payroll` | Custom date range payroll runs (preflight, generate, approve, pay) |
| Automations | `page-automations` | Email rules, email log, run scheduled |
| Analytics | `page-analytics` | Revenue, referrals, service breakdown |
| My Portal | `page-portal` | Staff-only: gigs + schedule, checklist, survey, earnings |

---

## KEY PATTERNS

### Netlify Function Pattern
```javascript
const { withClient } = require('./_db');
const { CORS, preflight, requireAuth, unauthorized } = require('./_auth');

const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

exports.handler = async (event) => {
  const pre = preflight(event);
  if (pre) return pre;
  const auth = await requireAuth(event); // or requireAuth(event, ['admin'])
  if (!auth) return unauthorized();

  return withClient(async (client) => {
    // ... your logic
    return json(200, { success: true });
  });
};
```

**Critical:** Always use `withClient()` from `_db.js`. Never use `new Pool()` or `new Client()` — they crash on reuse in serverless. If you use `getPool().connect()` directly, wrap in `try/finally { client.release() }`.

### PATCH endpoints — use colMap pattern
Only update fields explicitly provided. See `booking.js` `colMap` for reference.

### Frontend helpers
```javascript
// Shared authenticated fetch — defined in admin.html and staff-portal.html.
// The helper is named apiFetch (there is NO callApi — a stale call to one
// was a real bug, fixed June 2026). It injects the Bearer token from
// sessionStorage and reloads to the login screen on 401.
async function apiFetch(url, opts = {}) {
  // url is the full path, e.g. '/api/bookings'
  // returns the raw Response — callers check res.ok / parse JSON themselves
}
function esc(str) {
  return String(str||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
```
Always use `esc()` when injecting user data into HTML strings.

---

## GENERAL RULES

- **Read before writing.** Always read the relevant file before editing it.
- **One thing at a time.** Fix what's asked. Don't refactor unrelated code.
- **Keep it simple.** Vanilla JS, not React. No unnecessary abstractions.
- **Staff privacy is non-negotiable.** Enforced at every layer.
- **Email goes through `_email.js`.** Never duplicate email logic.
- **Never commit `.env`.**
- **Stripe = Checkout Sessions only.** Not Payment Links.
- **Never include actual credentials, tokens, or .env values in code, docs, or commits.**
- **API_CONTRACT.md is the authoritative access reference.** When in doubt about who can call what, read it.

---

## LOCAL DEV SETUP

```bash
cd ~/Downloads/funky-monkey-email
npx netlify dev
# → http://localhost:8888/admin.html
```

- `.env` file lives in project folder — **never committed to git, must be copied manually**
- `.gitignore` excludes: `.env`, `node_modules/`, `.DS_Store`, `package-lock.json`
- Netlify CLI is **not** logged in locally — local dev uses `npx netlify dev` with the local `.env`

---

## GIT & DEPLOYMENT

**Repo:** https://github.com/mxjoker/funkymonkeyadmin

```bash
git add netlify/functions/whatever-changed.js
git commit -m "fix: description"
git push
```

**Deploy process:** `git push` to `main` triggers a Netlify build, but **autopublish is OFF**. After the build succeeds you must **manually click Publish** in the Netlify dashboard.

**Rollback tag:** `pre-hardening` — points to the commit before the June 2026 auth hardening.

**Never commit `.env`.**

---

## SCRIPTS

All scripts read `DATABASE_URL` from `.env` or the environment.

### `scripts/migrate-auth.js`
Idempotent auth provisioning. Safe to re-run. Does:
- Creates `sessions`, `login_attempts`, `admin_settings` tables
- Adds `staff.access_code_hash` column
- Generates a `word-word-word-NN` access code for every active staff member that doesn't have one yet
- Seeds a generated admin password if none is stored in DB yet

**Prints all newly generated credentials to stdout ONCE.** They are stored only as hashes — copy them before closing the terminal.

```bash
DATABASE_URL=<your_url> node scripts/migrate-auth.js
```

### `scripts/cleanup-backlog.js`
Cleans up stale booking statuses. Dry-run by default:
```bash
node scripts/cleanup-backlog.js           # dry run (counts only)
node scripts/cleanup-backlog.js --apply   # execute
```
Before applying, writes a rollback JSON file (`scripts/backlog-rollback-<date>.json`) with old statuses.

### `scripts/payroll-migration.js`
Payroll schema migration. Run once when setting up payroll tables.

### `scripts/backfill-assignment-times.js`
One-time migration: populates schedule time columns for existing assignments.
Already run May 15, 2026 — 16 assignments backfilled.

---

## DEPLOYMENT CHECKLIST

- [ ] Set all required env vars in Netlify: `DATABASE_URL`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `RESEND_API_KEY`, `NOTIFY_EMAIL`
- [ ] `ADMIN_PASSWORD` is optional after running `migrate-auth.js` (DB-stored hash takes precedence)
- [ ] Run `scripts/migrate-auth.js` against the production DB to provision auth tables and generate initial credentials
- [ ] Verify sending domain in Resend dashboard (`funkymonkeyevents.com` — DNS on Cloudflare, must be grey cloud / DNS-only)
- [ ] Set Stripe webhook endpoint to `https://yoursite.netlify.app/api/stripe-webhook`
- [ ] Confirm `STRIPE_WEBHOOK_SECRET` is set — webhook is fail-closed without it
- [ ] Confirm `STRIPE_SECRET_KEY` is the live key before going live
- [ ] Test full booking → confirm → deposit flow in Stripe test mode first
- [ ] After `git push`, manually publish the deploy in Netlify dashboard (autopublish is OFF)

---

## RECENTLY RESOLVED

| Feature | Status | Date |
|---|---|---|
| Mobile UX pass (staff portal + admin bookings) | COMPLETED | June 2026 |
| Production hardening: token auth on all endpoints | COMPLETED | June 2026 |
| Fail-closed idempotent Stripe webhook | COMPLETED | June 2026 |
| Money-math fixes | COMPLETED | June 2026 |
| Repo cleanup + instant-book.html retired to attic | COMPLETED | June 2026 |
| Staff access codes replacing PINs | COMPLETED | June 2026 |
| Staff can save pronouns + staff_notes from portal | COMPLETED | June 2026 |
| Schedule block save fix (callApi helper) | COMPLETED | June 2026 |
| Gig scheduling system | COMPLETED | May 15, 2026 |
| Custom payroll date ranges | COMPLETED | May 15, 2026 |
| 5-hour minimum pay | COMPLETED | May 15, 2026 |
| Paid-gig payroll exclusion | COMPLETED | May 15, 2026 |
| Schedule block in assignment email | COMPLETED | May 15, 2026 |
| Backfill migration script | RAN — 16 existing assignments populated | May 15, 2026 |
| Gig Time Templates in Catalogue | COMPLETED | May 15, 2026 |
| Bookings filters & sorting | COMPLETED | May 7, 2026 |
| Historical data import | COMPLETED — 635 bookings imported | May 7, 2026 |
| Database indexes | DEPLOYED — 27 indexes | May 7, 2026 |
| Staff Feedback Loop | COMPLETED | May 6, 2026 |
| Enhanced COI Request System | COMPLETED | May 6, 2026 |
| PDF Invoice Generator | COMPLETED | May 6, 2026 |
| Refunds system | COMPLETED | May 6, 2026 |
| Booking change log / audit trail | COMPLETED | May 6, 2026 |
| Dashboard KPI tiles + staffing warnings | COMPLETED | May 6, 2026 |
| Slot-based Staff Assignment UI | COMPLETED | May 2026 |
| Staff payment tracking + payroll | COMPLETED | May 2026 |

---

## FEATURE ROADMAP

**1. Instant Booking v2 (foam parties)** — see `docs/ROADMAP.md` for the agreed design (foam gigs ≥2 weeks out, availability gate, zip-based mileage table, required contact info, Stripe deposit at booking time). Do not implement without reading that file first.

**2. SMS notifications** — `_sms.js` (Twilio) is complete but nothing calls it. To activate: Twilio account + A2P 10DLC registration; set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER` in Netlify; wire into staff gig-assignment notifications (`comms_preference = 'sms'` already exists on staff records) and client deposit-link delivery.

**3. Financial export** — expand accounting export with staff fees, expenses, and profit per gig.
