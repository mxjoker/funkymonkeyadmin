// netlify/functions/_templates.js — every message this system sends, as data.
//
// Until 2026-08-20 each of these was an HTML literal inside the function that
// happened to send it: fourteen of them across nine files. Rewording anything a
// client reads meant a code change and a deploy, and there was no one place to
// look and see what actually goes out. These rows are seeded into
// automation_rules once and then owned by whoever edits them in the Automations
// tab — an edit is a database write.
//
// trigger_event is one of:
//   'manual' — a button on a booking sends it, and nothing else does.
//   'system' — a code path sends it: a Stripe webhook, a refund, a client
//              finishing their details. Not a schedule and not a status change.
// Neither value is queried by any trigger loop (they all name their own
// trigger_event), so seeding a row here can never start an automation.
//
// recipient is 'client', 'admin' (→ NOTIFY_EMAIL) or 'staff' (→ an address the
// caller passes). sendTemplate() routes on it.
//
// {{tokens}} come from _email.js render() / _sms.js renderSms(). Anything not
// on the booking row — an amount a webhook just received, a list of what a
// client changed — is passed by the caller as `extra` and named in the comment
// above each template, because a token nobody supplies renders as a literal.
//
// The HTML is deliberately the same as what these emails have always been. If
// it looks dated, edit it in the tab — that is now the point.

