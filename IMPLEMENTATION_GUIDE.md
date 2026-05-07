# IMPLEMENTATION GUIDE: Staff Assignment UI

## Quick Summary

We're upgrading the staff assignment UI to be **slot-based** instead of list-based. This means:
- Show required slots visually (e.g., "2 Balloon Sculptors needed")
- Display which slots are filled vs unfilled (green vs yellow cards)
- Show matching staff members per slot with one-click assign
- Keep existing functionality as fallback

## Implementation Steps

Given the size of admin.html (3426 lines), I recommend implementing this in a new test session to avoid errors. Here's the step-by-step plan:

### Step 1: Back up current admin.html
```bash
cd ~/Downloads/funky-monkey-email
cp admin.html admin.html.backup
```

### Step 2: Request the full enhanced admin.html file

Since the changes are substantial and interconnected, ask me to:

"Create the complete enhanced admin.html file with the slot-based staff assignment UI integrated"

I'll generate the full file with all changes properly integrated. This is safer than multiple find-and-replace operations on a 3400+ line file.

### Step 3: Compare and test

After generating the new file:
1. Compare key sections with a diff tool if desired
2. Replace `admin.html` with the new version
3. Test locally with `npx netlify dev`
4. Verify the staff assignment section works correctly

## Detailed Change Summary

### Changes Made:

**1. New Helper Functions (add near line 1400)**
```javascript
function toggleManualAssign(bookingId) {
  const el = document.getElementById('manual-assign-' + bookingId);
  if (el) {
    el.style.display = el.style.display === 'none' ? 'block' : 'none';
  }
}

async function quickAssignStaff(staffId, tag, bookingId) {
  try {
    const res = await fetch('/api/staff-assignments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        action: 'assign', 
        booking_id: parseInt(bookingId), 
        staff_id: parseInt(staffId), 
        tag_filled: tag 
      })
    });
    if (!res.ok) { 
      const e = await res.json(); 
      throw new Error(e.error || 'Failed'); 
    }
    await loadStaffAssignments(bookingId);
    flash('assign-flash-' + bookingId);
  } catch(e) { 
    alert('Error assigning staff: ' + e.message); 
  }
}

function renderAssignmentCard(a, payByStaff, bookingId, slotTag = null) {
  const name = esc(a.preferred_name || a.staff_name || '—');
  const color = a.color || '#7c3aed';
  const statusColors = { assigned:'#10b981', interested:'#3b82f6', backup:'#f59e0b', unassigned:'#9ca3af' };
  const sc = statusColors[a.status] || '#9ca3af';
  
  // Checklist progress badge
  const clStatus = a.checklist_status || 'upcoming';
  const clLabels = { upcoming:'📅 Upcoming', on_my_way:'🚗 On My Way', arrived:'📍 Arrived', completed:'✅ Done' };
  const clBadge = a.status === 'assigned'
    ? `<span style="font-size:.68rem;color:#6b7280;background:#f3f4f6;border-radius:10px;padding:1px 7px">${clLabels[clStatus]||clStatus}</span>`
    : '';
  
  // Survey data
  let surveyHtml = '';
  if (a.survey_submitted_at) {
    const submittedDate = new Date(a.survey_submitted_at).toLocaleDateString('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
    const stars = a.event_rating ? '⭐'.repeat(a.event_rating) : '—';
    const balance = a.balance_collected === true
      ? '✅ Collected — $' + Number(a.balance_amount||0).toFixed(2)
      : a.balance_collected === false ? '❌ Not collected' : '—';
    surveyHtml = `
      <div style="margin-top:8px;padding:10px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;font-size:.78rem">
        <div style="font-weight:700;color:#166534;margin-bottom:6px">📋 Post-Gig Report <span style="font-weight:400;color:#6b7280">${submittedDate}</span></div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;color:#374151">
          <div><span style="color:#6b7280">Rating:</span> ${stars}</div>
          <div><span style="color:#6b7280">Guests:</span> ${a.guest_count_actual ?? '—'}</div>
          <div style="grid-column:1/-1"><span style="color:#6b7280">Balance:</span> ${balance}</div>
          ${a.gas_level ? `<div><span style="color:#6b7280">Gas:</span> ${esc(a.gas_level)}</div>` : ''}
          ${a.foam_fluid_needed != null ? `<div><span style="color:#6b7280">Foam fluid:</span> ${a.foam_fluid_needed ? '⚠️ Needed' : '✅ OK'}</div>` : ''}
          ${a.empty_jugs_refilled != null ? `<div><span style="color:#6b7280">Jugs refilled:</span> ${a.empty_jugs_refilled ? '✅ Yes' : '❌ No'}</div>` : ''}
          ${a.survey_notes ? `<div style="grid-column:1/-1"><span style="color:#6b7280">Notes:</span> ${esc(a.survey_notes)}</div>` : ''}
          ${a.survey_issues ? `<div style="grid-column:1/-1"><span style="color:#dc2626">Issues:</span> ${esc(a.survey_issues)}</div>` : ''}
        </div>
      </div>`;
  } else if (a.status === 'assigned' && clStatus === 'completed') {
    surveyHtml = `<div style="margin-top:6px;font-size:.75rem;color:#f59e0b;font-style:italic">⏳ Survey not yet submitted</div>`;
  }
  
  // Pay info
  let payHtml = '';
  if (a.status === 'assigned') {
    const staffRecord = (allStaff || []).find(s => s.id === a.staff_id);
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
  
  return `
    <div style="padding:8px 10px;background:${a.status==='assigned'?'#fff':'#f9fafb'};border:1px solid ${a.status==='assigned'?'#10b981':'#e5e7eb'};border-radius:8px">
      <div style="display:flex;align-items:center;gap:10px">
        <span style="width:10px;height:10px;border-radius:50%;background:${color};flex-shrink:0"></span>
        <span style="font-weight:600;flex:1">${name}</span>
        ${slotTag ? `<span style="font-size:.75rem;color:#6b7280">${esc(slotTag)}</span>` : ''}
        ${clBadge}
        <span style="font-size:.72rem;font-weight:700;color:${sc};text-transform:uppercase">${a.status}</span>
        ${a.status === 'assigned'
          ? `<button class="btn btn-outline btn-sm" style="padding:2px 8px;font-size:.75rem" onclick="unassignStaff('${bookingId}',${a.staff_id},'${esc(a.tag_filled)}')">Remove</button>`
          : `<button class="btn btn-outline btn-sm" style="padding:2px 8px;font-size:.75rem" onclick="promoteToAssigned('${bookingId}',${a.staff_id},'${esc(a.tag_filled)}')">Assign</button>`
        }
      </div>
      ${surveyHtml}
      ${payHtml}
    </div>`;
}
```

**2. Replace `loadStaffAssignments` function (lines 1207-1357)**

The new version is much longer (~300 lines) because it:
- Fetches booking data to get service name
- Groups assignments by slot/tag
- Renders slot-based cards with visual indicators
- Shows matching staff per slot
- Includes one-click assign buttons
- Falls back gracefully when no slots configured

Full code is in the `/mnt/user-data/outputs/STAFF_ASSIGNMENT_UI_UPGRADE.md` file.

**3. Update booking modal HTML (around line 1125)**

Changes the staff assignment section to:
- Add "Manual Assign" toggle button
- Hide manual dropdown by default (in collapsible section)
- Keep "Notify Matching Staff" button visible

## Alternative: Focused Implementation

If you prefer to do this incrementally, we can:

1. **Phase 1:** Add the helper functions only
2. **Phase 2:** Test with a simplified version of `loadStaffAssignments`
3. **Phase 3:** Add the full slot-based UI
4. **Phase 4:** Update the modal HTML

Let me know which approach you prefer!

---

**My Recommendation:** Let me generate the complete updated admin.html file for you. It's safer than multiple edits on such a large file, and I can ensure all the pieces work together properly.

Just say: **"Generate the complete enhanced admin.html file"** and I'll create it.
