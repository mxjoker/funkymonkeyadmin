# Staff Payment Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Joe set pay rates per staff member, record per-gig payments, mark them paid, and let staff see their own pay history in the portal.

**Architecture:** Four layers: (1) `staff.js` gains pay-rate fields via migration; (2) a new `staff-payments.js` Netlify function manages a `staff_payments` table; (3) `admin.html` gains a pay-settings section in the staff modal, per-assignment pay + record-payment UI in the booking modal, and an unpaid-payments summary on the Staffing page; (4) the staff portal gains a pay history section. All frontend calls go through the existing `callApi` / `fetch` pattern.

**Tech Stack:** Vanilla JS, plain HTML, PostgreSQL via `pg`, Netlify Functions.

---

## Files Modified / Created

| File | Change |
|------|--------|
| `netlify/functions/staff.js` | Add 5 pay columns to migrations + colMap |
| `netlify/functions/staff-payments.js` | **NEW** — CRUD for `staff_payments` table |
| `netlify.toml` | Add `/api/staff-payments` redirect |
| `admin.html` | Staff modal pay section, booking modal pay row, Staffing page overview, portal pay history |

---

## Task 1: Add Pay Fields to staff.js

New columns on the `staff` table: `pay_type` (flat/hourly), `flat_rate`, `hourly_rate`, `payment_method`, `payment_handle`. Added via the existing migration pattern so they auto-apply to the live DB.

**Files:**
- Modify: `netlify/functions/staff.js` (~line 38 migrations array, ~line 151 colMap)

- [ ] **Step 1: Add migrations to ensureTable**

In `staff.js`, find the `migrations` array (~line 38). Add these five lines inside it:

```javascript
    "ALTER TABLE staff ADD COLUMN IF NOT EXISTS pay_type VARCHAR(20) DEFAULT 'flat'",
    "ALTER TABLE staff ADD COLUMN IF NOT EXISTS flat_rate NUMERIC(10,2) DEFAULT 0",
    "ALTER TABLE staff ADD COLUMN IF NOT EXISTS hourly_rate NUMERIC(10,2) DEFAULT 0",
    "ALTER TABLE staff ADD COLUMN IF NOT EXISTS payment_method VARCHAR(64) DEFAULT ''",
    "ALTER TABLE staff ADD COLUMN IF NOT EXISTS payment_handle VARCHAR(255) DEFAULT ''",
```

- [ ] **Step 2: Add fields to PATCH colMap**

In the PATCH handler colMap (~line 151), add five entries after `sort_order`:

```javascript
        pay_type:          'pay_type',
        flat_rate:         'flat_rate',
        hourly_rate:       'hourly_rate',
        payment_method:    'payment_method',
        payment_handle:    'payment_handle',
```

- [ ] **Step 3: Commit**

```bash
git add netlify/functions/staff.js
git commit -m "feat: add pay rate and payment method fields to staff table"
```

---

## Task 2: staff-payments.js + netlify.toml Route

New Netlify function managing `staff_payments`. Supports GET (by booking or staff or all unpaid), POST (create), PATCH (mark paid / update), DELETE (remove).

**Files:**
- Create: `netlify/functions/staff-payments.js`
- Modify: `netlify.toml`

- [ ] **Step 1: Create netlify/functions/staff-payments.js**

