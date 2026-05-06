# Auto-Notify Staff on New Bookings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a new booking is submitted, automatically email matching staff without Joe having to click "📣 Notify Matching Staff."

**Architecture:** The `notify_staff` logic already exists inside `staff-assignments.js`'s HTTP handler. We extract it into an exported `notifyMatchingStaff(booking)` async function (with its own DB connection) and call it fire-and-forget from `bookings.js` POST after inserting the new booking — exactly like `sendEmails` is already called. No new tables, no frontend changes.

**Tech Stack:** Node.js, `pg`, Resend API (via existing `notify` helper in `staff-assignments.js`).

---

## Files Modified

- `netlify/functions/staff-assignments.js` — add exported `notifyMatchingStaff` function
- `netlify/functions/bookings.js` — import and call `notifyMatchingStaff` after booking insert

---

## Task 1: Export `notifyMatchingStaff` from staff-assignments.js

Extract the DB + email logic from the `notify_staff` action into a standalone exported function. It manages its own pool connection so callers don't need to pass one.

**Files:**
- Modify: `netlify/functions/staff-assignments.js` (add after line ~564, end of handler)

- [ ] **Step 1: Add the exported function at the bottom of the file**

Open `netlify/functions/staff-assignments.js`. Find the very end of the file (after `exports.handler = ...`). Add this block:

```javascript
// Exported for use by bookings.js — fires automatically on new booking
exports.notifyMatchingStaff = async function notifyMatchingStaff(booking) {
  if (!booking || !booking.id) return;
  const client = await pool.connect();
  try {
    await ensureTables(client);

    const { rows: slots } = await client.query(
      'SELECT * FROM staff_slots WHERE service_id=$1 ORDER BY sort_order',
      [booking.service_id]
    );

    const tags = slots.length
      ? [...new Set(slots.map(s => s.tag_required))]
      : [booking.service_name];

    const { rows: allStaff } = await client.query('SELECT * FROM staff WHERE active=TRUE');
    const eligible = allStaff.filter(s => {
      const skills = Array.isArray(s.skills) ? s.skills : JSON.parse(s.skills || '[]');
      return skills.some(sk => tags.includes(sk.name));
    });

    const dateStr = booking.event_date
      ? new Date(booking.event_date + 'T00:00:00').toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric', year:'numeric' })
      : 'TBD';
    const timeStr = booking.event_time || '';

    for (const staff of eligible) {
      const skills = Array.isArray(staff.skills) ? staff.skills : JSON.parse(staff.skills || '[]');
      const matchedTags = skills.filter(sk => tags.includes(sk.name)).map(sk => sk.name);
      await notify({
        to_email: staff.email,
        to_name: staff.preferred_name || staff.name,
        subject: `🎪 Gig Available — ${booking.service_name} on ${dateStr}`,
        html: wrap(`
          <p style="font-size:16px;margin-bottom:16px">Hi <strong>${staff.preferred_name || staff.name}</strong>! 👋</p>
          <p style="color:#A78BCA;line-height:1.7;margin-bottom:20px">A new gig is available and your skills match what's needed. Log in to the staff portal to express your interest!</p>
          <div style="background:#1A1035;border-radius:12px;padding:16px;margin-bottom:20px">
            <div style="margin-bottom:10px"><span style="color:#A78BCA;font-size:11px;text-transform:uppercase;font-weight:700">Service</span><br><span style="font-weight:600">${booking.service_name}</span></div>
            <div style="margin-bottom:10px"><span style="color:#A78BCA;font-size:11px;text-transform:uppercase;font-weight:700">Date & Time</span><br><span style="font-weight:600">${dateStr}${timeStr ? ' at ' + timeStr : ''}</span></div>
            <div style="margin-bottom:10px"><span style="color:#A78BCA;font-size:11px;text-transform:uppercase;font-weight:700">Area</span><br><span style="font-weight:600">${booking.event_zip || 'OKC area'}</span></div>
            <div><span style="color:#A78BCA;font-size:11px;text-transform:uppercase;font-weight:700">Your Matching Skills</span><br><span style="color:#FFD600;font-weight:700">${matchedTags.join(', ')}</span></div>
          </div>
          <div style="text-align:center;margin-bottom:20px">
            <a href="${SITE}/admin.html" style="background:linear-gradient(135deg,#7c3aed,#a855f7);color:#fff;padding:14px 32px;border-radius:10px;text-decoration:none;font-weight:900;font-size:15px;display:inline-block">Log In to Express Interest →</a>
          </div>
          <p style="font-size:12px;color:#A78BCA;text-align:center">Log in with your PIN · ${SITE}/admin.html</p>
        `)
      });
    }
    console.log(`notifyMatchingStaff: notified ${eligible.length} staff for booking ${booking.id}`);
  } catch(e) {
    console.error('notifyMatchingStaff error:', e.message);
  } finally {
    client.release();
  }
};
```

- [ ] **Step 2: Verify the export is at module scope**

The function must appear after `exports.handler = async ...` closes, not inside it. Double-check that `exports.notifyMatchingStaff = ...` is at the top level of the file (not nested inside the handler).

Quick check:
```bash
grep -n "exports\." netlify/functions/staff-assignments.js
```
Expected output: two lines — one for `exports.handler` and one for `exports.notifyMatchingStaff`.

---

## Task 2: Call `notifyMatchingStaff` from bookings.js

Import the exported function and fire it after every new booking insert, exactly like `sendEmails` — fire-and-forget, never blocks the response.

**Files:**
- Modify: `netlify/functions/bookings.js` (top of file for require, ~line 210 for the call)

- [ ] **Step 1: Add the require at the top of bookings.js**

Open `netlify/functions/bookings.js`. Find the existing requires at the top of the file. Add one line:

```javascript
const { notifyMatchingStaff } = require('./staff-assignments');
```

- [ ] **Step 2: Call it after the booking insert**

Find this block (~line 210):
```javascript
      // Send emails (fire and forget)
      sendEmails(booking).catch(e => console.error('Email error:', e));

      return {
        statusCode: 201,
```

Replace with:
```javascript
      // Send emails (fire and forget)
      sendEmails(booking).catch(e => console.error('Email error:', e));
      // Notify matching staff automatically
      notifyMatchingStaff(booking).catch(e => console.error('Staff notify error:', e));

      return {
        statusCode: 201,
```

- [ ] **Step 3: Verify manually**

Start dev server: `npx netlify dev`

Submit a test booking on `http://localhost:8888/booking-form.html` for a service that has staff slots configured (e.g. a Magic Show). Check the Netlify function logs in terminal for:
```
notifyMatchingStaff: notified X staff for booking Y
```

Also confirm the booking response still returns `201` quickly (not delayed by the notification).

- [ ] **Step 4: Commit**

```bash
git add netlify/functions/staff-assignments.js netlify/functions/bookings.js
git commit -m "feat: auto-notify matching staff on new booking submission"
```

---

## Verification

- [ ] New booking submitted → terminal logs show `notifyMatchingStaff: notified X staff for booking Y`
- [ ] Staff with matching skill tags receive the email (check Resend dashboard or test email inbox)
- [ ] Booking form still returns a success response promptly (notifications are fire-and-forget)
- [ ] Manual "📣 Notify Matching Staff" button in admin still works (it calls the `notify_staff` action in the handler, unchanged)
- [ ] No regression: existing bookings unaffected, other POST actions in staff-assignments.js still work
