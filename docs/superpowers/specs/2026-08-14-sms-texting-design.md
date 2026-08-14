# SMS texting for FME — design

**Date:** 2026-08-14
**Status:** approved, not yet implemented

Two-way SMS for staff and clients, delivered through Twilio on a new local
number, layered onto the notification and automation seams that already exist.

## Why

Phone coverage is better than email coverage. All 27 future bookings carry a
client phone; all 11 active staff carry a phone. One staff member (Noah Drews)
has the placeholder email `Filler@filler.com` and is currently unreachable by
the system at all — he worked a gig on 2026-08-14 that he was assigned to by a
direct database write, with no notification possible.

Email already works and is not being replaced. SMS is added where immediacy or
a reply loop matters.

## Scope

Nine messages across two audiences.

| Staff | Client |
|---|---|
| Gig available — offer to matching crew | Booking confirmed |
| You're booked — assignment confirmed | Deposit / payment link |
| Day-of reminder — call time + address | Day-before reminder |
| Gig still unstaffed — alert to Joe | Balance due before event |
| | Review link after gig |

Built in four layers over one foundation, each independently useful:

```
   SMS foundation  — provider, send, delivery log, opt-out
        ├── staff outbound
        ├── staff inbound   (express interest by reply)
        ├── client outbound
        └── client inbound  (logged + forwarded to Joe)
```

Client inbound ships last: it is the only layer carrying an operational
commitment rather than just code. A client text that lands somewhere nobody
watches is worse than no client SMS, because the client reasonably assumes it
was received.

## Provider and number

**Twilio, on a new local 405 number.**

Chosen over porting the existing business number because porting hands that
number to Twilio: voice needs explicit forwarding, and Joe could no longer text
from it on his own handset. A new number keeps his working number intact and is
reversible — porting into a system that already works is far easier than the
other direction.

Rejected: send-only via a lightweight provider. Two-way is a requirement, and
retrofitting inbound means changing provider anyway.

Cost at this volume is under $5/month: ~$1.15 number, ~$0.008/message, ~$2
10DLC.

### Prerequisite with a lead time

**US A2P 10DLC registration** (brand + campaign, using the LLC details and EIN)
must be submitted and approved before any production traffic. Unregistered
messages are filtered or dropped by carriers. This takes days, is not a design
choice, and blocks go-live — start it first.

## Architecture

Mirrors `_email.js`, which solved the same problem and works.

```
netlify/functions/
  _sms.js          NEW — sendSms(to, body, context), normalisePhone, opt-out
  sms-webhook.js   NEW — Twilio inbound: signature check, routing
  _email.js        unchanged
```

**One sender, one door.** `_email.js` exposes a single `sendEmail()` and every
caller uses it. `_sms.js` does the same. No other function talks to Twilio.
That is what allows opt-out and quiet hours to be enforced in exactly one place
rather than nine, and what makes the log complete.

### Tables

Both mirror `email_log`.

- **`sms_log`** — direction, phone, body, `booking_id`, `staff_id`, provider
  message SID, delivery status, `offer_map` (JSON, outbound offers only),
  timestamps. Provider SID is unique, which is what makes replays idempotent.
- **`sms_optout`** — phone, when, reason. Checked by `sendSms()` before send.

### Phone normalisation

Load-bearing and the most likely thing to break quietly. The `client_phone`
column holds at least four formats today: `4055417953`, `405-733-4127`,
`1-405-793-6000`, `405.801.3301`. Twilio requires E.164 (`+14055417953`).

One `normalisePhone()` applied on **send and on inbound lookup**. If the two
disagree, replies stop matching the person who sent them and the failure is
silent.

## Staff reply loop

Staff **express interest**; Joe assigns. This mirrors the existing split in
`staff-assignments.js` — `:455` inserts `status='interested'`, `:645` is the
assign path. SMS is another route into `expressInterest`, nothing more.

Consequently there is **no race and no atomic claim**: interest is not
exclusive, so two people replying about a one-slot role is normal and harmless.

**Backup remains portal-only.** A letter reply always means "available".

### Letter multi-select

An offer lists gigs as lettered options; a reply may combine them.

```
Funky Monkey — 3 gigs need crew:
a) Foam Party · Sat 8/23 6pm · Edmond · Foam Operator
b) Magic Show · Sun 8/24 2pm · Norman · Setup
c) Snow Party · Sat 8/30 11am · Moore · Foam Operator

Reply with any combination — a, ac, abc. Reply STOP to opt out.
```

`ac` registers interest in both in one message.

**The letter→gig map is stored on the outbound `sms_log` row.** A reply resolves
letters against the map from that staff member's most recent offer message, not
against whatever the open-gig list looks like at reply time. Without this, `b`
means something different two hours later, because slots change.

Unrecognised letters get a reply, not silence:
`Didn't recognise 'd' — that offer had a, b, c.`

## Inbound routing

Twilio POSTs to `sms-webhook.js`.

1. **Verify the Twilio signature.** Not optional. Without it, anyone with the
   URL can forge replies — registering interest as someone else, or opting out
   clients. Reject anything that fails.
2. **Normalise the sender**, look up staff or client.
3. **Route:**
   - `STOP` / `START` / `HELP` → write `sms_optout`, never reaches gig logic.
     Twilio also enforces at carrier level.
   - Staff with an open offer → letter parsing → `expressInterest`.
   - Everything else → logged against the matching booking **and forwarded to
     Joe's phone.**

