# SMS compliance pages — paste-ready content for Wix

**Why these exist:** A2P 10DLC campaign vetting fetches a privacy policy URL and a
messaging-terms URL and reads them. Missing or vague wording is the most common
reason a campaign is rejected.

**Where they live:** www.funkymonkeyevents.com (Wix). These are the *only* copies —
deliberately not duplicated into this repo, because two legal pages that can drift
apart are worse than one. The booking form links to these URLs.

**Required slugs** — the booking form hardcodes these, so use them exactly:
- `/privacy`
- `/sms-terms`

**Do not change the highlighted paragraph in the privacy policy without checking
first.** It is the specific language carriers look for.

---

# PAGE 1 — Privacy Policy

**Page title:** Privacy Policy
**URL slug:** `privacy`

---

Last updated: August 15, 2026

Funky Monkey Events provides entertainment for parties and events in the Oklahoma City area. This policy explains what personal information we collect, why, and what we do and do not do with it.

## Text messaging and your mobile number

**No mobile information is sold or shared with third parties or affiliates for marketing or promotional purposes. Text messaging originator opt-in data and consent are never shared with any third party.** Mobile numbers are used only to send you messages about your own booking, or — if you work with us — about your own shifts.

We share mobile numbers only with the messaging provider that delivers our texts, and only so that the message reaches your handset. That provider is contractually barred from using the number for any other purpose.

You can stop text messages at any time by replying STOP. Full details are in our SMS Terms & Conditions.

## What we collect

From customers, when you request or make a booking:

- Your name, email address, and mobile number
- Event details — date, time, location or ZIP code, type of event, guest count, and the name of whoever the event is for
- Notes you choose to give us about the booking
- A record of payments, including amount, date, and method. **We do not store card numbers.** Card payments are handled by our payment processor, and we only ever see a confirmation and the last portion of the card.

From staff and performers who work with us: name, contact details, communication preferences, skills, availability, assignments worked, and pay records.

## Why we collect it

- To quote for, arrange, and deliver the event you booked
- To contact you about that booking — confirmation, payment, reminders, and follow-up
- To staff the event and tell the crew where to be and when
- To keep the financial records a business is required to keep

We do not use your details to advertise to you by text. If we send occasional email about offers, every such email has an unsubscribe link.

## Who we share it with

We share the minimum necessary with the services that make the business run:

- Our payment processor, to take a deposit or balance
- Our email provider, to send booking emails
- Our messaging provider, to deliver text messages
- Our staff, who see the event details and address they need to work your event

We do not sell your personal information. We do not share it with advertisers or data brokers. We disclose information to anyone else only where the law requires it.

## How long we keep it

Booking and payment records are retained for as long as needed to run the business and to meet tax and accounting obligations. If you ask us to delete your details, we will do so except where a record must be kept for those obligations.

## Your choices

- **Stop texts:** reply STOP to any message.
- **Stop marketing email:** use the unsubscribe link, or ask us.
- **See, correct, or delete what we hold:** contact us using the details below and we will respond.

Stopping messages does not cancel a booking. To change or cancel a booking, contact us directly.

## Security

Booking data is held in an access-controlled database. Staff sign in to reach the parts of it they need. Card details never touch our systems.

## Children

We entertain at children's parties, and a booking often names the child the party is for. That information is given to us by the adult making the booking and is used only to run the event. We do not knowingly collect information directly from children, and we do not market to them.

## Changes

We may update this policy. The "last updated" date above reflects the most recent change.

## Contact

Funky Monkey Events
Oklahoma City, Oklahoma
(405) 431-6625
bookings@funkymonkeyevents.com

---
---

# PAGE 2 — SMS Terms & Conditions

**Page title:** SMS Terms & Conditions
**URL slug:** `sms-terms`

---

Last updated: August 15, 2026

## What this program is

Funky Monkey Events sends text messages about event bookings. There are two separate audiences:

- **Customers** receive messages about their own booking — confirmation that a booking is set, a payment or deposit link, a reminder before the event, a note about a balance due, and a request for a review afterwards.
- **Event staff and performers** receive messages about work — gigs available that match their skills, confirmation that they have been booked, call times and addresses on the day of an event.

This is not a marketing or promotional program. We do not send advertising by text.

## How you opt in

Customers provide a mobile number on our booking form, where a notice beside the phone field states: *"We'll text you about your booking. Reply STOP to opt out. Message and data rates may apply."* Submitting the form with a mobile number is your consent to receive the messages described above.

Staff provide a mobile number in their staff portal profile and choose which channels they want to be reached on. SMS is only sent to staff who have selected it.

Consent to receive text messages is not a condition of any purchase.

## Message frequency

Message frequency varies. It depends on how many bookings you have with us and where each one is in its lifecycle. A typical booking results in a small number of messages between the booking being confirmed and shortly after the event.

## Cost

**Message and data rates may apply.** We do not charge for the messages themselves; your mobile carrier may charge you according to your plan.

## How to stop messages

Reply **STOP** to any message to stop receiving texts from us. You will not receive further messages after that. Reply **START** at any time to resume.

Opting out of text messages does not cancel your booking and does not stop email. If you need to change or cancel a booking, contact us directly using the details below.

## How to get help

Reply **HELP** to any message for support information, or contact us at (405) 431-6625 or bookings@funkymonkeyevents.com.

## Supported carriers and delivery

Carriers are not liable for delayed or undelivered messages. Message delivery is subject to your carrier's network and to the availability of your device, and we cannot guarantee that any individual message arrives. Do not rely on text messages alone for time-critical information about your event — if something matters, call us.

## Your privacy

Mobile numbers collected for text messaging are never sold or shared with third parties for marketing purposes. See our Privacy Policy for the full detail.

## Changes

We may update these terms. The "last updated" date above reflects the most recent change.

## Contact

Funky Monkey Events
Oklahoma City, Oklahoma
(405) 431-6625
bookings@funkymonkeyevents.com

---
---

## Twilio campaign form — what to paste where

**Opt-in description** (must match the booking form's wording exactly):

> Customers provide their phone number on the booking form at
> www.funkymonkeyevents.com, where a notice beside the phone field states
> "We'll text you about your booking. Reply STOP to opt out. Message and data
> rates may apply." Staff provide their number in their staff portal profile and
> select SMS as a communication preference.

**Sample messages** — use real ones from the system:

1. `You're booked: Foam Party, Sun 8/23. Load up 4:30 PM, 73013. Details in the portal: https://funkymonkeyadmin.netlify.app/staff-portal.html`
2. `Hi Dana! Your Foam Party on Sun 8/23 is confirmed. Questions? Call (405) 431-6625. Reply STOP to opt out.`

**Use case:** Mixed / Customer Care.
