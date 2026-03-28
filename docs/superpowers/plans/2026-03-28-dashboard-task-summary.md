# Dashboard Task Summary Widget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the standalone staffing warning panel on the admin dashboard with a unified "Action Needed" card that shows three clickable badge counts (Needs Review, No Deposit Link, Unstaffed), expands inline mini-tables on badge click, and lets Joe act on any item via the existing booking modal without leaving the dashboard.

**Architecture:** Pure frontend change to `admin.html` only — no new API endpoints. All badge counts and expanded lists are computed from data already in memory (`allBookings`, `calStaffMap`, `allServiceSlots`). The existing `#staffing-warnings` div is replaced by `#action-needed`. `renderDashboard()` delegates staffing/action logic to a new `renderActionNeeded()` helper. A module-level `activeActionBadge` variable tracks which badge (if any) is expanded.

**Tech Stack:** Vanilla JS, plain HTML, no build step. Part of the Funky Monkey Events admin panel (`admin.html`), served by Netlify.

---

## File Map

| File | Change |
|---|---|
| `admin.html` | Replace `#staffing-warnings` div with `#action-needed`; add `activeActionBadge` state variable; add `renderActionNeeded()` and `toggleActionBadge()` functions; update `renderDashboard()` to call `renderActionNeeded()` instead of inline staffing warning block |

No other files change.

---

## Task 1: Replace `#staffing-warnings` div with `#action-needed` in HTML

**Files:**
- Modify: `admin.html` (dashboard HTML section, around line 313)

This is a straight HTML swap. No JS yet.

- [ ] **Step 1: Find the existing div**

Open `admin.html`. Search for:
```
<div id="staffing-warnings"
```
It appears between the stats grid and the Recent Bookings card (around line 313).

- [ ] **Step 2: Replace it**

Replace:
```html
<div id="staffing-warnings" style="display:none" class="card" style="border-left:4px solid #f59e0b"></div>
```

With:
```html
<div id="action-needed" class="card"></div>
```

- [ ] **Step 3: Verify**

Run `grep -n "staffing-warnings" admin.html` — should return no results.
Run `grep -n "action-needed" admin.html` — should return exactly one result in the dashboard HTML section.

- [ ] **Step 4: Commit**

```bash
git add admin.html
git commit -m "refactor: replace staffing-warnings div with action-needed"
```

---

## Task 2: Add `activeActionBadge` state variable

**Files:**
- Modify: `admin.html` (STATE section, around line 501)

- [ ] **Step 1: Find the STATE block**

Search for `// STATE` — it's around line 496. The block looks like:
```javascript
let allBookings = [];
let allStaff    = [];
let calStaffMap = {};
let allServiceSlots = [];
let currentUser = null;
```

- [ ] **Step 2: Add the variable**

Add one line after `let allServiceSlots = [];`:
```javascript
let activeActionBadge = null; // 'review' | 'deposit' | 'staffing' | null
```

- [ ] **Step 3: Verify**

Run `grep -n "activeActionBadge" admin.html` — should return exactly one result in the STATE block.

- [ ] **Step 4: Commit**

```bash
git add admin.html
git commit -m "feat: add activeActionBadge state variable"
```

---

## Task 3: Add `toggleActionBadge()` and `renderActionNeeded()` functions

**Files:**
- Modify: `admin.html` (just before the `renderDashboard()` function, around line 676)

This is the main task. Add both functions immediately before `function renderDashboard()`.

- [ ] **Step 1: Find the insertion point**

Search for `function renderDashboard()` — it's around line 676. Insert the two new functions immediately before it.

- [ ] **Step 2: Insert `toggleActionBadge`**

```javascript
function toggleActionBadge(type) {
  activeActionBadge = (activeActionBadge === type) ? null : type;
  renderActionNeeded();
}
```

- [ ] **Step 3: Insert `renderActionNeeded`**

Insert immediately after `toggleActionBadge`, still before `renderDashboard`:

