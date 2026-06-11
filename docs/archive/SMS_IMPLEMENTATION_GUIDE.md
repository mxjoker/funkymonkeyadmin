# SMS Notifications System — Implementation Guide

## Overview

Add SMS as an optional communication channel for clients and staff alongside email. Uses Twilio for reliable SMS delivery with full integration into existing automation system.

---

## Features

### For Clients
- Booking confirmations via SMS
- Payment reminders
- Event day reminders
- Cancellation notices
- Preference-based: email, SMS, or both

### For Staff
- Gig availability notifications
- Assignment confirmations
- Event day reminders
- Schedule changes
- Preference-based delivery

---

## Architecture

### New File: _sms.js
Shared SMS helper module (parallel to _email.js):
- `sendSMS(to, message)` — Send via Twilio
- `renderSMS(template, booking, stripeLink)` — Plain text templates
- `logSMS(client, bookingId, ...)` — Track sent messages
- `notify(recipient, subject, html, text, options)` — Unified send (email + SMS)
- `normalizePhone(phone)` — Convert to E.164 format

### Database: sms_log Table
```sql
CREATE TABLE sms_log (
  id SERIAL PRIMARY KEY,
  booking_id INTEGER REFERENCES bookings(id),
  rule_id INTEGER,
  trigger_label VARCHAR(100),
  recipient_phone VARCHAR(50),
  recipient_label VARCHAR(100),
  message_preview TEXT,
  sent_at TIMESTAMPTZ DEFAULT NOW()
)
```

### Environment Variables
```
TWILIO_ACCOUNT_SID=ACxxxxxxxxx
TWILIO_AUTH_TOKEN=your_auth_token
TWILIO_PHONE_NUMBER=+14055551234
```

---

## SMS Templates (Plain Text)

### Booking Confirmed
```
Hi {{client_first_name}}! Your Funky Monkey event is CONFIRMED! 🎊

Service: {{service_name}}
Date: {{event_date}} at {{event_time}}
Location: {{event_zip}}

Deposit: ${{deposit_amount}}
Total: ${{total_price}}

Pay deposit: [stripe_link]

Questions? Reply to this text or call (405) 431-6625.

— Funky Monkey Events
```

### Payment Reminder
```
Hi {{client_first_name}}, friendly reminder! 

Your deposit of ${{deposit_amount}} is due to secure your {{event_date}} event.

Pay now: [stripe_link]

Thanks!
— Funky Monkey Events
(405) 431-6625
```

### Event Day Reminder (24hrs before)
```
Exciting! Your Funky Monkey event is TOMORROW! 🎉

{{service_name}}
{{event_date}} at {{event_time}}
Location: {{event_location}}

We'll see you soon!

— Funky Monkey Events
```

### Staff Gig Available
```
Hey {{staff_name}}! New gig available:

{{service_name}}
{{event_date}} at {{event_time}}
Location: {{event_zip}}
Pays: ${{staff_payment}}

Interested? Check the staff portal:
https://funkymonkeyadmin.netlify.app/staff

— Funky Monkey
```

### Staff Assignment Confirmed
```
You're confirmed for this gig! 🎉

{{service_name}}
{{event_date}} at {{event_time}}
Location: {{event_location}}

Check details in staff portal.

Thanks {{staff_name}}!
— Funky Monkey
```

---

## Integration Points

### 1. Staff Assignments
**File:** `staff-assignments.js`

Add SMS notifications when:
- Gig becomes available (all matching staff)
- Staff member is assigned
- Schedule changes

```javascript
const { notify } = require('./_sms');

// When notifying staff about available gig
const staff = await getMatchingStaff(booking);
for (const member of staff) {
  await notify(
    {
      email: member.email,
      phone: member.phone,
      comms_preference: member.comms_preference,
      label: 'staff'
    },
    'New Gig Available — ' + booking.service_name,
    emailHTML,
    smsText,
    { client, bookingId: booking.id, triggerLabel: 'gig_available' }
  );
}
```

### 2. Booking Confirmations
**File:** `booking.js` or via automation rules

```javascript
const { notify } = require('./_sms');
const { renderSMS } = require('./_sms');

const smsText = renderSMS(SMS_TEMPLATE, booking, stripeLink);
await notify(
  {
    email: booking.client_email,
    phone: booking.client_phone,
    comms_preference: 'both', // or from customer record
    label: 'client'
  },
  'Booking Confirmed',
  emailHTML,
  smsText,
  { client, bookingId: booking.id, triggerLabel: 'confirmed' }
);
```

### 3. Automation Rules
**File:** `automations.js`

Add SMS template field to automation_rules table:
```sql
ALTER TABLE automation_rules 
ADD COLUMN body_sms TEXT DEFAULT NULL;
```

Update automation firing to use `notify()`:
```javascript
for (const rule of rules) {
  const html = render(rule.body_html, booking, stripeLink);
  const sms = rule.body_sms 
    ? renderSMS(rule.body_sms, booking, stripeLink)
    : null;
    
  await notify(
    {
      email: booking.client_email,
      phone: booking.client_phone,
      comms_preference: getClientPreference(booking),
      label: 'client'
    },
    rule.subject,
    wrap(html),
    sms,
    { client, bookingId: booking.id, ruleId: rule.id, triggerLabel: rule.trigger_status }
  );
}
```

---

## UI Updates

### Admin Dashboard — SMS Log
Add SMS tab alongside Email log in booking modal:

```html
<div style="margin-top:18px;border-top:1px solid #e5e7eb;padding-top:18px">
  <div style="display:flex;gap:12px;margin-bottom:10px">
    <button class="tab-btn active" onclick="showCommLog('email', '${b.id}')">📧 Emails</button>
    <button class="tab-btn" onclick="showCommLog('sms', '${b.id}')">💬 SMS</button>
  </div>
  <div id="email-log-${b.id}">Loading...</div>
  <div id="sms-log-${b.id}" style="display:none">Loading...</div>
</div>
```

Function to load SMS log:
```javascript
async function loadSMSLog(bookingId, container) {
  const res = await fetch(`/api/sms-log?booking_id=${bookingId}`);
  const { messages } = await res.json();
  
  container.innerHTML = messages.map(m => `
    <div style="padding:6px 0;border-bottom:1px solid #f3f4f6;font-size:.78rem">
      <div style="display:flex;justify-content:space-between;margin-bottom:2px">
        <span style="font-weight:600">${esc(m.recipient_phone)}</span>
        <span style="color:#9ca3af">${formatDate(m.sent_at)}</span>
      </div>
      <div style="color:#6b7280">${esc(m.message_preview)}</div>
    </div>
  `).join('');
}
```

### Staff Portal — Communication Preference
Already exists! `comms_preference` field in staff preferences:
- Email
- SMS (coming soon) ← **Remove "coming soon"**
- Phone Call

### Booking Form — Client Preference
Add optional field:
```html
<label>
  <input type="checkbox" name="sms_ok" value="1">
  Send SMS updates (faster notifications)
</label>
```

Store as:
- `comms_preference: 'email'` (default)
- `comms_preference: 'sms'` (if checkbox checked)
- `comms_preference: 'both'` (future)

---

## Testing Workflow

### 1. Setup Twilio
1. Sign up at twilio.com
2. Get phone number ($1/month)
3. Copy Account SID + Auth Token
4. Add to Netlify environment variables

### 2. Test SMS Sending
```javascript
const { sendSMS } = require('./_sms');

// Test in Netlify function
await sendSMS('+14055551234', 'Test message from Funky Monkey!');
```

### 3. Test Automation
1. Create test booking
2. Set client phone number
3. Change status to confirmed
4. Check sms_log table for record
5. Verify SMS received

### 4. Test Staff Notifications
1. Update staff record with phone + preference='sms'
2. Create new booking matching their skills
3. Trigger "Notify Matching Staff"
4. Verify SMS sent

---

## Cost Estimates

**Twilio Pricing (US):**
- Phone number: $1.00/month
- Outbound SMS: $0.0079/message
- Inbound SMS: $0.0079/message

**Monthly Estimate (50 bookings):**
- Phone number: $1.00
- Booking confirmations: 50 × $0.0079 = $0.40
- Reminders: 50 × $0.0079 = $0.40
- Staff notifications: 100 × $0.0079 = $0.79
- **Total: ~$2.59/month**

Extremely affordable for the value!

---

## Migration Plan

### Phase 1: Infrastructure (Complete)
- ✅ Create _sms.js module
- ✅ Add sms_log table
- ✅ Create SMS templates

### Phase 2: Integration (Next Steps)
- [ ] Add Twilio credentials to Netlify
- [ ] Update staff-assignments.js to use notify()
- [ ] Add body_sms to automation_rules
- [ ] Update automation firing logic

### Phase 3: UI (Final Polish)
- [ ] Add SMS log tab in admin
- [ ] Remove "coming soon" from staff preferences
- [ ] Add client SMS opt-in to booking form
- [ ] Test end-to-end workflows

### Phase 4: Production
- [ ] Deploy to Netlify
- [ ] Send test messages
- [ ] Monitor sms_log
- [ ] Gather feedback

---

## Security Considerations

### Phone Number Privacy
- Never expose full phone numbers in logs
- Display as: `+1405***1234` in UI
- Store full numbers in database only

### Rate Limiting
- Twilio has built-in abuse prevention
- Add optional cooldown: max 1 SMS per booking per 30min
- Track via sms_log timestamps

### Opt-Out Compliance
- Add to all messages: "Reply STOP to opt out"
- Handle STOP replies (Twilio webhook)
- Update comms_preference to 'email' when opted out

### TCPA Compliance
- Only send to numbers with consent
- Include business identification
- Provide clear opt-out
- Avoid messages before 8am/after 9pm local time

---

## API Endpoint (Optional)

Create `/api/sms-log` for retrieving SMS history:

```javascript
// netlify/functions/sms-log.js
exports.handler = async (event) => {
  const bookingId = event.queryStringParameters?.booking_id;
  
  const { rows } = await client.query(
    'SELECT * FROM sms_log WHERE booking_id=$1 ORDER BY sent_at DESC',
    [bookingId]
  );
  
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: rows })
  };
};
```

---

## Future Enhancements

### Two-Way SMS
- Receive replies via Twilio webhook
- Auto-respond to common questions
- Forward to Joe's phone for manual response

### SMS Scheduling
- Queue messages for optimal delivery times
- Respect time zones
- Batch send for efficiency

### Rich Messaging (MMS)
- Send event flyers/images
- Cost: $0.0200/message (vs $0.0079 for SMS)

### Analytics
- Delivery rates
- Response rates
- Preference trends (email vs SMS)
- Cost tracking

---

## Summary

SMS notifications provide:
- **Faster delivery** (seconds vs minutes)
- **Higher open rates** (98% vs 20%)
- **Instant engagement** (clients can reply)
- **Staff convenience** (mobile-first)
- **Low cost** (~$3/month for 50 bookings)

The system integrates seamlessly with existing email infrastructure and requires minimal code changes. Joe can start with staff-only SMS (zero cost if just testing), then expand to clients once proven.

**Next Step:** Add Twilio credentials and test!
