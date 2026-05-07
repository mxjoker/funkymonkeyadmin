# SMS Integration Example — staff-assignments.js

This shows how to add SMS notifications to the staff assignment system.

## Before (Email Only)

```javascript
// netlify/functions/staff-assignments.js (existing code)

async function notifyMatchingStaff(client, booking) {
  const { sendEmail } = require('./_email');
  
  // Find matching staff
  const matchingStaff = await getMatchingStaff(client, booking);
  
  for (const staff of matchingStaff) {
    const subject = `New Gig Available — ${booking.service_name}`;
    const html = `
      <h2>New Gig Available!</h2>
      <p>Hi ${staff.preferred_name || staff.name}!</p>
      <p>A gig matching your skills just became available:</p>
      <ul>
        <li><strong>Service:</strong> ${booking.service_name}</li>
        <li><strong>Date:</strong> ${booking.event_date}</li>
        <li><strong>Time:</strong> ${booking.event_time}</li>
        <li><strong>Location:</strong> ${booking.event_zip}</li>
      </ul>
      <p>Check the staff portal to express interest!</p>
    `;
    
    await sendEmail(staff.email, subject, html);
  }
}
```

---

## After (Email + SMS)

```javascript
// netlify/functions/staff-assignments.js (updated)

async function notifyMatchingStaff(client, booking) {
  const { notify, renderSMS } = require('./_sms');
  const { wrap } = require('./_email');
  
  // SMS template (plain text)
  const SMS_TEMPLATE = `Hey {{staff_name}}! New gig available:

{{service_name}}
{{event_date}} at {{event_time}}
Location: {{event_zip}}

Check staff portal to express interest:
https://funkymonkeyadmin.netlify.app/staff

— Funky Monkey Events`;

  // Find matching staff
  const matchingStaff = await getMatchingStaff(client, booking);
  
  for (const staff of matchingStaff) {
    const subject = `New Gig Available — ${booking.service_name}`;
    
    // HTML email body
    const emailHTML = `
      <h2>New Gig Available!</h2>
      <p>Hi ${staff.preferred_name || staff.name}!</p>
      <p>A gig matching your skills just became available:</p>
      <ul>
        <li><strong>Service:</strong> ${booking.service_name}</li>
        <li><strong>Date:</strong> ${booking.event_date}</li>
        <li><strong>Time:</strong> ${booking.event_time}</li>
        <li><strong>Location:</strong> ${booking.event_zip}</li>
      </ul>
      <p><a href="https://funkymonkeyadmin.netlify.app/staff" 
           style="background:#7c3aed;color:#fff;padding:12px 24px;text-decoration:none;border-radius:8px;font-weight:700">
         Check Staff Portal
      </a></p>
    `;
    
    // Plain text SMS body
    const smsText = renderSMS(SMS_TEMPLATE, {
      ...booking,
      staff_name: staff.preferred_name || staff.name
    });
    
    // Send via preferred method (email, SMS, or both)
    await notify(
      {
        email: staff.email,
        phone: staff.phone,
        comms_preference: staff.comms_preference || 'email',
        label: 'staff'
      },
      subject,
      wrap(emailHTML),
      smsText,
      {
        client,
        bookingId: booking.id,
        triggerLabel: 'gig_available'
      }
    );
    
    console.log(`Notified ${staff.name} via ${staff.comms_preference || 'email'}`);
  }
}
```

---

## What Changed

### 1. Import SMS Functions
```javascript
const { notify, renderSMS } = require('./_sms');
```

### 2. Define SMS Template
Plain text version of the email, using template variables:
```javascript
const SMS_TEMPLATE = `Hey {{staff_name}}! New gig available:

{{service_name}}
{{event_date}} at {{event_time}}
...`;
```

### 3. Render SMS Text
```javascript
const smsText = renderSMS(SMS_TEMPLATE, {
  ...booking,
  staff_name: staff.preferred_name || staff.name
});
```

### 4. Use notify() Instead of sendEmail()
The `notify()` function handles routing based on `comms_preference`:
- `'email'` → sends email only
- `'sms'` → sends SMS only  
- `'both'` → sends both
- `undefined` → defaults to email