const TEMPLATES = [
  // ── Money → the client ────────────────────────────────────────────────────
  {
    // Points at the finalisation PAGE, not at a Stripe URL (Joe, 2026-08-20:
    // "why would we not just use that finalization link always?"). A checkout
    // session dies 24 hours after it is minted, so a client who opens this
    // email on Thursday finds a dead page; the finalisation link mints checkout
    // when they press Pay and cannot go stale. It also collects the details we
    // need — the address especially — on the way past.
    template_key: 'deposit_link_ready',
    name: 'Deposit link — to the client',
    trigger_event: 'manual', recipient: 'client', sort_order: 10,
    subject: 'Your deposit link is ready! 💳 — Funky Monkey Events',
    body_html: `<p style="font-size:16px;margin-bottom:16px">Hi <strong>{{client_name}}</strong>! 🎉</p>
      <p style="color:#A78BCA;line-height:1.7;margin-bottom:20px">Your booking for <strong style="color:#F3E8FF">{{service_name}}</strong> is approved! Pay your deposit to lock in your date.</p>
      <div style="background:#1A1035;border-radius:12px;padding:16px;margin-bottom:24px;text-align:center">
      <div style="font-size:11px;color:#A78BCA;text-transform:uppercase;font-weight:700;margin-bottom:6px">Deposit Amount</div>
      <div style="font-size:36px;font-weight:900;color:#10B981">\${{deposit_amount}}</div>
      <div style="font-size:12px;color:#A78BCA;margin-top:4px">Secure your date — balance due day of event</div></div>
      <div style="text-align:center;margin-bottom:24px">
      <a href="{{finalise_link}}" style="background-color:#10B981;color:#ffffff;padding:16px 40px;border-radius:12px;text-decoration:none;font-weight:900;font-size:16px;display:inline-block">Pay Deposit Now →</a>
      <div style="font-size:11px;color:#A78BCA;margin-top:14px;line-height:1.5">Button not working? Copy this link into your browser:<br>
      <a href="{{finalise_link}}" style="color:#06B6D4;word-break:break-all">{{finalise_link}}</a></div></div>
      <div style="background:#FFFFFF08;border-radius:10px;padding:12px;font-size:11px;color:#A78BCA;line-height:1.6;text-align:center">
      🔒 Secure payment powered by Stripe · Accepts all major cards, Apple Pay &amp; Google Pay<br>Booking ref: {{reference}}</div>
      <p style="font-size:13px;color:#A78BCA;text-align:center;margin-top:16px">Questions? <a href="tel:4054316625" style="color:#06B6D4;font-weight:700">(405) 431-6625</a></p>`,
    body_sms: ''
  },
  {
    // Points at the finalisation page, like the deposit email: the page mints
    // a balance session when they press Pay, so this email cannot arrive
    // carrying a checkout that expired overnight.
    template_key: 'balance_link_ready',
    name: 'Balance link — to the client',
    trigger_event: 'manual', recipient: 'client', sort_order: 11,
    subject: 'Your balance is ready to pay 💳 — Funky Monkey Events',
    body_html: `<p style="font-size:16px;margin-bottom:16px">Hi <strong>{{client_name}}</strong>! 👋</p>
      <p style="color:#A78BCA;line-height:1.7;margin-bottom:20px">Here's the balance for <strong style="color:#F3E8FF">{{service_name}}</strong>. You can settle it with the button below.</p>
      <div style="background:#1A1035;border-radius:12px;padding:16px;margin-bottom:24px">
      <table style="width:100%;border-collapse:collapse;color:#F3E8FF;font-size:14px">
      <tr><td style="padding:4px 0;color:#A78BCA">Balance</td><td style="padding:4px 0;text-align:right">\${{balance_due}}</td></tr>
      <tr><td style="padding:4px 0;color:#A78BCA">Service fee ({{service_fee_pct}}%)</td><td style="padding:4px 0;text-align:right">\${{service_fee}}</td></tr>
      <tr><td style="padding:8px 0 0;border-top:1px solid #3D2460;font-weight:900">Total due</td><td style="padding:8px 0 0;border-top:1px solid #3D2460;text-align:right;color:#10B981;font-size:20px;font-weight:900">\${{balance_total}}</td></tr>
      </table></div>
      <div style="text-align:center;margin-bottom:24px">
      <a href="{{finalise_link}}" style="background-color:#10B981;color:#ffffff;padding:16px 40px;border-radius:12px;text-decoration:none;font-weight:900;font-size:16px;display:inline-block">Pay Balance Now →</a>
      <div style="font-size:11px;color:#A78BCA;margin-top:14px;line-height:1.5">Button not working? Copy this link into your browser:<br>
      <a href="{{finalise_link}}" style="color:#06B6D4;word-break:break-all">{{finalise_link}}</a></div></div>
      <div style="background:#FFFFFF08;border-radius:10px;padding:12px;font-size:11px;color:#A78BCA;line-height:1.6;text-align:center">
      🔒 Secure payment powered by Stripe · Booking ref: {{reference}}</div>
      <p style="font-size:13px;color:#A78BCA;text-align:center;margin-top:16px">Questions? <a href="tel:4054316625" style="color:#06B6D4;font-weight:700">(405) 431-6625</a></p>`,
    // Left blank on purpose. {{balance_link}} is empty until the link is
    // persisted, and a text quoting a total with no way to pay it is worse
    // than no text at all.
    body_sms: ''
  },
  {
    // extra: amount_paid
    template_key: 'deposit_paid_receipt',
    extras: ['amount_paid'],
    name: 'Deposit paid — receipt to the client',
    trigger_event: 'system', recipient: 'client', sort_order: 12,
    subject: "Deposit received — You're CONFIRMED! 🎊 Funky Monkey Events",
    body_html: `<p style="font-size:16px;margin-bottom:16px">Hi <strong>{{client_name}}</strong>! 🎉</p>
      <p style="color:#A78BCA;line-height:1.7;margin-bottom:20px">We got your deposit and your event is officially <strong style="color:#10B981">CONFIRMED!</strong></p>
      <div style="background:#1A1035;border-radius:12px;padding:16px;margin-bottom:20px">
      <div style="margin-bottom:10px"><span style="color:#A78BCA;font-size:11px;text-transform:uppercase;font-weight:700">Service</span><br><span style="font-weight:600">{{service_name}}</span></div>
      <div style="margin-bottom:10px"><span style="color:#A78BCA;font-size:11px;text-transform:uppercase;font-weight:700">Date &amp; Time</span><br><span style="font-weight:600">{{event_datetime}}</span></div>
      <div style="margin-bottom:10px"><span style="color:#A78BCA;font-size:11px;text-transform:uppercase;font-weight:700">Location</span><br><span style="font-weight:600">{{location_label}}</span></div>
      <div style="display:flex;gap:24px;flex-wrap:wrap;margin-top:10px;padding-top:10px;border-top:1px solid #3D246044">
      <div><span style="color:#A78BCA;font-size:11px;text-transform:uppercase;font-weight:700">Deposit Paid ✓</span><br><span style="color:#10B981;font-size:20px;font-weight:900">\${{amount_paid}}</span></div>
      <div><span style="color:#A78BCA;font-size:11px;text-transform:uppercase;font-weight:700">Balance Due Day-Of</span><br><span style="color:#FFD600;font-size:20px;font-weight:900">\${{balance_due}}</span></div>
      </div></div>
      <p style="color:#A78BCA;font-size:13px;text-align:center">Questions? <a href="tel:4054316625" style="color:#06B6D4;font-weight:700">(405) 431-6625</a></p>`,
    body_sms: ''
  },
  {
    // Two receipts, not one with a variable sentence: "settled in full" is only
    // true when the payment actually zeroed the balance, and a quote raised
    // after the link was minted can leave a real shortfall. Telling a client
    // they are paid up when they are not is the failure this pair prevents —
    // balanceReceiptCopy() in stripe-webhook.js picks which one goes out.
    template_key: 'balance_paid_receipt_full',
    extras: ['payment_breakdown'],
    name: 'Balance paid in full — receipt to the client',
    trigger_event: 'system', recipient: 'client', sort_order: 13,
    subject: "Payment received — you're all paid up! \ud83c\udf89 Funky Monkey Events",
    body_html: `<p style="font-size:16px;margin-bottom:16px">Hi <strong>{{client_name}}</strong>! \ud83c\udf89</p>
      <p style="color:#A78BCA;line-height:1.7;margin-bottom:20px">Thank you — your balance for <strong style="color:#F3E8FF">{{service_name}}</strong> is settled in full.</p>
      <div style="background:#1A1035;border-radius:12px;padding:16px;margin-bottom:20px">
      <table style="width:100%;border-collapse:collapse;color:#F3E8FF;font-size:14px">{{payment_breakdown}}</table>
      </div>
      <p style="color:#A78BCA;font-size:13px;text-align:center">Booking ref: {{reference}} \u00b7 Questions? <a href="tel:4054316625" style="color:#06B6D4;font-weight:700">(405) 431-6625</a></p>`,
    body_sms: ''
  },
  {
    // {{outstanding}} is what is STILL owed after this payment, not what was
    // paid. It must agree with the row to the cent.
    template_key: 'balance_paid_receipt_partial',
    extras: ['payment_breakdown', 'outstanding'],
    name: 'Balance part-paid — receipt to the client',
    trigger_event: 'system', recipient: 'client', sort_order: 14,
    subject: 'Payment received \u2014 Funky Monkey Events',
    body_html: `<p style="font-size:16px;margin-bottom:16px">Hi <strong>{{client_name}}</strong>! \ud83c\udf89</p>
      <p style="color:#A78BCA;line-height:1.7;margin-bottom:20px">Thank you — your balance for <strong style="color:#F3E8FF">{{service_name}}</strong> still has \${{outstanding}} outstanding — we'll follow up about the remaining balance.</p>
      <div style="background:#1A1035;border-radius:12px;padding:16px;margin-bottom:20px">
      <table style="width:100%;border-collapse:collapse;color:#F3E8FF;font-size:14px">{{payment_breakdown}}</table>
      </div>
      <p style="color:#A78BCA;font-size:13px;text-align:center">Booking ref: {{reference}} \u00b7 Questions? <a href="tel:4054316625" style="color:#06B6D4;font-weight:700">(405) 431-6625</a></p>`,
    body_sms: ''
  },
  {
    // Sent to whoever Stripe says tried to pay. There is often no booking to
    // attach it to, which is why it names nothing about the event.
    template_key: 'payment_failed',
    name: 'Payment failed — to the client',
    trigger_event: 'system', recipient: 'client', sort_order: 14,
    subject: "Payment didn't go through — Funky Monkey Events",
    body_html: `<p style="font-size:16px;margin-bottom:16px">Hi there! 👋</p>
      <p style="color:#A78BCA;line-height:1.7;margin-bottom:20px">Your deposit payment didn't go through — no worries, it happens!</p>
      <p style="color:#A78BCA;line-height:1.7;margin-bottom:20px">Try again with a different card, or give us a call and we'll figure it out.</p>
      <p style="font-size:13px;color:#A78BCA;text-align:center"><a href="tel:4054316625" style="color:#06B6D4;font-weight:700">(405) 431-6625</a></p>`,
    body_sms: ''
  },
  {
    // extra: refund_amount
    template_key: 'refund_issued',
    extras: ['refund_amount'],
    name: 'Refund processed — to the client',
    trigger_event: 'system', recipient: 'client', sort_order: 15,
    subject: 'Refund Processed - {{reference}}',
    body_html: `<h2>Refund Processed</h2>
      <p>Hi {{client_first_name}},</p>
      <p>Your refund has been processed:</p>
      <ul>
        <li><strong>Amount:</strong> \${{refund_amount}}</li>
        <li><strong>Booking:</strong> {{service_name}} on {{event_date}}</li>
        <li><strong>Reference:</strong> {{reference}}</li>
      </ul>
      <p>The refund should appear in your account within 5-10 business days.</p>
      <p>If you have any questions, please don't hesitate to contact us.</p>
      <p>Thank you,<br>Funky Monkey Events</p>`,
    body_sms: ''
  },

  // ── The booking → the client ──────────────────────────────────────────────
  {
    template_key: 'finalisation_link',
    name: 'Finalisation link (deposit due) — to the client',
    trigger_event: 'manual', recipient: 'client', sort_order: 20,
    subject: 'Finalise your booking — {{reference}}',
    body_html: `<p>Hi {{client_first_name}}!</p>
      <p>Please review your details, fill in anything missing, and pay your deposit to secure the date:</p>
      <p><a href="{{finalise_link}}">Finalise my booking</a></p>`,
    body_sms: 'Hi {{client_first_name}}! Please finish your booking details and pay your deposit here: {{finalise_link}} Reply STOP to opt out.'
  },
  {
    // Two finalisation variants rather than one with a conditional: a
    // $0-deposit booking (school, library) must not be told to pay a deposit,
    // and a template language with an if-statement is a bigger thing to own
    // than a second row.
    template_key: 'finalisation_link_no_deposit',
    name: 'Finalisation link (nothing to pay) — to the client',
    trigger_event: 'manual', recipient: 'client', sort_order: 21,
    subject: 'Finalise your booking — {{reference}}',
    body_html: `<p>Hi {{client_first_name}}!</p>
      <p>Please review your details and fill in anything missing so we have everything we need for your event:</p>
      <p><a href="{{finalise_link}}">Finalise my booking</a></p>`,
    body_sms: 'Hi {{client_first_name}}! Please finish your booking details here: {{finalise_link}} Reply STOP to opt out.'
  },
  {
    // extra: total_line (the estimated total, or a note that a quote follows)
    template_key: 'booking_request_received',
    extras: ['total_line'],
    name: 'Booking request received — to the client',
    trigger_event: 'system', recipient: 'client', sort_order: 22,
    subject: '🎉 Booking Request Received — Funky Monkey Events ({{reference}})',
    body_html: `<h2>Thanks, {{client_first_name}}!</h2>
      <p>We've received your booking request and will get back to you within 24 hours to confirm availability.</p>
      <p><strong>Your reference number:</strong> {{reference}}</p>
      <h3>Booking Summary</h3>
      <p><strong>Service:</strong> {{service_name}}</p>
      <p><strong>Date:</strong> {{event_datetime}}</p>
      {{total_line}}
      <p><strong>Deposit to Confirm:</strong> \${{deposit_amount}}</p>
      <br/>
      <p>Questions? Call or text us at <strong>(405) 431-6625</strong></p>
      <p>— The Funky Monkey Events Team 🐒</p>`,
    body_sms: ''
  },
  {
    // extra: change_list (<li> rows of what the client edited)
    template_key: 'booking_updated_receipt',
    extras: ['change_list'],
    name: 'Client updated their details — receipt to the client',
    trigger_event: 'system', recipient: 'client', sort_order: 23,
    subject: 'Your booking was updated — {{reference}}',
    body_html: `<h2>Your booking was updated</h2>
      <p>Here's what changed on <strong>{{reference}}</strong>:</p>
      <ul>{{change_list}}</ul>
      <p>Didn't make this change? Call us on <a href="tel:+14054316625">(405) 431-6625</a>.</p>`,
    body_sms: ''
  },
  {
    // Goes to the PREVIOUS address, and is the only control this flow has:
    // auth is a reference plus an email, so anyone forwarded the original link
    // could change the contact address and quietly take over the booking.
    // {{client_email}} is the new one — the row is already updated.
    template_key: 'contact_email_changed',
    name: 'Contact email changed — warning to the old address',
    trigger_event: 'system', recipient: 'client', sort_order: 24,
    subject: 'Contact email changed on your booking — {{reference}}',
    body_html: `<h2>Your contact email was changed</h2>
      <p>The email address on booking <strong>{{reference}}</strong> was just changed to <strong>{{client_email}}</strong>.</p>
      <p><strong>If this was you, nothing further is needed</strong> — your new link has been sent to that address.</p>
      <p>If it was not you, call us straight away on <a href="tel:+14054316625">(405) 431-6625</a>.</p>`,
    body_sms: ''
  },
  {
    // extra: change_block (an optional "they also updated…" list)
    template_key: 'finalise_link_reissued',
    extras: ['change_block'],
    name: 'Finalisation link re-issued — to the new address',
    trigger_event: 'system', recipient: 'client', sort_order: 25,
    subject: 'Your updated booking link — {{reference}}',
    body_html: `<h2>Here is your new link</h2>
      <p>Your contact email is now <strong>{{client_email}}</strong>, so your previous link no longer works. Use this one from now on:</p>
      <p><a href="{{finalise_link}}" style="background:#7c3aed;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none">Open my booking</a></p>
      {{change_block}}`,
    body_sms: ''
  },

  // ── To the crew ───────────────────────────────────────────────────────────
  {
    // extra: staff_name, matching_skills, portal_link
    template_key: 'staff_gig_available',
    extras: ['staff_name', 'matching_skills', 'portal_link'],
    name: 'Gig available — to matching staff',
    trigger_event: 'system', recipient: 'staff', sort_order: 30, channel: 'both',
    subject: '🎪 Gig Available — {{service_name}} on {{event_date}}',
    body_html: `<p style="font-size:16px;margin-bottom:16px">Hi <strong>{{staff_name}}</strong>! 👋</p>
      <p style="color:#A78BCA;line-height:1.7;margin-bottom:20px">A new gig is available and your skills match what's needed. Log in to the staff portal to express your interest!</p>
      <div style="background:#1A1035;border-radius:12px;padding:16px;margin-bottom:20px">
        <div style="margin-bottom:10px"><span style="color:#A78BCA;font-size:11px;text-transform:uppercase;font-weight:700">Service</span><br><span style="font-weight:600">{{service_name}}</span></div>
        <div style="margin-bottom:10px"><span style="color:#A78BCA;font-size:11px;text-transform:uppercase;font-weight:700">Date &amp; Time</span><br><span style="font-weight:600">{{event_datetime}}</span></div>
        <div style="margin-bottom:10px"><span style="color:#A78BCA;font-size:11px;text-transform:uppercase;font-weight:700">Area</span><br><span style="font-weight:600">{{location_label}}</span></div>
        <div><span style="color:#A78BCA;font-size:11px;text-transform:uppercase;font-weight:700">Your Matching Skills</span><br><span style="color:#FFD600;font-weight:700">{{matching_skills}}</span></div>
      </div>
      <div style="text-align:center;margin-bottom:20px">
        <a href="{{portal_link}}" style="background-color:#7c3aed;color:#fff;padding:14px 32px;border-radius:10px;text-decoration:none;font-weight:900;font-size:15px;display:inline-block">Open the Staff Portal →</a>
      </div>
      <p style="font-size:12px;color:#A78BCA;text-align:center">Log in with your access code · {{portal_link}}</p>`,
    // Two segments is the budget. This used to list lettered roles for the crew
    // to reply with; the codes were removed 2026-08-20 and the portal is the one
    // place interest is registered.
    body_sms: "Gig available: {{service_name}}, {{event_datetime}} - {{event_zip}}. Sign up in the portal: {{portal_link}} Reply STOP to opt out."
  },
  {
    // extra: staff_name, staff_role, schedule_block, portal_link
    // schedule_block is built in staff-assignments.js: it is either the call
    // times or a note that they arrive once the ZIP is confirmed.
    template_key: 'staff_assigned',
    extras: ['staff_name', 'staff_role', 'schedule_block', 'portal_link', 'load_time'],
    name: "You're booked — to the assigned staff member",
    trigger_event: 'system', recipient: 'staff', sort_order: 31, channel: 'both',
    subject: "✅ You're booked! {{service_name}} on {{event_date}}",
    body_html: `<p style="font-size:16px;margin-bottom:16px">Hi <strong>{{staff_name}}</strong>! 🎉</p>
      <p style="color:#A78BCA;line-height:1.7;margin-bottom:20px">You've been assigned to a gig! Here are your details and call times.</p>
      <div style="background:#1A1035;border-radius:12px;padding:16px;margin-bottom:4px">
        <div style="margin-bottom:10px"><span style="color:#A78BCA;font-size:11px;text-transform:uppercase;font-weight:700">Service</span><br><span style="font-weight:600">{{service_name}}</span></div>
        <div style="margin-bottom:10px"><span style="color:#A78BCA;font-size:11px;text-transform:uppercase;font-weight:700">Event Date</span><br><span style="font-weight:600">{{event_datetime}}</span></div>
        <div style="margin-bottom:10px"><span style="color:#A78BCA;font-size:11px;text-transform:uppercase;font-weight:700">Area</span><br><span style="font-weight:600">{{location_label}}</span></div>
        <div><span style="color:#A78BCA;font-size:11px;text-transform:uppercase;font-weight:700">Your Role</span><br><span style="color:#FFD600;font-weight:700">{{staff_role}}</span></div>
      </div>
      {{schedule_block}}
      <div style="text-align:center;margin-top:20px;margin-bottom:20px">
        <a href="{{portal_link}}" style="background-color:#10B981;color:#fff;padding:14px 32px;border-radius:10px;text-decoration:none;font-weight:900;font-size:15px;display:inline-block">View Full Gig Details →</a>
      </div>
      <p style="font-size:12px;color:#A78BCA;text-align:center">Questions? Contact Joe at <a href="tel:4054316625" style="color:#06B6D4">(405) 431-6625</a></p>`,
    // {{load_time}} is the shift start, not the event time: the whole point of
    // the text is the number they set an alarm for.
    body_sms: "You're booked: {{service_name}}, {{event_date}}. Load up {{load_time}}, {{event_zip}}. Details in the portal: {{portal_link}}"
  },

  {
    // extra: last_service, last_when ("back in <strong>June 2026</strong>", or
    // nothing at all when the date is unknown)
    template_key: 'rebook_invite',
    extras: ['last_service', 'last_when'],
    name: 'Rebook invitation — to a past client',
    trigger_event: 'manual', recipient: 'client', sort_order: 26,
    subject: "We'd love to see you again! \ud83d\udc12 \u2014 Funky Monkey Events",
    body_html: `<p style="font-size:16px;margin-bottom:16px">Hi <strong>{{client_name}}</strong>! \ud83c\udf89</p>
      <p style="color:#A78BCA;line-height:1.7;margin-bottom:20px">We had such an amazing time at <strong>{{last_service}}</strong>{{last_when}} and wanted to reach out!</p>
      <p style="color:#A78BCA;line-height:1.7;margin-bottom:20px">Planning another event? <strong style="color:#FFD600">Returning clients get 10% off</strong> their next booking — just mention this email when you book!</p>
      <div style="text-align:center;margin-bottom:24px"><a href="https://funkymonkeyevents.com/booking-form.html" style="background-color:#FF6B00;color:#0F0A1E;padding:14px 32px;border-radius:10px;text-decoration:none;font-weight:900;font-size:15px">Book Your Next Event →</a></div>
      <p style="font-size:13px;color:#A78BCA;text-align:center">Questions? <a href="tel:4054316625" style="color:#06B6D4;font-weight:700">(405) 431-6625</a></p>`,
    body_sms: ''
  },

  // ── To us ─────────────────────────────────────────────────────────────────
  {
    template_key: 'new_booking_alert',
    name: 'New booking request — alert to us',
    trigger_event: 'system', recipient: 'admin', sort_order: 40,
    subject: '🐒 New Booking Request — {{reference}} — {{service_name}}',
    body_html: `<h2>New Booking Request</h2>
      <p><strong>Ref:</strong> {{reference}}</p>
      <p><strong>Service:</strong> {{service_name}}</p>
      <p><strong>Date:</strong> {{event_datetime}}</p>
      <p><strong>ZIP:</strong> {{event_zip}} — {{event_location}}</p>
      <p><strong>Event Type:</strong> {{event_type}} · {{guest_count}} guests</p>
      <hr/>
      <p><strong>Client:</strong> {{client_name}}</p>
      <p><strong>Phone:</strong> {{client_phone}}</p>
      <p><strong>Email:</strong> {{client_email}}</p>
      <p><strong>Referral:</strong> {{referral_source}}</p>
      <hr/>
      <p><strong>Service:</strong> \${{service_price}}</p>
      {{addon_list}}
      {{mileage_line}}
      <p><strong>Total:</strong> \${{total_price}}</p>
      <p><strong>Deposit:</strong> \${{deposit_amount}}</p>
      <p><strong>Balance Due:</strong> \${{balance_due}}</p>
      <p><strong>Notes:</strong> {{notes}}</p>
      <br/>
      <a href="{{admin_link}}" style="background:#7c3aed;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none">View in Admin</a>`,
    body_sms: ''
  },
  {
    // extra: amount_paid, payment_kind_label, payment_headline
    template_key: 'payment_received_alert',
    extras: ['amount_paid', 'payment_kind_label', 'payment_headline'],
    name: 'Payment received — alert to us',
    trigger_event: 'system', recipient: 'admin', sort_order: 41,
    subject: '💰 {{payment_kind_label}} In: {{client_name}} — \${{amount_paid}}',
    body_html: `<p style="font-size:15px;font-weight:700;color:#10B981;margin-bottom:16px">💰 {{payment_headline}}</p>
      <table style="width:100%;border-collapse:collapse">
        <tr><td style="padding:7px 0;color:#A78BCA;font-size:11px;text-transform:uppercase;font-weight:700;width:130px">Ref</td><td style="padding:7px 0;color:#FFD600;font-weight:700">{{reference}}</td></tr>
        <tr><td style="padding:7px 0;color:#A78BCA;font-size:11px;text-transform:uppercase;font-weight:700">Client</td><td style="padding:7px 0;font-weight:700">{{client_name}}</td></tr>
        <tr><td style="padding:7px 0;color:#A78BCA;font-size:11px;text-transform:uppercase;font-weight:700">Service</td><td style="padding:7px 0">{{service_name}}</td></tr>
        <tr><td style="padding:7px 0;color:#A78BCA;font-size:11px;text-transform:uppercase;font-weight:700">Date</td><td style="padding:7px 0">{{event_datetime}}</td></tr>
        <tr><td style="padding:7px 0;color:#A78BCA;font-size:11px;text-transform:uppercase;font-weight:700">{{payment_kind_label}} Paid</td><td style="padding:7px 0;color:#10B981;font-size:18px;font-weight:900">\${{amount_paid}}</td></tr>
        <tr><td style="padding:7px 0;color:#A78BCA;font-size:11px;text-transform:uppercase;font-weight:700">Balance Due</td><td style="padding:7px 0;color:#FFD600;font-weight:700">\${{balance_due}}</td></tr>
      </table>
      <div style="margin-top:20px;text-align:center">
        <a href="{{admin_link}}" style="background-color:#FF6B00;color:#0F0A1E;padding:12px 28px;border-radius:10px;text-decoration:none;font-weight:900;font-size:14px">View in Dashboard →</a>
      </div>`,
    body_sms: ''
  },
  {
    // extra: quote_lines (the <li> rows of what they accepted)
    template_key: 'quote_accepted_alert',
    extras: ['quote_lines'],
    name: 'Quote accepted — alert to us',
    trigger_event: 'system', recipient: 'admin', sort_order: 42,
    subject: '✅ Quote ACCEPTED — {{reference}} — {{client_name}}',
    body_html: `<h2>Quote accepted</h2>
      <p><strong>{{client_name}}</strong> just accepted their quote from the booking page.</p>
      <p><strong>Ref:</strong> {{reference}}</p>
      <p><strong>Date:</strong> {{event_date}}</p>
      <ul>{{quote_lines}}</ul>
      <p><strong>Total:</strong> \${{total_price}}</p>
      <p><strong>Deposit to collect:</strong> \${{deposit_amount}}</p>
      <p>Next step: send the deposit link.</p>
      <br/>
      <a href="{{admin_link}}" style="background:#7c3aed;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none">Open in Admin</a>`,
    body_sms: ''
  },
  {
    // extra: changed_what, zip_case
    // The price is NOT recalculated when a client moves the event, which is the
    // whole reason this alert exists.
    template_key: 'zip_changed_alert',
    extras: ['changed_what', 'zip_case'],
    name: 'Client moved the event — alert to us',
    trigger_event: 'system', recipient: 'admin', sort_order: 43,
    subject: '⚠ ZIP changed after quote — {{reference}}',
    body_html: `<h2>The client moved the event</h2>
      <p><strong>{{client_name}}</strong> changed {{changed_what}} on <strong>{{reference}}</strong> while finalising their details.</p>
      {{zip_case}}
      <p><strong>Address:</strong> {{event_location}}</p>
      <p>The total is unchanged at \${{total_price}} — mileage was <em>not</em> recalculated. Re-quote if the drive is materially different.</p>
      <a href="{{admin_link}}" style="background:#7c3aed;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none">Open in Admin</a>`,
    body_sms: ''
  },
  {
    // extra: detail_rows (venue and time, when the booking has them),
    //        requested_by, requested_from, requested_at
    template_key: 'coi_request_alert',
    extras: ['detail_rows', 'requested_by', 'requested_from', 'requested_at'],
    name: 'Certificate of insurance requested — alert to us',
    trigger_event: 'system', recipient: 'admin', sort_order: 44,
    subject: 'COI Request — {{reference}} ({{client_name}})',
    body_html: `<h2 style="color:#7C3AED;margin-bottom:20px">Certificate of Insurance Requested</h2>
      <div style="background:#F3F4F6;padding:20px;border-radius:8px;margin-bottom:20px">
        <h3 style="margin-top:0;color:#1F2937">Booking Details</h3>
        <table style="width:100%;border-collapse:collapse">
          <tr><td style="padding:8px 0;color:#6B7280;width:40%">Reference:</td><td style="padding:8px 0;font-weight:600">{{reference}}</td></tr>
          <tr><td style="padding:8px 0;color:#6B7280">Client:</td><td style="padding:8px 0;font-weight:600">{{client_name}}</td></tr>
          <tr><td style="padding:8px 0;color:#6B7280">Email:</td><td style="padding:8px 0">{{client_email}}</td></tr>
          <tr><td style="padding:8px 0;color:#6B7280">Service:</td><td style="padding:8px 0">{{service_name}}</td></tr>
          <tr><td style="padding:8px 0;color:#6B7280">Event Date:</td><td style="padding:8px 0;font-weight:600">{{event_date}}</td></tr>
          {{detail_rows}}
        </table>
      </div>
      <div style="background:#FEF3C7;border-left:4px solid #F59E0B;padding:16px;border-radius:4px;margin-bottom:20px">
        <p style="margin:0;color:#92400E"><strong>Action Required:</strong> Client needs a Certificate of Insurance for this event.</p>
      </div>
      <div style="margin-bottom:20px">
        <h3 style="color:#1F2937">Request Details</h3>
        <p><strong>Requested by:</strong> {{requested_by}}</p>
        <p><strong>Requested from:</strong> {{requested_from}}</p>
        <p><strong>Requested at:</strong> {{requested_at}}</p>
      </div>
      <div style="background:#F3F4F6;padding:16px;border-radius:4px;margin-top:24px">
        <p style="margin:0;color:#6B7280;font-size:14px">To mark this COI as fulfilled, go to the booking in your admin dashboard.</p>
      </div>`,
    body_sms: ''
  },
  {
    // extra: staff_name, report_rows
    template_key: 'post_gig_survey_alert',
    extras: ['staff_name', 'report_rows'],
    name: 'Post-gig report filed — alert to us',
    trigger_event: 'system', recipient: 'admin', sort_order: 45,
    subject: '📋 Post-Gig Survey Submitted — {{staff_name}} · {{reference}}',
    body_html: `<p style="font-weight:700;font-size:15px;margin-bottom:16px">📋 {{staff_name}} submitted a post-gig report for <span style="color:#FFD600">{{service_name}}</span></p>
      <table style="width:100%;border-collapse:collapse">{{report_rows}}</table>
      <div style="margin-top:20px;text-align:center">
        <a href="{{admin_link}}" style="background-color:#FF6B00;color:#0F0A1E;padding:12px 28px;border-radius:10px;text-decoration:none;font-weight:900;font-size:14px">View in Dashboard →</a>
      </div>`,
    body_sms: ''
  },
  {
    // extra: changed_what, zip_case, camp_dates, day_count
    //
    // A camp's own version of 'zip_changed_alert'. It needs its own wording
    // rather than reusing that one, because that template's closing line —
    // "The total is unchanged at ${{total_price}}, mileage was not
    // recalculated" — is false twice over for a camp: a camp is priced per
    // kid with no mileage in it at all, and its total_price is $0 until it is
    // closed out. An alert to ourselves has to be accurate to be worth having.
    //
    // The stake is also higher than one gig: moving a camp moves every day of
    // it, so the drive changes for a whole week at once.
    template_key: 'camp_moved_alert',
    extras: ['changed_what', 'zip_case', 'camp_dates', 'day_count'],
    name: 'Client moved a camp — alert to us',
    trigger_event: 'system', recipient: 'admin', sort_order: 46,
    subject: '⚠ Camp venue changed — {{reference}}',
    body_html: `<h2>The client moved a whole camp</h2>
      <p><strong>{{client_name}}</strong> changed {{changed_what}} on <strong>{{reference}}</strong> while finalising the camp's details.</p>
      <p><strong>Camp:</strong> {{service_name}} · {{camp_dates}} · {{day_count}}</p>
      {{zip_case}}
      <p><strong>Address:</strong> {{event_location}}</p>
      <p>A camp is priced per kid, so this does not change what they owe — but it moves <em>every day</em> of the camp, so check the drive is still workable before it runs.</p>
      <a href="{{admin_link}}" style="background:#7c3aed;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none">Open in Admin</a>`,
    body_sms: ''
  }
];

module.exports = { TEMPLATES };