```javascript
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  'Content-Type': 'application/json'
};

async function ensureTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS staff_payments (
      id SERIAL PRIMARY KEY,
      staff_id INTEGER NOT NULL,
      booking_id INTEGER NOT NULL,
      amount NUMERIC(10,2) NOT NULL DEFAULT 0,
      pay_type VARCHAR(20) DEFAULT 'flat',
      hours NUMERIC(5,2),
      paid BOOLEAN DEFAULT FALSE,
      paid_at TIMESTAMPTZ,
      payment_method VARCHAR(64) DEFAULT '',
      note TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: HEADERS, body: '' };

  const client = await pool.connect();
  try {
    await ensureTable(client);
    const params = event.queryStringParameters || {};
    const body = event.body ? JSON.parse(event.body) : {};

    // GET — list payments
    if (event.httpMethod === 'GET') {
      let sql = 'SELECT sp.*, s.name AS staff_name, s.preferred_name, s.color FROM staff_payments sp LEFT JOIN staff s ON s.id=sp.staff_id WHERE 1=1';
      const vals = [];
      let idx = 1;
      if (params.booking_id) { sql += ` AND sp.booking_id=$${idx++}`; vals.push(parseInt(params.booking_id)); }
      if (params.staff_id)   { sql += ` AND sp.staff_id=$${idx++}`; vals.push(parseInt(params.staff_id)); }
      if (params.unpaid === 'true') { sql += ` AND sp.paid=FALSE`; }
      sql += ' ORDER BY sp.created_at DESC';
      const { rows } = await client.query(sql, vals);
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ payments: rows }) };
    }

    // POST — create payment record
    if (event.httpMethod === 'POST') {
      const { staff_id, booking_id, amount, pay_type, hours, payment_method, note } = body;
      if (!staff_id || !booking_id) {
        return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'staff_id and booking_id required' }) };
      }
      const { rows } = await client.query(`
        INSERT INTO staff_payments (staff_id, booking_id, amount, pay_type, hours, payment_method, note)
        VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *
      `, [
        parseInt(staff_id),
        parseInt(booking_id),
        Number(amount) || 0,
        pay_type || 'flat',
        hours ? Number(hours) : null,
        payment_method || '',
        note || ''
      ]);
      return { statusCode: 201, headers: HEADERS, body: JSON.stringify({ payment: rows[0] }) };
    }

    // PATCH — update (mark paid, change amount/note)
    if (event.httpMethod === 'PATCH') {
      const id = event.path.split('/').pop();
      if (!id || isNaN(parseInt(id))) {
        return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid ID' }) };
      }
      const colMap = { amount:'amount', pay_type:'pay_type', hours:'hours', payment_method:'payment_method', note:'note', paid:'paid' };
      const sets = [], vals = [];
      let idx = 1;
      for (const [k, col] of Object.entries(colMap)) {
        if (body[k] !== undefined) { sets.push(`${col}=$${idx++}`); vals.push(body[k]); }
      }
      if (body.paid === true) { sets.push(`paid_at=NOW()`); }
      if (body.paid === false) { sets.push(`paid_at=NULL`); }
      if (!sets.length) return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Nothing to update' }) };
      sets.push(`updated_at=NOW()`);
      vals.push(parseInt(id));
      const { rows } = await client.query(`UPDATE staff_payments SET ${sets.join(',')} WHERE id=$${idx} RETURNING *`, vals);
      if (!rows.length) return { statusCode: 404, headers: HEADERS, body: JSON.stringify({ error: 'Not found' }) };
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ payment: rows[0] }) };
    }

    // DELETE
    if (event.httpMethod === 'DELETE') {
      const id = event.path.split('/').pop();
      await client.query('DELETE FROM staff_payments WHERE id=$1', [parseInt(id)]);
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ success: true }) };
    }

    return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
  } catch(err) {
    console.error('staff-payments error:', err.message);
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: err.message }) };
  } finally {
    client.release();
  }
};
```

- [ ] **Step 2: Add route to netlify.toml**

Open `netlify.toml`. After the `[api/staff-assignments]` block (~line 43), add:

```toml
[[redirects]]
  from = "/api/staff-payments"
  to = "/.netlify/functions/staff-payments"
  status = 200

[[redirects]]
  from = "/api/staff-payments/:id"
  to = "/.netlify/functions/staff-payments/:id"
  status = 200
```

- [ ] **Step 3: Verify route works**

Start dev server: `npx netlify dev`

Run:
```bash
curl -s http://localhost:8888/api/staff-payments | python3 -m json.tool
```
Expected: `{"payments": []}`