```javascript
await notify(
  {
    email: staff.email,
    phone: staff.phone,
    comms_preference: staff.comms_preference || 'email',
    label: 'staff'
  },
  subject,
  wrap(emailHTML),
  smsText,
  { client, bookingId: booking.id, triggerLabel: 'gig_available' }
);
```

---

## Benefits

1. **Backwards Compatible** — Existing email-only users see no change
2. **Preference-Based** — Respects staff communication preferences
3. **Dual Logging** — Both email_log and sms_log are updated
4. **Clean Code** — One function call handles both channels
5. **Easy Testing** — Set one staff to SMS to test without affecting others

---

## Testing the Integration

### Step 1: Update Staff Preference
```sql
UPDATE staff 
SET comms_preference = 'sms', phone = '+14055551234'
WHERE id = 1;
```

### Step 2: Create Test Booking
Create a booking that matches the staff's skills.

### Step 3: Trigger Notification
```javascript
await notifyMatchingStaff(client, booking);
```

### Step 4: Verify
- Check console logs: "Notified Troy via sms"
- Check sms_log table for record
- Check phone for actual SMS

### Step 5: Check Both Channels
```sql
UPDATE staff 
SET comms_preference = 'both'
WHERE id = 1;
```

Now the staff member receives BOTH email and SMS!

---

## Full Example — Assignment Confirmation

When a staff member is assigned to a gig:

```javascript
async function confirmAssignment(client, assignmentId) {
  const { notify, renderSMS } = require('./_sms');
  const { wrap } = require('./_email');
  
  // Get assignment details
  const assignment = await getAssignment(client, assignmentId);
  const staff = await getStaff(client, assignment.staff_id);
  const booking = await getBooking(client, assignment.booking_id);
  
  const subject = `You're Confirmed! — ${booking.service_name}`;
  
  // Email version
  const emailHTML = `
    <h2>🎉 You're Confirmed!</h2>
    <p>Hi ${staff.preferred_name}!</p>
    <p>You've been assigned to this gig:</p>
    <ul>
      <li><strong>Service:</strong> ${booking.service_name}</li>
      <li><strong>Role:</strong> ${assignment.tag_filled}</li>
      <li><strong>Date:</strong> ${booking.event_date} at ${booking.event_time}</li>
      <li><strong>Location:</strong> ${booking.event_location}</li>
    </ul>
    <p>Check the staff portal for full details and checklist.</p>
  `;
  
  // SMS version
  const smsText = `You're confirmed for this gig! 🎉

${booking.service_name}
${booking.event_date} at ${booking.event_time}
Location: ${booking.event_location}

Role: ${assignment.tag_filled}

Check details in staff portal.

Thanks ${staff.preferred_name}!
— Funky Monkey`;
  
  // Send notification
  await notify(
    {
      email: staff.email,
      phone: staff.phone,
      comms_preference: staff.comms_preference || 'email',
      label: 'staff'
    },
    subject,
    wrap(emailHTML),
    smsText,
    {
      client,
      bookingId: booking.id,
      triggerLabel: 'assignment_confirmed'
    }
  );
  
  // Log the assignment confirmation
  await client.query(
    `UPDATE staff_assignments SET assigned_at = NOW() WHERE id = $1`,
    [assignmentId]
  );
}
```

---

## Migration Checklist

For each notification in the codebase:

- [x] Identify current `sendEmail()` call
- [x] Create SMS template (plain text)
- [x] Replace `sendEmail()` with `notify()`
- [x] Add `comms_preference` to recipient object
- [x] Test with SMS-preference staff member
- [x] Verify both email_log and sms_log
- [x] Deploy

---

## Cost Per Notification

**Email:** Free (Resend has generous free tier)  
**SMS:** $0.0079 per message

**Example:**
- 20 staff members
- 50 bookings/month
- Each booking notifies 5 staff on average
- 50 × 5 = 250 notifications/month
- If all chose SMS: 250 × $0.0079 = **$1.98/month**

**Conclusion:** SMS is extremely affordable even at scale.

---

## Summary

The SMS integration:
1. ✅ Requires minimal code changes
2. ✅ Respects user preferences automatically
3. ✅ Logs all communications for audit trail
4. ✅ Costs pennies per month
5. ✅ Provides instant delivery (vs delayed email)

**Next:** Repeat this pattern for all booking confirmations, reminders, and client communications!