## Client messages and the automations engine

**SMS is a channel on the existing engine, not a parallel system.**

`automations-scheduled.js` already runs daily at 14:00 UTC (9am Central), and
the rules support `status_change`, `days_before_event`, `days_after_event`,
`days_after_created`. Every client message maps onto an existing trigger:

| Message | Trigger |
|---|---|
| Booking confirmed | `status_change` → confirmed |
| Deposit / payment link | `status_change` → accepted |
| Day-before reminder | `days_before_event` = 1 |
| Balance due | `days_before_event` = N |
| Review link | `days_after_event` = N |

**One new column: `channel` (`email` | `sms` | `both`)** on the automation rules
table. The scheduled function gains a branch calling `sendSms()` alongside
`sendEmail()`.

This means SMS is configured in the admin UI that already exists — same rule
editor, same triggers, same `{{client_first_name}}` tokens — and "when do we
contact people" stays defined in one place.

The review-link message reuses `reviewLinkFor()` in `_email.js:26`, which
already picks the right Google profile per booking (Joe Coover Magic for magic
gigs, Funky Monkey otherwise).

Templates are one or two segments. SMS bills per 160 characters and long
messages fragment; these are written for the medium, not reformatted emails.

## Compliance

1. **Disclosure at collection.** The booking form gains a line under the phone
   field: *"We'll text you about your booking. Reply STOP to opt out."*
2. **`STOP` honoured in `sendSms()`**, not per-caller.
3. **Quiet hours 8am–9pm local.** The scheduler fires at 9am Central so timed
   messages are safe by construction. Event-driven messages can fire at 11pm
   when a status is flipped, so `sendSms()` holds those until morning.

## Failure modes

This codebase has a documented silent-failure bug class — eighteen instances,
several reporting a believable value instead of an error. SMS has a specific
version of it.

**Accepted but never delivered.** Twilio returns `201 queued`; the carrier
drops the message, usually from incomplete 10DLC registration. The log says
sent, the crew member got nothing, and nobody finds out until someone doesn't
turn up.

**Mitigation: delivery status callback.** Twilio POSTs `delivered` / `failed` /
`undelivered` seconds later and `sms_log.status` is updated from *that*, never
from the send call. A row reads `delivered` only when the carrier confirms it;
everything else stays `queued`, which is honest.

**SMS never breaks what it reports on.** Every call site wraps in `.catch()` and
logs, as `bookings.js:525` already does for email. A Twilio outage must not stop
a booking saving or an assignment being created.

**States, not exceptions** — each logged with its own reason, none resembling
success:

| Case | Behaviour |
|---|---|
| Unparseable phone | Skipped, logged `invalid_number` with the raw value |
| Opted out | Skipped, logged `opted_out`, never attempted |
| Outside 8am–9pm | Held, sent next morning |
| Twilio error | Logged with provider error code, booking unaffected |

**Idempotency.** Outbound: `sms_log` is checked for an existing send of the same
rule + booking + day before sending, mirroring the email guard. Inbound: Twilio
retries webhooks that do not return 200 promptly, and the unique provider SID
means a replayed `ab` creates one set of interest rows, not four.

## Testing

Follows the existing pattern — `node --test`, pure helpers behind sentinels,
and `refund.test.js`'s stubbed `globalThis.fetch` to capture provider payloads.

**No test sends a real message.**

Pure functions, where quiet breakage lives:

- **`normalisePhone()`** — the four formats in live data all resolving to one
  E.164 value; and empty / `TBD` / 3-digit fragments returning null rather than
  a plausible-but-wrong number.
- **Letter parsing** — `a`, `ab`, `AC`, ` a c `, `abc` resolve; `d` against a
  3-gig offer takes the unrecognised path rather than silently doing nothing.
- **Quiet hours** — 11pm holds, 9am sends, boundaries exact.

Behavioural, through the stub:

- An opted-out number is never passed to `fetch` — asserted on absence of the
  call, not a return value.
- A replayed inbound SID creates one interest row.
- A webhook with an invalid signature is rejected.
- A Twilio 500 leaves the booking saved and the failure logged.

**What tests cannot cover:** whether a message reaches a handset. 10DLC
filtering only appears in production. Go-live therefore includes a manual smoke
test — each of the nine templates sent to Joe's own phone, with `sms_log.status`
confirmed as `delivered`, before anything points at a client or crew member.

## Build order

1. 10DLC registration submitted (blocks everything, has a lead time)
2. Foundation — `_sms.js`, both tables, normalisation, opt-out, quiet hours,
   delivery callback, tests
3. Staff outbound — four messages via `notifyMatchingStaff` and the assign path
4. Staff inbound — webhook, signature verification, letter parsing, interest
5. Client outbound — `channel` column, five automation rules
6. Client inbound — logging plus forwarding to Joe

## Open items

- **Number choice** is a new 405 line; if recognition later matters more,
  porting the business number remains possible.
- **Noah Drews' contact record** needs a real email or explicit SMS-only
  handling, and his staff access code (`crisp-rocket-comet-76`) was exposed in a
  screenshot and should be regenerated.
- **Exact day counts** for the balance-due and review-link rules are Joe's call
  at configuration time, not baked into code.