```javascript
function renderActionNeeded() {
  const el = document.getElementById('action-needed');
  if (!el) return;

  // ── Compute counts ──────────────────────────────────────────────────────
  const reviewList = allBookings.filter(b => b.status === 'review')
    .sort((a,b) => new Date(a.created_at) - new Date(b.created_at));

  const depositList = allBookings.filter(b => b.status === 'pending' && !b.stripe_payment_link)
    .sort((a,b) => new Date(a.created_at) - new Date(b.created_at));

  const slotsRequired = {};
  allServiceSlots.forEach(s => {
    if (!s.exclusive) return;
    slotsRequired[s.service_id] = (slotsRequired[s.service_id] || 0) + (s.slot_count || 1);
  });
  const now = new Date(); now.setHours(0,0,0,0);
  const cutoff = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
  const staffingList = allBookings.filter(b => {
    if (b.status !== 'confirmed') return false;
    const d = new Date(b.event_date);
    if (d < now || d > cutoff) return false;
    const required = slotsRequired[b.service_id] || 0;
    if (required === 0) return false;
    const assigned = calStaffMap[b.id]?.length || 0;
    return assigned < required;
  }).sort((a,b) => new Date(a.event_date) - new Date(b.event_date));

  const allClear = reviewList.length === 0 && depositList.length === 0 && staffingList.length === 0;

  // ── Badge helper ─────────────────────────────────────────────────────────
  function badge(type, count, label, colorClass) {
    if (count === 0) return '';
    const active = activeActionBadge === type;
    const arrow = active ? '▲' : '→';
    const styles = {
      review:   'background:#fef3c7;border:1px solid #f59e0b;color:#92400e',
      deposit:  'background:#fee2e2;border:1px solid #ef4444;color:#991b1b',
      staffing: 'background:#fef3c7;border:1px solid #f59e0b;color:#92400e',
    };
    const activeStyle = active ? 'box-shadow:0 2px 6px rgba(245,158,11,.3);font-weight:900;' : '';
    return `<div onclick="toggleActionBadge('${type}')" style="cursor:pointer;border-radius:6px;padding:6px 12px;font-size:.75rem;font-weight:700;${styles[type]};${activeStyle}">
      ${count} ${label} ${arrow}
    </div>`;
  }

  // ── Expanded mini-table helper ────────────────────────────────────────────
  function miniTable(list, includeTotal) {
    if (!list.length) return '';
    const rows = list.map(b => {
      const totalCell = includeTotal
        ? `<td style="font-weight:600;color:#374151">$${Number(b.total_price||0).toLocaleString('en-US',{maximumFractionDigits:0})}</td>`
        : '';
      return `<tr style="cursor:pointer" onclick="openBooking('${b.id}')"
                onmouseover="this.style.background='#fffbeb'" onmouseout="this.style.background=''">
        <td><code style="font-size:.7rem;color:#7c3aed;background:#ede9fe;padding:1px 5px;border-radius:3px">${esc(b.reference||'—')}</code></td>
        <td style="font-weight:600;color:#374151">${esc(b.client_name||'—')}</td>
        <td style="color:#6b7280">${esc(b.service_name||'—')}</td>
        <td style="color:#6b7280">${fmtDate(b.event_date)}</td>
        ${totalCell}
      </tr>`;
    }).join('');
    const totalHeader = includeTotal ? '<th>Total</th>' : '';
    return `<table style="width:100%;border-collapse:collapse;font-size:.75rem;margin-top:8px">
      <thead><tr style="border-bottom:1px solid #f3f4f6">
        <th style="text-align:left;padding:4px 6px;color:#9ca3af;font-size:.68rem;font-weight:600">Ref</th>
        <th style="text-align:left;padding:4px 6px;color:#9ca3af;font-size:.68rem;font-weight:600">Client</th>
        <th style="text-align:left;padding:4px 6px;color:#9ca3af;font-size:.68rem;font-weight:600">Service</th>
        <th style="text-align:left;padding:4px 6px;color:#9ca3af;font-size:.68rem;font-weight:600">Date</th>
        ${totalHeader}
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  }

  // ── Expanded section (below badges) ──────────────────────────────────────
  let expandedHTML = '';
  if (activeActionBadge === 'review' && reviewList.length) {
    expandedHTML = `<div style="border-top:2px solid #f59e0b;margin-top:10px;padding-top:10px">
      <div style="font-size:.68rem;font-weight:700;color:#b45309;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">Needs Review — click any row to open</div>
      ${miniTable(reviewList, true)}
    </div>`;
  } else if (activeActionBadge === 'deposit' && depositList.length) {
    expandedHTML = `<div style="border-top:2px solid #ef4444;margin-top:10px;padding-top:10px">
      <div style="font-size:.68rem;font-weight:700;color:#991b1b;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">No Deposit Link — click any row to open</div>
      ${miniTable(depositList, true)}
    </div>`;
  }

  // ── Staffing detail (always visible when items exist) ─────────────────────
  let staffingHTML = '';
  if (staffingList.length) {
    staffingHTML = `<div style="border-top:1px solid #f3f4f6;margin-top:12px;padding-top:10px">
      <div style="font-size:.68rem;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">⚠️ Staffing Detail — ${staffingList.length} event${staffingList.length > 1 ? 's' : ''} within 14 days</div>
      ${miniTable(staffingList, false)}
    </div>`;
  }

  // ── Render ────────────────────────────────────────────────────────────────
  if (allClear) {
    el.innerHTML = `<div style="padding:14px 16px">
      <div style="font-size:.7rem;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px">⚡ Action Needed</div>
      <div style="color:#10b981;font-weight:700;font-size:.88rem;text-align:center;padding:8px 0">✅ All clear — nothing needs attention</div>
    </div>`;
    return;
  }

  el.innerHTML = `<div style="padding:14px 16px">
    <div style="font-size:.7rem;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px">⚡ Action Needed</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      ${badge('review',   reviewList.length,   'Needs Review',    'amber')}
      ${badge('deposit',  depositList.length,  'No Deposit Link', 'red')}
      ${staffingList.length > 0 ? `<div style="border-radius:6px;padding:6px 12px;font-size:.75rem;font-weight:700;background:#fef3c7;border:1px solid #f59e0b;color:#92400e">${staffingList.length} Unstaffed ↓</div>` : ''}
    </div>
    ${expandedHTML}
    ${staffingHTML}
  </div>`;
}
```

- [ ] **Step 4: Verify both functions exist**

Run: `grep -n "function toggleActionBadge\|function renderActionNeeded" admin.html`

Expected: two results, both just before `function renderDashboard`.

- [ ] **Step 5: Commit**

```bash
git add admin.html
git commit -m "feat: add renderActionNeeded and toggleActionBadge functions"
```

---

## Task 4: Update `renderDashboard()` to use `renderActionNeeded()`

**Files:**
- Modify: `admin.html` (`renderDashboard()` function, around line 676)

Replace the entire staffing warning block inside `renderDashboard()` with a single call to `renderActionNeeded()`.

- [ ] **Step 1: Find the staffing warning block in `renderDashboard()`**

Inside `renderDashboard()`, find the block that starts with:
```javascript
  // Staffing warning — confirmed bookings within 14 days where assigned < required
  const slotsRequired = {};
