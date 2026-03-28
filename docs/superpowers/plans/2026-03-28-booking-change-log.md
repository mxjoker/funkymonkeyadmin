# Booking Change Log Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only activity log to each booking that records high-signal changes (status, payment, contract, notes, Stripe deposit) and displays them in the booking modal.

**Architecture:** `logChange()` and `ensureBookingChanges()` live in `_email.js` (shared module) so both `booking.js` and `stripe-webhook.js` can use them. `booking.js` gets a new `GET ?activity=true` handler. `admin.html` gets an Activity section at the bottom of the booking modal.

**Tech Stack:** Node.js Netlify Functions, PostgreSQL via `pg`, plain HTML + Vanilla JS, `_email.js` shared module pattern.

---

## File Map

| File | Change |
|---|---|
| `netlify/functions/_email.js` | Add `ensureBookingChanges()`, `logChange()`, export both |
| `netlify/functions/booking.js` | Import both; call `ensureBookingChanges` at start; add GET `?activity=true` handler; add 4 `logChange` if-blocks covering 5 log events in PATCH |
| `netlify/functions/stripe-webhook.js` | Remove local `sendEmail`/`wrap`/`FROM` duplicates; import shared helpers; add `ensureEmailLog`, `ensureBookingChanges` calls; add `logChange` + 2 `logEmail` calls |
| `admin.html` | Add Activity section to modal HTML; add `loadBookingActivity()` function; call it in `openBooking()` |

---

## Task 1: Add `ensureBookingChanges` and `logChange` to `_email.js`

**Files:**
- Modify: `netlify/functions/_email.js`

- [ ] **Step 1: Add `ensureBookingChanges` function**

Insert before the `module.exports` line at the bottom of `_email.js`:

```javascript
// ── Ensure booking_changes table exists ───────────────────────────────────────
async function ensureBookingChanges(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS booking_changes (
      id         SERIAL PRIMARY KEY,
      booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
      action     VARCHAR(100) NOT NULL,
      detail     TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_booking_changes_booking_id
    ON booking_changes(booking_id)
  `);
}
```

- [ ] **Step 2: Add `logChange` function**

Insert directly after `ensureBookingChanges`, before `module.exports`:

```javascript
// ── Log a booking change ───────────────────────────────────────────────────────
async function logChange(client, bookingId, action, detail) {
  await client.query(
    `INSERT INTO booking_changes (booking_id, action, detail) VALUES ($1, $2, $3)`,
    [bookingId, action, detail || '']
  );
}
```

- [ ] **Step 3: Export both new functions**

Replace the existing `module.exports` line:

```javascript
// Before:
module.exports = { wrap, render, sendEmail, logEmail, fireStatusAutomations, ensureEmailLog };

// After:
module.exports = { wrap, render, sendEmail, logEmail, fireStatusAutomations, ensureEmailLog, ensureBookingChanges, logChange };
```

- [ ] **Step 4: Verify the file looks correct**

Run: `node -e "const e = require('./netlify/functions/_email.js'); console.log(Object.keys(e))"`

Expected output: `[ 'wrap', 'render', 'sendEmail', 'logEmail', 'fireStatusAutomations', 'ensureEmailLog', 'ensureBookingChanges', 'logChange' ]`

- [ ] **Step 5: Commit**

```bash
git add netlify/functions/_email.js
git commit -m "feat: add ensureBookingChanges and logChange to shared _email.js"
```

---

## Task 2: Update `booking.js` — GET handler + logChange calls

**Files:**
- Modify: `netlify/functions/booking.js`

- [ ] **Step 1: Update the import line at the top**

```javascript
// Before:
const { wrap, render, sendEmail, logEmail, fireStatusAutomations, ensureEmailLog } = require('./_email');

// After:
const { wrap, render, sendEmail, logEmail, fireStatusAutomations, ensureEmailLog, ensureBookingChanges, logChange } = require('./_email');
```

- [ ] **Step 2: Call `ensureBookingChanges` alongside `ensureEmailLog`**

```javascript
// Before:
await ensureEmailLog(c);