- [ ] **Step 4: Commit**

```bash
git add netlify/functions/staff-payments.js netlify.toml
git commit -m "feat: add staff-payments API and DB table"
```

---

## Task 3: Pay Settings Section in Staff Modal

Add a "Pay Settings" section to the staff edit modal so Joe can set each staff member's pay type (flat/hourly), rate, and payment handle.

**Files:**
- Modify: `admin.html` — `openStaffModal` function (~line 1721), `saveStaffModal` function (~line 1832)

- [ ] **Step 1: Add pay fields to openStaffModal**

In `openStaffModal` (~line 1721), find where the modal HTML string is built. It ends with a "Notes to Staff" textarea and Save/Cancel buttons. Insert the pay settings block **before** the Save/Cancel buttons:

```javascript
    <div style="margin-top:16px;border-top:1px solid #e5e7eb;padding-top:16px">
      <div style="font-weight:700;color:#374151;font-size:.82rem;margin-bottom:10px;text-transform:uppercase;letter-spacing:.04em">💰 Pay Settings</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <div>
          <label style="font-size:.78rem;font-weight:600;color:#6b7280">Pay Type</label>
          <select id="sm-pay-type" style="width:100%;padding:6px 8px;border:1px solid #d1d5db;border-radius:6px;margin-top:3px">
            <option value="flat" ${(s?.pay_type||'flat')==='flat'?'selected':''}>Flat rate per gig</option>
            <option value="hourly" ${s?.pay_type==='hourly'?'selected':''}>Hourly</option>
          </select>
        </div>
        <div id="sm-rate-wrap">
          <label style="font-size:.78rem;font-weight:600;color:#6b7280" id="sm-rate-label">Flat Rate ($)</label>
          <input type="number" id="sm-pay-rate" min="0" step="0.01" value="${s?.pay_type==='hourly' ? (s?.hourly_rate||0) : (s?.flat_rate||0)}" style="width:100%;padding:6px 8px;border:1px solid #d1d5db;border-radius:6px;margin-top:3px"/>
        </div>
        <div>
          <label style="font-size:.78rem;font-weight:600;color:#6b7280">Payment Method</label>
          <select id="sm-payment-method" style="width:100%;padding:6px 8px;border:1px solid #d1d5db;border-radius:6px;margin-top:3px">
            <option value="" ${!s?.payment_method?'selected':''}>— Select —</option>
            <option value="Venmo" ${s?.payment_method==='Venmo'?'selected':''}>Venmo</option>
            <option value="Zelle" ${s?.payment_method==='Zelle'?'selected':''}>Zelle</option>
            <option value="Check" ${s?.payment_method==='Check'?'selected':''}>Check</option>
            <option value="Cash" ${s?.payment_method==='Cash'?'selected':''}>Cash</option>
          </select>
        </div>
        <div>
          <label style="font-size:.78rem;font-weight:600;color:#6b7280">Handle / Details</label>
          <input type="text" id="sm-payment-handle" value="${esc(s?.payment_handle||'')}" placeholder="@username or note" style="width:100%;padding:6px 8px;border:1px solid #d1d5db;border-radius:6px;margin-top:3px"/>
        </div>
      </div>
    </div>
```

- [ ] **Step 2: Wire the pay-type toggle**

After the modal HTML is injected into the DOM (right after the `document.body.appendChild` or `innerHTML` call), add this JS to update the rate label when pay type changes:

```javascript
  const payTypeEl = document.getElementById('sm-pay-type');
  const rateLabelEl = document.getElementById('sm-rate-label');
  if (payTypeEl && rateLabelEl) {
    payTypeEl.addEventListener('change', () => {
      rateLabelEl.textContent = payTypeEl.value === 'hourly' ? 'Hourly Rate ($)' : 'Flat Rate ($)';
    });
  }
```

- [ ] **Step 3: Include pay fields in saveStaffModal**

In `saveStaffModal` (~line 1832), find where the `payload` object is constructed and add:

```javascript
    const payType = document.getElementById('sm-pay-type')?.value || 'flat';
    const payRate = parseFloat(document.getElementById('sm-pay-rate')?.value) || 0;
    payload.pay_type        = payType;
    payload.flat_rate       = payType === 'flat' ? payRate : 0;
    payload.hourly_rate     = payType === 'hourly' ? payRate : 0;
    payload.payment_method  = document.getElementById('sm-payment-method')?.value || '';
    payload.payment_handle  = document.getElementById('sm-payment-handle')?.value || '';
```

- [ ] **Step 4: Show pay info on staff card**

In `renderStaff` (~line 1558), inside the staff card HTML, add a pay rate line after the role/pronouns line. Find where `role` is displayed and add after it:

```javascript
      ${s.pay_type && (s.flat_rate > 0 || s.hourly_rate > 0)
        ? `<div style="font-size:.72rem;color:#10b981;font-weight:600;margin-top:2px">
             ${s.pay_type === 'hourly' ? `$${Number(s.hourly_rate).toFixed(0)}/hr` : `$${Number(s.flat_rate).toFixed(0)} flat`}
             ${s.payment_method ? ` · ${esc(s.payment_method)}${s.payment_handle ? ' ' + esc(s.payment_handle) : ''}` : ''}
           </div>`
        : ''}
```

- [ ] **Step 5: Verify manually**

Open admin → Staffing → edit a staff member. Confirm:
- "Pay Settings" section appears with Pay Type, Rate, Payment Method, Handle fields
- Switching Pay Type updates the rate label
- Saving updates the staff card (green pay line appears)

- [ ] **Step 6: Commit**

```bash
git add admin.html
git commit -m "feat: add pay settings to staff modal and card display"
```

---

## Task 4: Per-Assignment Pay in Booking Modal

In the booking modal's Staff Assignment section, show each assigned staff member's expected pay and a "Record Payment" button. Clicking it opens a small inline form to set amount and note; a "Mark Paid" button toggles paid status.

**Files:**
- Modify: `admin.html` — `loadStaffAssignments` (~line 1163)

- [ ] **Step 1: Fetch payments alongside assignments in loadStaffAssignments**

At the top of `loadStaffAssignments` (~line 1163), after the existing assignments fetch, add a payments fetch:

```javascript
async function loadStaffAssignments(bookingId) {
  const el = document.getElementById('staff-assign-body-' + bookingId);
  if (!el) return;
  try {
    const [assignRes, payRes] = await Promise.all([
      fetch('/api/staff-assignments?booking_id=' + bookingId),
      fetch('/api/staff-payments?booking_id=' + bookingId)
    ]);
    const { assignments, slots } = await assignRes.json();
    const { payments } = await payRes.json();
    // index payments by staff_id for quick lookup
    const payByStaff = {};
    (payments || []).forEach(p => { payByStaff[p.staff_id] = p; });
```

- [ ] **Step 2: Add pay row to each assigned staff member's render block**

Inside the `assignments.map(a => ...)` block (~line 1195), find where the assignment `<div>` is returned. After `${surveyHtml}`, add a pay block for assigned staff:

```javascript
      // Pay info block (assigned staff only)
      let payHtml = '';
      if (a.status === 'assigned') {
        const staffRecord = allStaff.find(s => s.id === a.staff_id);
        const pmt = payByStaff[a.staff_id];
        if (pmt) {
          const paidBadge = pmt.paid
            ? `<span style="background:#f0fdf4;color:#166534;border-radius:10px;padding:1px 7px;font-size:.68rem;font-weight:700">✅ Paid $${Number(pmt.amount).toFixed(2)}</span>`
            : `<span style="background:#fef3c7;color:#92400e;border-radius:10px;padding:1px 7px;font-size:.68rem;font-weight:700">⏳ Unpaid $${Number(pmt.amount).toFixed(2)}</span>`;
          payHtml = `<div style="margin-top:6px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            ${paidBadge}
            ${!pmt.paid
              ? `<button class="btn btn-outline btn-sm" style="padding:2px 8px;font-size:.72rem" onclick="markPaymentPaid(${pmt.id},'${bookingId}')">Mark Paid</button>`
              : `<button class="btn btn-outline btn-sm" style="padding:2px 8px;font-size:.72rem" onclick="markPaymentUnpaid(${pmt.id},'${bookingId}')">Undo</button>`
            }
            ${pmt.payment_method ? `<span style="font-size:.68rem;color:#6b7280">${esc(pmt.payment_method)}${pmt.payment_handle?' '+esc(pmt.payment_handle):''}</span>` : ''}
            ${pmt.note ? `<span style="font-size:.68rem;color:#6b7280;font-style:italic">${esc(pmt.note)}</span>` : ''}
          </div>`;
        } else {
          const defaultAmount = staffRecord
            ? (staffRecord.pay_type === 'hourly' ? '' : Number(staffRecord.flat_rate || 0).toFixed(2))
            : '';
          const defaultMethod = staffRecord?.payment_method || '';
          payHtml = `<div style="margin-top:6px">
            <div id="pay-form-${a.staff_id}-${bookingId}" style="display:none;margin-top:6px;padding:8px;background:#f3f4f6;border-radius:6px">
              <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
                <input type="number" id="pay-amount-${a.staff_id}-${bookingId}" value="${defaultAmount}" placeholder="Amount $" min="0" step="0.01"
                  style="width:90px;padding:4px 6px;border:1px solid #d1d5db;border-radius:4px;font-size:.78rem"/>
                <input type="text" id="pay-note-${a.staff_id}-${bookingId}" placeholder="Note (optional)"
                  style="flex:1;min-width:100px;padding:4px 6px;border:1px solid #d1d5db;border-radius:4px;font-size:.78rem"/>
                <button class="btn btn-primary btn-sm" style="padding:3px 10px;font-size:.75rem"
                  onclick="recordPayment(${a.staff_id},'${bookingId}','${esc(defaultMethod)}')">Save</button>
                <button class="btn btn-outline btn-sm" style="padding:3px 8px;font-size:.75rem"
                  onclick="document.getElementById('pay-form-${a.staff_id}-${bookingId}').style.display='none'">✕</button>
              </div>
            </div>
            <button class="btn btn-outline btn-sm" style="padding:2px 8px;font-size:.72rem;color:#7c3aed"
              onclick="document.getElementById('pay-form-${a.staff_id}-${bookingId}').style.display='block'">💰 Record Payment</button>
          </div>`;
        }
      }
```

Then include `${payHtml}` in the returned `<div>` just before the closing tag:

```javascript
      return `
        <div style="padding:8px 10px;background:#f9fafb;border-radius:8px;margin-bottom:8px">
          ...existing content...
          ${surveyHtml}
          ${payHtml}
        </div>`;
```

- [ ] **Step 3: Add recordPayment, markPaymentPaid, markPaymentUnpaid functions**

Add these three functions near `notifyStaff` (~line 1300):

```javascript
async function recordPayment(staffId, bookingId, defaultMethod) {
  const amount = parseFloat(document.getElementById(`pay-amount-${staffId}-${bookingId}`)?.value) || 0;
  const note   = document.getElementById(`pay-note-${staffId}-${bookingId}`)?.value || '';
  const staffRecord = allStaff.find(s => s.id === staffId);
  try {
    const res = await fetch('/api/staff-payments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        staff_id: staffId,
        booking_id: parseInt(bookingId),
        amount,
        pay_type: staffRecord?.pay_type || 'flat',
        payment_method: staffRecord?.payment_method || defaultMethod,
        note
      })
    });
    if (!res.ok) { const e = await res.json(); throw new Error(e.error || 'Failed'); }
    await loadStaffAssignments(bookingId);
  } catch(e) { alert('Error recording payment: ' + e.message); }
}

async function markPaymentPaid(paymentId, bookingId) {
  try {
    const res = await fetch('/api/staff-payments/' + paymentId, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paid: true })
    });
    if (!res.ok) { const e = await res.json(); throw new Error(e.error || 'Failed'); }
    await loadStaffAssignments(bookingId);
  } catch(e) { alert('Error: ' + e.message); }
}

async function markPaymentUnpaid(paymentId, bookingId) {
  try {
    const res = await fetch('/api/staff-payments/' + paymentId, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paid: false })
    });
    if (!res.ok) { const e = await res.json(); throw new Error(e.error || 'Failed'); }
    await loadStaffAssignments(bookingId);
  } catch(e) { alert('Error: ' + e.message); }
}
```

