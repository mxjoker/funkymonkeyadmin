# Dashboard Finish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the dashboard overhaul by adding staff initials badges to Upcoming Gigs rows and upgrading the 4 KPI stat tiles with MTD/YTD revenue and prior-month % change.

**Architecture:** All changes are confined to `admin.html`. No backend changes needed — `calStaffMap` already holds assigned-staff data per booking (loaded at startup), and `allBookings` contains all the data needed for MTD/YTD/prior-month calculations. A new `upcomingGigRow()` function replaces the generic `bookingRow()` call for the Upcoming Gigs table, and `renderDashboard()` is updated to compute the new KPI values.

**Tech Stack:** Vanilla JS, plain HTML, no build step. Test by running `npx netlify dev` and viewing `http://localhost:8888/admin.html`.

---

## Files Modified

- `admin.html` — all changes

---

## Task 1: Staff Initials Badges on Upcoming Gigs

The Upcoming Gigs table currently reuses `bookingRow()`, which shows a Status badge in column 6. Since every upcoming gig is `confirmed`, that column is redundant. Replace it with a Staff column showing colored initials circles from `calStaffMap`.

**Files:**
- Modify: `admin.html` (Upcoming Gigs table header ~line 330, `renderDashboard` ~line 827, add `upcomingGigRow` near `bookingRow` ~line 899)

- [ ] **Step 1: Swap the Upcoming Gigs table header**

Find this block (~line 329):
```html
<table>
  <thead><tr><th>Ref</th><th>Client</th><th>Service</th><th>Event Date</th><th>Total</th><th>Status</th></tr></thead>
  <tbody id="dash-upcoming-tbody"></tbody>
</table>
```

Replace the `<th>Status</th>` with `<th>Staff</th>`:
```html
<table>
  <thead><tr><th>Ref</th><th>Client</th><th>Service</th><th>Event Date</th><th>Total</th><th>Staff</th></tr></thead>
  <tbody id="dash-upcoming-tbody"></tbody>
</table>
```

- [ ] **Step 2: Add `upcomingGigRow()` function**

Add this function immediately after the `bookingRow` function (~line 910):

```javascript
function upcomingGigRow(b) {
  const badges = (calStaffMap[b.id] || []).map(s =>
    `<span title="${esc(s.initials)}" style="display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;background:${s.color};color:#fff;font-size:9px;font-weight:800;border:1.5px solid #fff;margin-right:2px">${esc(s.initials)}</span>`
  ).join('');
  return `<tr style="cursor:pointer" onclick="openBooking('${b.id}')">
    <td><code style="font-size:.75rem;color:#7c3aed">${b.reference||'—'}</code></td>
    <td><div style="font-weight:600">${esc(b.client_name||'')}</div><div class="text-muted">${esc(b.client_email||'')}</div></td>
    <td>${esc(b.service_name||'—')}</td>
    <td>${fmtDate(b.event_date)}</td>
    <td>${Number(b.total_price||0)>0?'$'+Number(b.total_price).toFixed(0):'<span class="text-muted">TBD</span>'}</td>
    <td style="white-space:nowrap">${badges || '<span class="text-muted" style="font-size:.75rem">—</span>'}</td>
  </tr>`;
}
```

- [ ] **Step 3: Wire `upcomingGigRow` into `renderDashboard`**

In `renderDashboard()` (~line 832), find:
```javascript
  document.getElementById('dash-upcoming-tbody').innerHTML = upcoming.length
    ? upcoming.map(b => bookingRow(b)).join('')
    : `<tr><td colspan="6" class="table-empty">No upcoming confirmed gigs</td></tr>`;
```

Replace with:
```javascript
  document.getElementById('dash-upcoming-tbody').innerHTML = upcoming.length
    ? upcoming.map(b => upcomingGigRow(b)).join('')
    : `<tr><td colspan="6" class="table-empty">No upcoming confirmed gigs</td></tr>`;
```

- [ ] **Step 4: Verify manually**

Start dev server: `npx netlify dev`

Open `http://localhost:8888/admin.html`, log in, go to Dashboard.