// After:
await ensureEmailLog(c);
await ensureBookingChanges(c);
```

- [ ] **Step 3: Add GET handler for `?activity=true`**

> ⚠️ Steps 1–3 must be applied in order in the same edit session. Step 3's anchor (`await ensureBookingChanges(c);`) is added by Step 2 — it does not exist in the original file.

Insert a new `if` block after the OPTIONS check and before the PATCH block. Add it right after `await ensureBookingChanges(c);`:

```javascript
if (event.httpMethod === "GET") {
  if (event.queryStringParameters?.activity !== 'true') {
    return { statusCode: 405, headers: h, body: JSON.stringify({ error: "Method not allowed" }) };
  }
  const { rows: changes } = await c.query(
    `SELECT id, action, detail, created_at FROM booking_changes
     WHERE booking_id=$1 ORDER BY created_at DESC`,
    [parseInt(id)]
  );
  return { statusCode: 200, headers: h, body: JSON.stringify({ changes }) };
}
```

- [ ] **Step 4: Fetch old status before the PATCH UPDATE (needed for the status change log)**

Add these lines just before the `const sets = [], vals = [];` line in the PATCH block:

```javascript
// Fetch old status for change log (only when a status change is incoming)
let prevStatus = null;
if (u.status) {
  const prev = await c.query('SELECT status FROM bookings WHERE id=$1', [parseInt(id)]);
  prevStatus = prev.rows[0]?.status || '?';
}
```

- [ ] **Step 5: Add `logChange` calls after the PATCH UPDATE succeeds**

After `let updated = r.rows[0];` and after the Stripe link block and `fireStatusAutomations` block, add:

```javascript
// Log high-signal changes to booking_changes
if (u.status && prevStatus !== u.status) {
  await logChange(c, parseInt(id), 'Status changed', `${prevStatus} → ${u.status}`);
}
if (u.payment_amount !== undefined && u.payment_method !== undefined) {
  const amt = `$${Number(u.payment_amount).toFixed(2)} ${u.payment_method}`;
  const ref = u.payment_ref ? ` — Ref: ${u.payment_ref}` : '';
  await logChange(c, parseInt(id), 'Payment recorded', amt + ref);
}
if (u.contract_signed !== undefined || u.contractSigned !== undefined) {
  const signed = u.contract_signed ?? u.contractSigned;
  await logChange(c, parseInt(id), signed ? 'Contract signed' : 'Contract unsigned', '');
}
if (u.admin_notes !== undefined) {
  await logChange(c, parseInt(id), 'Admin notes updated', '');
}
```

Place this block **before** the `return { statusCode: 200, headers: h, body: JSON.stringify(updated) };` line at the end of the PATCH block.

- [ ] **Step 6: Verify the final PATCH block structure**

The end of the PATCH block should read in order:
1. colMap update + column migrations
2. UPDATE query → `updated = r.rows[0]`
3. Auto Stripe link if confirmed
4. `fireStatusAutomations` if status in confirmed/cancelled/completed
5. `logChange` calls ← new
6. `return { statusCode: 200, ... }`

- [ ] **Step 7: Commit**

```bash
git add netlify/functions/booking.js
git commit -m "feat: booking.js GET activity handler and logChange calls"
```

---

## Task 3: Clean up `stripe-webhook.js` and add logging

**Files:**
- Modify: `netlify/functions/stripe-webhook.js`

This task also fixes a pre-existing architectural violation: `stripe-webhook.js` has local duplicates of `sendEmail` and `wrap` that should come from `_email.js`.

- [ ] **Step 1: Replace the top of the file**

Replace everything from line 1 through the local `sendEmail`/`wrap` definitions (lines 1–24) with:

```javascript
const { Client } = require("pg");
const crypto = require("crypto");
const { sendEmail, wrap, logEmail, logChange, ensureEmailLog, ensureBookingChanges } = require('./_email');

const db = () => new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const NOTIFY = process.env.NOTIFY_EMAIL || "Joe.Coover@gmail.com";
```

(`FROM` constant is removed — it lives in `_email.js` now. `NOTIFY` stays local since `_email.js` doesn't export it.)

- [ ] **Step 2: Add `ensureEmailLog` and `ensureBookingChanges` calls after `c.connect()`**

```javascript
// Before:
await c.connect();

// After:
await c.connect();
await ensureEmailLog(c);
await ensureBookingChanges(c);
```

- [ ] **Step 3: Add `logChange` after the deposit booking UPDATE**

After `const b = updated.rows[0];` in the `checkout.session.completed` block, add:

```javascript
await logChange(c, b.id, 'Deposit paid via Stripe', `$${amountPaid.toFixed(2)}`);
```

- [ ] **Step 4: Add `logEmail` calls after each `sendEmail` call in the `checkout.session.completed` block**

After the client confirmation `sendEmail(b.client_email, ...)` call:

```javascript
await logEmail(c, b.id, null, 'Deposit Paid', 'Deposit received — You\'re CONFIRMED! 🎊 Funky Monkey Events', b.client_email, 'client');
```

After the admin notification `sendEmail(NOTIFY, ...)` call:

```javascript
await logEmail(c, b.id, null, 'Deposit Paid', `💰 Deposit In: ${b.client_name} — $${amountPaid.toFixed(2)}`, NOTIFY, 'admin');
```

- [ ] **Step 5: Verify the file has no remaining local `sendEmail`, `wrap`, or `FROM` definitions**

Run: `grep -n "const sendEmail\|const wrap\|const FROM" netlify/functions/stripe-webhook.js`

Expected: no output (all three are now imported).

- [ ] **Step 6: Commit**

```bash
git add netlify/functions/stripe-webhook.js
git commit -m "refactor: stripe-webhook uses shared _email.js helpers; add logChange and logEmail on deposit"
```

---

## Task 4: Add Activity section to `admin.html` booking modal

**Files:**
- Modify: `admin.html`

- [ ] **Step 1: Add the Activity HTML to the booking modal**

In the `openBooking()` function, find the "Emails Sent" block inside the `currentUser?.role === 'admin'` ternary. It currently ends with:

```javascript
      <div id="email-log-${b.id}"><div style="color:#9ca3af;font-size:.8rem">Loading…</div></div>
    </div>` : ''}
```