- [ ] **Step 4: Verify manually**

Open a booking modal with an assigned staff member.

Confirm:
- "💰 Record Payment" button appears under the assigned staff member row
- Clicking it reveals an inline form with amount pre-filled (if staff has a flat rate set)
- Saving records a payment and shows "⏳ Unpaid $X.XX" badge with "Mark Paid" button
- Clicking "Mark Paid" flips to "✅ Paid $X.XX"

- [ ] **Step 5: Commit**

```bash
git add admin.html
git commit -m "feat: record and track per-assignment staff payments in booking modal"
```

---

## Task 5: Unpaid Payments Overview on Staffing Page

Add an "Unpaid Payments" card below the staff grid on the Staffing page so Joe can see all outstanding payments at a glance and mark them paid without opening each booking.

**Files:**
- Modify: `admin.html` — `page-staff` HTML (~line 409), `renderStaff` function (~line 1542), add `loadUnpaidPayments` function

- [ ] **Step 1: Add the unpaid payments card to the Staffing page HTML**

Find `page-staff` (~line 409):
```html
    <div class="page" id="page-staff">
      <div class="page-hdr">
        <h1>Staffing</h1>
        <button class="btn btn-primary btn-sm" onclick="openAddStaff()">+ Add Staff</button>
      </div>
      <div class="staff-grid" id="staff-grid"></div>
    </div>
```

Replace with:
```html
    <div class="page" id="page-staff">
      <div class="page-hdr">
        <h1>Staffing</h1>
        <button class="btn btn-primary btn-sm" onclick="openAddStaff()">+ Add Staff</button>
      </div>
      <div class="staff-grid" id="staff-grid"></div>
      <div class="card" style="margin-top:16px">
        <div class="card-hdr"><h2>💰 Unpaid Payments</h2></div>
        <div id="unpaid-payments-body" style="padding:12px 16px">
          <span style="color:#9ca3af;font-style:italic">Loading…</span>
        </div>
      </div>
    </div>
```

- [ ] **Step 2: Add loadUnpaidPayments function**

Add this function near `renderStaff` (~line 1542):