Check:
- Upcoming Gigs table header shows "Staff" (not "Status")
- Rows with assigned staff show colored initials circles in the Staff column
- Rows with no assigned staff show "—"
- Clicking a row still opens the booking modal

- [ ] **Step 5: Commit**

```bash
git add admin.html
git commit -m "feat: add staff initials badges to upcoming gigs dashboard table"
```

---

## Task 2: KPI Stat Tiles — MTD Revenue, YTD Revenue, % Change, and Avg Price

Upgrade the 4 stat cards from simple all-time counts to more actionable KPIs:

| Card | Primary value | Sub-value |
|------|--------------|-----------|
| Revenue MTD | `$X,XXX` (this calendar month) | YTD: `$XX,XXX` |
| Avg Price / Event | `$XXX` (confirmed + completed, all time) | — |
| Needs Review | count | "Awaiting your response" |
| Confirmed This Month | count (this calendar month) | vs prior month |

The Revenue MTD card also gets a prior-month % change indicator (↑ 12% vs last month, or ↓ 8%).

**Files:**
- Modify: `admin.html` (stat card HTML ~line 293-312, `renderDashboard` ~line 810-818)

- [ ] **Step 1: Update the stat card HTML**

Find the stats row (~line 291-313):
```html
      <div class="stats-row">
        <div class="stat-card accent">
          <div class="s-label">Total Bookings</div>
          <div class="s-val" id="st-total">—</div>
        </div>
        <div class="stat-card amber">
          <div class="s-label">Needs Review</div>
          <div class="s-val" id="st-review">—</div>
          <div class="s-sub">Awaiting your response</div>
        </div>
        <div class="stat-card green">
          <div class="s-label">Confirmed</div>
          <div class="s-val" id="st-confirmed">—</div>
        </div>
        <div class="stat-card blue">
          <div class="s-label">Revenue (Confirmed)</div>
          <div class="s-val" id="st-revenue">—</div>
        </div>
      </div>
```

Replace with:
```html
      <div class="stats-row">
        <div class="stat-card accent">
          <div class="s-label">Revenue This Month</div>
          <div class="s-val" id="st-mtd-rev">—</div>
          <div class="s-sub" id="st-mtd-rev-sub"></div>
        </div>
        <div class="stat-card blue">
          <div class="s-label">Avg Price / Event</div>
          <div class="s-val" id="st-avg">—</div>
          <div class="s-sub">Confirmed &amp; completed</div>
        </div>
        <div class="stat-card amber">
          <div class="s-label">Needs Review</div>
          <div class="s-val" id="st-review">—</div>
          <div class="s-sub">Awaiting your response</div>
        </div>
        <div class="stat-card green">
          <div class="s-label">Confirmed This Month</div>
          <div class="s-val" id="st-confirmed">—</div>
          <div class="s-sub" id="st-confirmed-sub"></div>
        </div>
      </div>
```

- [ ] **Step 2: Update `renderDashboard` KPI calculations**

Find the top of `renderDashboard()` (~line 810):
```javascript
function renderDashboard() {
  document.getElementById('st-total').textContent = allBookings.length;
  document.getElementById('st-review').textContent = allBookings.filter(b => b.status === 'review').length;
  document.getElementById('st-confirmed').textContent = allBookings.filter(b => b.status === 'confirmed').length;
  const rev = allBookings
    .filter(b => ['confirmed','completed'].includes(b.status))
    .reduce((s,b) => s + Number(b.total_price||0), 0);
  document.getElementById('st-revenue').textContent = '$' + rev.toLocaleString('en-US',{maximumFractionDigits:0});
```