Add the Activity section immediately before the closing `` ` : ''}`` of the admin block:

```javascript
    <div style="margin-top:18px;border-top:1px solid #e5e7eb;padding-top:18px">
      <div style="font-size:.7rem;text-transform:uppercase;letter-spacing:.08em;font-weight:700;color:#9ca3af;margin-bottom:10px">📋 Activity</div>
      <div id="activity-log-${b.id}"><div style="color:#9ca3af;font-size:.8rem">Loading…</div></div>
    </div>
```

- [ ] **Step 2: Call `loadBookingActivity` in `openBooking()`**

In the `openBooking()` function, find the block that calls `loadBookingEmailLog` and `loadBookingTasks`:

```javascript
    const logContainer = document.getElementById('email-log-' + b.id);
    if (logContainer) loadBookingEmailLog(b.id, logContainer);
```

Add immediately after:

```javascript
    const activityContainer = document.getElementById('activity-log-' + b.id);
    if (activityContainer) loadBookingActivity(b.id, activityContainer);
```

- [ ] **Step 3: Add the `loadBookingActivity` function**

Add this function directly after `loadBookingEmailLog` (around line 2587):

```javascript
async function loadBookingActivity(bookingId, container) {
  try {
    const res = await fetch(`/api/booking/${bookingId}?activity=true`);
    const { changes } = await res.json();
    if (!changes || !changes.length) {
      container.innerHTML = '<p style="color:#9ca3af;font-size:.8rem;font-style:italic">No activity recorded.</p>';
      return;
    }
    container.innerHTML = changes.map(e => `
      <div style="display:flex;gap:10px;align-items:flex-start;padding:6px 0;border-bottom:1px solid #f3f4f6;font-size:.78rem">
        <div style="color:#9ca3af;white-space:nowrap;min-width:90px">${new Date(e.created_at).toLocaleDateString('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}</div>
        <div style="flex:1">
          <span style="font-weight:600;color:#374151">${esc(e.action)}</span>
          ${e.detail ? `<span style="color:#9ca3af"> — ${esc(e.detail)}</span>` : ''}
        </div>
      </div>`).join('');
  } catch(e) { container.innerHTML = '<p style="color:#dc2626;font-size:.8rem">Failed to load.</p>'; }
}
```

- [ ] **Step 4: Commit**

```bash
git add admin.html
git commit -m "feat: activity log section in booking modal"
```

---

## Task 5: Manual verification

- [ ] **Step 1: Start dev server**

```bash
cd ~/Downloads/funky-monkey-email
npx netlify dev
```

Open http://localhost:8888/admin.html

- [ ] **Step 2: Verify Activity section renders**

Open any booking modal. Confirm the "📋 Activity" section appears at the bottom of the admin panel and shows "No activity recorded." (or existing entries if any were logged previously).

- [ ] **Step 3: Verify status change logging**

Change a booking's status via the status pills. Close and reopen the modal. Confirm an entry like `"Status changed — pending → confirmed"` appears in the Activity section.

- [ ] **Step 4: Verify payment logging**

Record a payment on a booking (fill in amount + method, click Save Payment). Reopen modal. Confirm `"Payment recorded — $X.XX cash"` (or similar) appears.

- [ ] **Step 5: Verify contract logging**

Toggle "Mark Contract Signed" on a booking. Reopen modal. Confirm `"Contract signed"` appears.

- [ ] **Step 6: Verify admin notes logging**

Save admin notes on a booking. Reopen modal. Confirm `"Admin notes updated"` appears.

- [ ] **Step 7: Verify stripe-webhook cleanup**

```bash
grep -n "const sendEmail\|const wrap\|const FROM" netlify/functions/stripe-webhook.js
```

Expected: no output.

- [ ] **Step 8: Final commit if any fixes needed, then push**

```bash
git push
```