```javascript
async function loadUnpaidPayments() {
  const el = document.getElementById('unpaid-payments-body');
  if (!el) return;
  try {
    const res = await fetch('/api/staff-payments?unpaid=true');
    const { payments } = await res.json();
    if (!payments.length) {
      el.innerHTML = '<div style="color:#10b981;font-weight:600;padding:8px 0">✅ All payments settled</div>';
      return;
    }
    const total = payments.reduce((s, p) => s + Number(p.amount || 0), 0);
    el.innerHTML = `
      <div style="margin-bottom:10px;font-size:.82rem;color:#6b7280">${payments.length} unpaid · Total owed: <strong style="color:#374151">$${total.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}</strong></div>
      <table style="width:100%;border-collapse:collapse;font-size:.82rem">
        <thead><tr style="border-bottom:1px solid #e5e7eb">
          <th style="text-align:left;padding:4px 8px;color:#9ca3af;font-size:.72rem;font-weight:600">Staff</th>
          <th style="text-align:left;padding:4px 8px;color:#9ca3af;font-size:.72rem;font-weight:600">Booking</th>
          <th style="text-align:left;padding:4px 8px;color:#9ca3af;font-size:.72rem;font-weight:600">Amount</th>
          <th style="text-align:left;padding:4px 8px;color:#9ca3af;font-size:.72rem;font-weight:600">Via</th>
          <th style="padding:4px 8px"></th>
        </tr></thead>
        <tbody>
          ${payments.map(p => {
            const booking = allBookings.find(b => b.id === p.booking_id);
            return `<tr style="border-bottom:1px solid #f3f4f6">
              <td style="padding:6px 8px;font-weight:600">${esc(p.preferred_name || p.staff_name || '—')}</td>
              <td style="padding:6px 8px;color:#6b7280">${booking ? `<span style="cursor:pointer;color:#7c3aed" onclick="openBooking('${p.booking_id}')">${esc(booking.reference)}</span>` : '#' + p.booking_id}</td>
              <td style="padding:6px 8px;font-weight:700;color:#374151">$${Number(p.amount).toFixed(2)}</td>
              <td style="padding:6px 8px;color:#6b7280">${esc(p.payment_method || '—')}${p.payment_handle?' '+esc(p.payment_handle):''}</td>
              <td style="padding:6px 8px;text-align:right">
                <button class="btn btn-primary btn-sm" style="padding:2px 10px;font-size:.72rem"
                  onclick="markPaymentPaidFromOverview(${p.id})">Mark Paid</button>
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>`;
  } catch(e) {
    el.innerHTML = '<span style="color:#dc2626">Failed to load payments.</span>';
  }
}

async function markPaymentPaidFromOverview(paymentId) {
  try {
    const res = await fetch('/api/staff-payments/' + paymentId, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paid: true })
    });
    if (!res.ok) { const e = await res.json(); throw new Error(e.error || 'Failed'); }
    await loadUnpaidPayments();
  } catch(e) { alert('Error: ' + e.message); }
}
```

- [ ] **Step 3: Call loadUnpaidPayments when Staffing page loads**

Find `showPage` function (or wherever `page-staff` is activated). Look for the `if (name === 'staff')` branch or equivalent and add the call. Search for:
```javascript
  if (name === 'staff') renderStaff();
```
Change to:
```javascript
  if (name === 'staff') { renderStaff(); loadUnpaidPayments(); }
```

- [ ] **Step 4: Verify manually**

Go to admin → Staffing. Confirm:
- "Unpaid Payments" card appears below the staff grid
- If there are unpaid payments, they show in the table
- "Mark Paid" button removes the row from the list
- "All payments settled" shows when empty

- [ ] **Step 5: Commit**

```bash
git add admin.html
git commit -m "feat: add unpaid payments overview to staffing page"
```

---

## Task 6: Staff Portal Pay History

In the staff portal, show the staff member's pay rate and a history of their payments (paid and unpaid).

**Files:**
- Modify: `admin.html` — portal rendering section (look for `renderPortalGigs` ~line 1865 and `loadPortal` or equivalent)

- [ ] **Step 1: Find the portal data load function**

Search for the function that fetches portal data for the logged-in staff member. It fetches `/api/staff-assignments?staff_id=X`. Note the function name.

```bash
grep -n "staff_id.*portal\|portal.*staff_id\|loadPortal\|renderPortal" admin.html | head -10
```

- [ ] **Step 2: Add payment fetch to portal load**

In the portal load function, after the staff assignments fetch, add a payments fetch:

```javascript
    const [assignRes, payRes, staffRes] = await Promise.all([
      fetch('/api/staff-assignments?staff_id=' + currentStaffId),
      fetch('/api/staff-payments?staff_id=' + currentStaffId),
      fetch('/api/staff/' + currentStaffId)
    ]);
    const assignData = await assignRes.json();
    const { payments: myPayments } = await payRes.json();
    const myStaffRecord = await staffRes.json();