```
and ends with:
```javascript
  } else {
    warnEl.style.display = 'none';
  }
```

- [ ] **Step 2: Replace it**

Delete everything from `// Staffing warning —` through the closing `}` of the else block (the last line of the staffing warning logic). Replace with:

```javascript
  renderActionNeeded();
```

The end of `renderDashboard()` should now be:

```javascript
  const recent = [...allBookings].sort((a,b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 8);
  document.getElementById('dash-tbody').innerHTML = recent.length
    ? recent.map(b => bookingRow(b)).join('')
    : `<tr><td colspan="6" class="table-empty">No bookings yet</td></tr>`;

  renderActionNeeded();
}
```

- [ ] **Step 3: Verify no references to `staffing-warnings` remain**

Run: `grep -n "staffing-warnings\|warnEl\|slotsRequired" admin.html`

Expected: no results (all three are gone from `renderDashboard`).

- [ ] **Step 4: Verify `renderActionNeeded` is called once from `renderDashboard`**

Run: `grep -n "renderActionNeeded" admin.html`

Expected: three results — the function definition, the call inside `toggleActionBadge`, and the call inside `renderDashboard`.

- [ ] **Step 5: Commit**

```bash
git add admin.html
git commit -m "feat: renderDashboard delegates to renderActionNeeded"
```

---

## Task 5: Manual verification

No automated tests exist for this frontend — verify manually via the dev server.

- [ ] **Step 1: Start dev server**

```bash
cd ~/Downloads/funky-monkey-email
npx netlify dev
```

Open http://localhost:8888/admin.html and log in.

- [ ] **Step 2: Verify Action Needed card appears**

The dashboard should show the "Action Needed" card between the stats grid and Recent Bookings. If there are bookings in `review` status, `pending` with no Stripe link, or confirmed events within 14 days with missing staff — badges should appear. If not, the card shows "✅ All clear".

- [ ] **Step 3: Verify badge expand/collapse**

Click a badge with count > 0. A mini-table should expand below the badge row. Click the same badge again — it should collapse. Click a second badge — first collapses, second expands.

- [ ] **Step 4: Verify booking modal opens from expanded row**

With a badge expanded, click any row in the mini-table. The booking modal should open.

- [ ] **Step 5: Verify staffing detail table**

If any confirmed events within 14 days are missing staff, the staffing detail table should always be visible at the bottom of the card (below a divider), regardless of which badge is expanded.

- [ ] **Step 6: Verify all-clear state**

If possible, confirm or complete all review/pending/unstaffed bookings so all counts are 0. The card should show "✅ All clear — nothing needs attention".

- [ ] **Step 7: Final commit and push**

```bash
git push
```