Replace those first 9 lines with:
```javascript
function renderDashboard() {
  const now = new Date();
  const thisMonth = now.getMonth();
  const thisYear  = now.getFullYear();
  const lastMonthDate = new Date(thisYear, thisMonth - 1, 1);
  const lastMonth = lastMonthDate.getMonth();
  const lastYear  = lastMonthDate.getFullYear();

  function eventMonth(b) {
    if (!b.event_date) return null;
    const d = new Date(String(b.event_date).split('T')[0] + 'T00:00:00');
    return { m: d.getMonth(), y: d.getFullYear() };
  }

  const confirmed = allBookings.filter(b => ['confirmed','completed'].includes(b.status));

  // Revenue MTD (by event_date in current month)
  const mtdRev = confirmed
    .filter(b => { const em = eventMonth(b); return em && em.m === thisMonth && em.y === thisYear; })
    .reduce((s,b) => s + Number(b.total_price||0), 0);

  // Revenue prior month (for % change)
  const priorRev = confirmed
    .filter(b => { const em = eventMonth(b); return em && em.m === lastMonth && em.y === lastYear; })
    .reduce((s,b) => s + Number(b.total_price||0), 0);

  // YTD revenue
  const ytdRev = confirmed
    .filter(b => { const em = eventMonth(b); return em && em.y === thisYear; })
    .reduce((s,b) => s + Number(b.total_price||0), 0);

  // Avg price
  const avg = confirmed.length ? confirmed.reduce((s,b) => s + Number(b.total_price||0), 0) / confirmed.length : 0;

  // Confirmed this month (by event_date)
  const confirmedThisMonth = confirmed
    .filter(b => { const em = eventMonth(b); return em && em.m === thisMonth && em.y === thisYear; }).length;

  // Confirmed prior month (for comparison)
  const confirmedPriorMonth = confirmed
    .filter(b => { const em = eventMonth(b); return em && em.m === lastMonth && em.y === lastYear; }).length;

  // % change helper
  function pctChange(current, prior) {
    if (prior === 0) return current > 0 ? '↑ new' : '';
    const pct = Math.round((current - prior) / prior * 100);
    return pct >= 0 ? `↑ ${pct}% vs last mo` : `↓ ${Math.abs(pct)}% vs last mo`;
  }

  document.getElementById('st-mtd-rev').textContent = '$' + mtdRev.toLocaleString('en-US',{maximumFractionDigits:0});
  const ytdStr = 'YTD: $' + ytdRev.toLocaleString('en-US',{maximumFractionDigits:0});
  const mRevChange = pctChange(mtdRev, priorRev);
  document.getElementById('st-mtd-rev-sub').textContent = mRevChange ? `${ytdStr} · ${mRevChange}` : ytdStr;

  document.getElementById('st-avg').textContent = avg > 0 ? '$' + avg.toLocaleString('en-US',{maximumFractionDigits:0}) : '—';

  document.getElementById('st-review').textContent = allBookings.filter(b => b.status === 'review').length;

  document.getElementById('st-confirmed').textContent = confirmedThisMonth;
  document.getElementById('st-confirmed-sub').textContent = pctChange(confirmedThisMonth, confirmedPriorMonth);
```

- [ ] **Step 3: Verify manually**

Open `http://localhost:8888/admin.html`, log in, check Dashboard.

Verify:
- "Revenue This Month" card shows MTD revenue (events this calendar month that are confirmed/completed)
- Sub-text shows "YTD: $XX,XXX · ↑ X% vs last mo" (or no % if no prior-month data)
- "Avg Price / Event" shows average of all confirmed+completed bookings
- "Needs Review" is unchanged
- "Confirmed This Month" shows count of confirmed/completed events with event_date in current month
- % change sub-text on Confirmed card is directionally correct

- [ ] **Step 4: Commit**

```bash
git add admin.html
git commit -m "feat: upgrade dashboard KPI tiles — MTD revenue, YTD, avg price, pct change"
```

---

## Verification

End-to-end checklist:

- [ ] Dashboard loads without JS errors (check browser console)
- [ ] Upcoming Gigs: rows with assigned staff show colored circles; rows without show "—"
- [ ] Clicking any Upcoming Gig row opens the booking modal
- [ ] Revenue This Month card shows a dollar value (not "—")
- [ ] Sub-text shows YTD value and % change indicator
- [ ] Avg Price / Event shows a value
- [ ] Confirmed This Month shows count with % change vs prior month
- [ ] Needs Review count matches the action-needed badge count above it