```

(Replace the existing assignments fetch with this parallel version. `currentStaffId` is whatever variable holds the logged-in staff's ID — verify by grepping for it.)

- [ ] **Step 3: Render pay section in the portal**

After `renderPortalGigs(...)` is called, insert a pay summary section. Find where `portal-gigs` innerHTML is set or appended, and add:

```javascript
    // Pay rate banner
    const portalGigsEl = document.getElementById('portal-gigs');
    const payBanner = (myStaffRecord && (myStaffRecord.flat_rate > 0 || myStaffRecord.hourly_rate > 0))
      ? `<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:12px 16px;margin-bottom:16px">
           <span style="font-weight:700;color:#166534">💰 Your Pay Rate: </span>
           <span style="color:#166534">${myStaffRecord.pay_type === 'hourly'
             ? `$${Number(myStaffRecord.hourly_rate).toFixed(2)}/hr`
             : `$${Number(myStaffRecord.flat_rate).toFixed(2)} flat per gig`}
           </span>
           ${myStaffRecord.payment_method ? `<span style="color:#6b7280;margin-left:12px">Paid via ${esc(myStaffRecord.payment_method)}${myStaffRecord.payment_handle?' '+esc(myStaffRecord.payment_handle):''}</span>` : ''}
         </div>`
      : '';

    // Payment history
    let payHistoryHtml = '';
    if (myPayments && myPayments.length) {
      const unpaidTotal = myPayments.filter(p => !p.paid).reduce((s, p) => s + Number(p.amount || 0), 0);
      payHistoryHtml = `<div class="card" style="margin-top:16px">
        <div class="card-hdr"><h2>💵 My Payments</h2></div>
        <div style="padding:12px 16px">
          ${unpaidTotal > 0 ? `<div style="margin-bottom:10px;font-size:.85rem;color:#92400e;background:#fef3c7;border-radius:6px;padding:6px 12px;font-weight:600">⏳ $${unpaidTotal.toFixed(2)} pending</div>` : ''}
          ${myPayments.map(p => {
            const booking = (assignData.myGigs || []).find(g => g.booking_id === p.booking_id);
            return `<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid #f3f4f6">
              <div>
                <div style="font-weight:600;font-size:.85rem">${booking ? esc(booking.service_name) : 'Booking #' + p.booking_id}</div>
                ${p.note ? `<div style="font-size:.72rem;color:#6b7280">${esc(p.note)}</div>` : ''}
              </div>
              <div style="text-align:right">
                <div style="font-weight:700;color:#374151">$${Number(p.amount).toFixed(2)}</div>
                <div style="font-size:.72rem">${p.paid
                  ? `<span style="color:#10b981;font-weight:700">✅ Paid</span>`
                  : `<span style="color:#f59e0b;font-weight:700">⏳ Pending</span>`}</div>
              </div>
            </div>`;
          }).join('')}
        </div>
      </div>`;
    }

    // Prepend pay banner before gig cards, append payment history after
    portalGigsEl.innerHTML = payBanner + portalGigsEl.innerHTML + payHistoryHtml;
```

- [ ] **Step 4: Verify manually**

Log in with a staff PIN (e.g. Joe's PIN 9632). Go to My Portal.

Confirm:
- Green pay rate banner shows at the top if pay rate is set
- "My Payments" card appears at the bottom with paid/pending amounts

- [ ] **Step 5: Commit**

```bash
git add admin.html
git commit -m "feat: show pay rate and payment history in staff portal"
```

---

## Final Verification

- [ ] Staff modal: can set flat/hourly rate, payment method, handle — saves correctly
- [ ] Staff card: shows green pay line with rate and method
- [ ] Booking modal: "💰 Record Payment" appears for each assigned staff member
- [ ] Recording a payment shows unpaid badge; "Mark Paid" marks it paid
- [ ] Staffing page: "Unpaid Payments" table lists all outstanding amounts with "Mark Paid"
- [ ] Staff portal: pay rate banner + payment history visible when logged in as staff
- [ ] No JS errors in browser console throughout
