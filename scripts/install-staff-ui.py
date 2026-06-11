#!/usr/bin/env python3
"""
Staff Assignment UI Enhancement Installer
Surgically replaces loadStaffAssignments function in admin.html
"""
import re
import shutil
from datetime import datetime
from pathlib import Path

# Backup filename
backup_name = f"admin.html.backup-{datetime.now().strftime('%Y%m%d-%H%M%S')}"

print("🐒 Funky Monkey Admin - Staff Assignment UI Enhancement")
print("=" * 60)

# Read the current admin.html
print("📖 Reading admin.html...")
with open('admin.html', 'r', encoding='utf-8') as f:
    content = f.read()

# Create backup
print(f"💾 Creating backup: {backup_name}")
shutil.copy2('admin.html', backup_name)

# The NEW enhanced function code (complete replacement)
NEW_FUNCTION = r'''async function loadStaffAssignments(bookingId) {
  const el = document.getElementById('staff-assign-body-' + bookingId);
  if (!el) return;
  
  try {
    const [assignRes, payRes, bookingRes] = await Promise.all([
      fetch('/api/staff-assignments?booking_id=' + bookingId),
      fetch('/api/staff-payments?booking_id=' + bookingId),
      fetch('/api/bookings')
    ]);
    
    const { assignments, slots } = await assignRes.json();
    const { payments } = await payRes.json();
    const bookings = await bookingRes.json();
    const booking = bookings.find(b => b.id === parseInt(bookingId));
    
    // Index payments by staff_id
    const payByStaff = {};
    (payments || []).forEach(p => { payByStaff[p.staff_id] = p; });
    
    // Index assignments by staff_id AND tag
    const assignmentsByStaffTag = {};
    (assignments || []).forEach(a => {
      const key = `${a.staff_id}-${a.tag_filled}`;
      assignmentsByStaffTag[key] = a;
    });
    
    // Summary bar
    const summaryEl = document.getElementById('staff-summary-' + bookingId);
    if (summaryEl) {
      const required = (slots || []).filter(s => s.exclusive).reduce((n, s) => n + (s.slot_count || 1), 0);
      const assigned = (assignments || []).filter(a => a.status === 'assigned').length;
      const awaiting = (assignments || []).filter(a => ['interested','backup'].includes(a.status)).length;
      const needed   = Math.max(0, required - assigned);
      
      if (required > 0) {
        summaryEl.innerHTML = `
          <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px">
            <span style="background:${needed > 0 ? '#fef3c7' : '#f0fdf4'};color:${needed > 0 ? '#92400e' : '#166534'};border-radius:6px;padding:3px 10px;font-size:.78rem;font-weight:700">
              ${needed > 0 ? `⚠️ ${needed} Still Needed` : '✅ Fully Staffed'}
            </span>
            <span style="background:#eff6ff;color:#1e40af;border-radius:6px;padding:3px 10px;font-size:.78rem;font-weight:700">${awaiting} Interested</span>
            <span style="background:#f0fdf4;color:#166534;border-radius:6px;padding:3px 10px;font-size:.78rem;font-weight:700">${assigned} / ${required} Assigned</span>
          </div>`;
      } else {
        summaryEl.innerHTML = '<div style="font-size:.82rem;color:#6b7280;font-style:italic;margin-bottom:10px">⚙️ No staff requirements set for this service. Use Catalogue to configure.</div>';
      }
    }
    
    // NEW: Slot-based UI
    if (!slots || slots.length === 0) {
      el.innerHTML = `
        <div style="background:#fef3c7;border:1px solid #fbbf24;border-radius:8px;padding:12px;margin-bottom:12px">
          <div style="font-weight:600;color:#92400e;margin-bottom:4px">⚙️ No Staff Requirements Configured</div>
          <div style="font-size:.82rem;color:#78350f">
            This service doesn't have staff requirements set up yet.
            Go to <strong>Catalogue</strong> → find "${esc(booking?.service_name || 'this service')}" → add staff roles.
          </div>
        </div>`;
      
      // Still show any manually added assignments
      if (assignments && assignments.length > 0) {
        el.innerHTML += '<div style="font-size:.82rem;font-weight:700;color:#6b7280;margin:12px 0 8px">Manual Assignments:</div>';
        el.innerHTML += assignments.map(a => renderAssignmentCard(a, payByStaff, bookingId)).join('');
      }
      return;
    }
    
    // Group assignments by tag
    const assignmentsByTag = {};
    (assignments || []).forEach(a => {
      if (!assignmentsByTag[a.tag_filled]) assignmentsByTag[a.tag_filled] = [];
      assignmentsByTag[a.tag_filled].push(a);
    });
    
    // Render each slot
    let slotsHtml = '';
    slots.forEach(slot => {
      const slotAssignments = assignmentsByTag[slot.tag_required] || [];
      const slotCount = slot.slot_count || 1;
      const filledCount = slotAssignments.filter(a => a.status === 'assigned').length;
      const needsMore = filledCount < slotCount;
      
      // Find matching staff
      const matchingStaff = allStaff.filter(s => {
        if (!s.active) return false;
        const skills = Array.isArray(s.skills) ? s.skills : JSON.parse(s.skills || '[]');
        return skills.some(skill => skill.name === slot.tag_required);
      });
      
      slotsHtml += `
        <div style="background:${needsMore ? '#fef3c7' : '#f0fdf4'};border:2px solid ${needsMore ? '#fbbf24' : '#bbf7d0'};border-radius:10px;padding:12px;margin-bottom:12px">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
            <div style="display:flex;align-items:center;gap:8px">
              <span style="font-weight:700;font-size:.92rem;color:#1e1b4b">${esc(slot.tag_required)}</span>
              <span style="background:${needsMore?'#fff':'#dcfce7'};color:${needsMore?'#92400e':'#166534'};border-radius:12px;padding:2px 8px;font-size:.7rem;font-weight:700">
                ${filledCount} / ${slotCount} filled
              </span>
            </div>
            ${needsMore && matchingStaff.length > 0 ? `
              <button class="btn btn-primary btn-sm" onclick="showSlotAssignDropdown('${bookingId}','${slot.tag_required}',this)" style="padding:3px 10px;font-size:.75rem">
                + Assign ${slot.tag_required}
              </button>
            ` : ''}
          </div>
          
          <!-- Assigned staff for this slot -->
          ${slotAssignments.length > 0 ? `
            <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:8px">
              ${slotAssignments.map(a => renderAssignmentCard(a, payByStaff, bookingId, slot.tag_required)).join('')}
            </div>
          ` : ''}
          
          <!-- Matching available staff (show if slot needs more) -->
          ${needsMore && matchingStaff.length > 0 ? `
            <details style="margin-top:8px">
              <summary style="cursor:pointer;font-size:.75rem;color:#6b7280;font-weight:600">
                ${matchingStaff.length} staff member${matchingStaff.length > 1 ? 's' : ''} available with this skill
              </summary>
              <div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:4px">
                ${matchingStaff.map(s => {
                  const key = `${s.id}-${slot.tag_required}`;
                  const existing = assignmentsByStaffTag[key];
                  if (existing && existing.status === 'assigned') return ''; // Already assigned
                  
                  return `<button onclick="quickAssignStaff(${s.id},'${slot.tag_required}','${bookingId}')"
                    style="background:#7c3aed;color:#fff;border:none;border-radius:6px;padding:4px 10px;font-size:.75rem;font-weight:600;cursor:pointer;display:flex;align-items:center;gap:4px">
                    <span style="width:8px;height:8px;border-radius:50%;background:${s.color||'#fff'}"></span>
                    ${esc(s.preferred_name || s.name)}
                  </button>`;
                }).join('')}
              </div>
            </details>
          ` : needsMore ? `
            <div style="font-size:.75rem;color:#92400e;font-style:italic;margin-top:6px">
              ⚠️ No available staff have "${slot.tag_required}" skill
            </div>
          ` : ''}
        </div>`;
    });
    
    el.innerHTML = slotsHtml;
    
    // Show interested/backup staff who don't match any slot
    const allSlotTags = slots.map(s => s.tag_required);
    const unmatched = (assignments || []).filter(a => !allSlotTags.includes(a.tag_filled));
    if (unmatched.length > 0) {
      el.innerHTML += `
        <div style="border-top:1px solid #e5e7eb;margin-top:12px;padding-top:12px">
          <div style="font-size:.78rem;font-weight:700;color:#6b7280;margin-bottom:8px">Other Responses:</div>
          ${unmatched.map(a => renderAssignmentCard(a, payByStaff, bookingId)).join('')}
        </div>`;
    }
    
  } catch(e) {
    el.innerHTML = '<span style="color:#dc2626">Failed to load assignments.</span>';
    console.error('loadStaffAssignments error:', e);
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
          : `<button class="btn btn-primary btn-sm" style="padding:2px 8px;font-size:.75rem" onclick="promoteToAssigned('${bookingId}',${a.staff_id},'${esc(a.tag_filled)}')">Assign</button>`
        }
      </div>
      ${surveyHtml}
      ${payHtml}
    </div>`;
}

// NEW: Quick assign function
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
}'''

# Find the old function using regex (match from start of function to next function)
pattern = r'async function loadStaffAssignments\(bookingId\) \{.*?\n\}\n\nasync function assignStaff'

# Replace with new function
new_content = re.sub(pattern, NEW_FUNCTION + '\n\nasync function assignStaff', content, flags=re.DOTALL)

# Verify the replacement worked
if 'quickAssignStaff' in new_content and 'renderAssignmentCard' in new_content:
    print("✅ Function replacement successful!")
    print("✅ New functions detected: quickAssignStaff(), renderAssignmentCard()")
    
    # Write the enhanced file
    print("💾 Writing enhanced admin.html...")
    with open('admin.html', 'w', encoding='utf-8') as f:
        f.write(new_content)
    
    print("")
    print("=" * 60)
    print("✅ INSTALLATION COMPLETE!")
    print("")
    print(f"📦 Backup saved as: {backup_name}")
    print("🚀 Next step: npx netlify dev")
    print("")
    print("Test by opening any booking with staff requirements.")
    print("=" * 60)
else:
    print("❌ Replacement failed - restoring backup...")
    shutil.copy2(backup_name, 'admin.html')
    print("⚠️  Original file restored. Please report this error.")
