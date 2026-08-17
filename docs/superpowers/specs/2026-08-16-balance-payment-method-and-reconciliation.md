# Balance payment method, payment details, and reconciliation — design

**Date:** 2026-08-16
**Status:** decided by Joe except where marked open; not yet planned or implemented
**Ships after:** `docs/superpowers/plans/2026-08-16-balance-link-and-late-fee.md`

The client says how they intend to pay their balance when they pay their
deposit. We show them the details for that method, the post-gig report records
what actually arrived, and a weekly worklist catches what didn't.

## Why

Today a balance paid by anything other than a card is handled entirely by hand,
and nothing anywhere records how a client said they would pay. That means no
payment instructions go out, no one knows which balances to expect in which
account, and the only prompt to chase an unpaid balance is Joe remembering.

## What the client declares

Six options, on the finalisation page where they complete their details and pay
the deposit. Cash and check are split by *when*, because the two are verified by
completely different mechanisms — see "Who verifies what" below.

| Option | Client-facing label | Details shown when selected |
|---|---|---|
| `card` | Credit/debit card (+5% service fee) | We'll email a secure payment link |
| `venmo` | Venmo | `@Joe-Coover` |
| `cashapp` | Cash App | `$joecoover` |
| `cash_day` | Cash on the day | Hand it to your event staff |
| `check_day` | Check on the day | Payable to **Funky Monkey Events** |
| `check_mail` | Check by mail | Payable to **Funky Monkey Events**, 1200 NW 43rd St, Oklahoma City, OK 73118 |

Payment details supplied by Joe, 2026-08-16.

**This is the fee's disclosure point.** The card option carries "+5% service
fee" in its own label, so the client agrees to the fee at the moment they
choose, not when the balance link lands. That is what makes the fee clean —
see the "service fee, not a card surcharge" section of
`2026-08-16-balance-link-and-late-fee.md`.

It is a statement of intent, not a commitment. A client who says Venmo and then
asks for a card link gets one; the fee applies because they paid by link, not
because of what they picked.

## Where it is stored

A new column, `bookings.balance_method_intent`, holding one of the six keys
above or `''`.

**It must not reuse `payment_method`.** That column is the accounting record of
what actually happened — `accounting-export.js:57` treats
`payment_method`/`payment_amount`/`payment_ref` as the final-balance record, and
`booking.js:64`'s `paymentLogEntry` reads the pair to tell a recorded payment
from a cleared one. Writing an intention into it would put a payment on the
books that nobody made.

Captured through the existing client path: add the field to `CLIENT_EDITABLE`
in `_finalise.js`, and a select to `my-booking.html`. No new endpoint.

## Who verifies what

The declared method decides who checks it, and this is the whole reason the
options are split the way they are:

- **`card`** — verifies itself. `stripe-webhook.js` records the payment against
  the booking the moment it clears. Nothing to chase, ever.
- **`cash_day`, `check_day`** — answered by the post-gig report. Staff already
  submit "Balance Collected?" and "Amount Collected ($)" from
  `staff-portal.html:632` into `gig_logs.balance_collected` / `balance_amount`.
- **`venmo`, `cashapp`, `check_mail`** — the only ones with no automatic
  signal. These are what the weekly worklist is for.

## Post-gig report additions

The report already asks whether the balance was collected and how much. It is
missing two things:

1. **How** it was collected — same six-option list, so declared and actual can
   be compared.
2. **Tip amount.**

Both are new columns on `gig_logs`, two fields on the staff form, two entries in
the `submit_survey` field whitelist (`staff-assignments.js:551`), and two rows
in the owner notification email.

**What staff report is a report, not a payment.** It lands in `gig_logs` and
never writes `bookings.payment_*`. Joe confirms it in admin, which is the
existing pattern and the right one: the staff portal authenticates on a PIN, and
the booking's money columns are the accounting record.

## Tips

**Joe's decision, 2026-08-16.** A tip belongs to the staff who worked the gig.
It is recorded on the gig log, shown in the owner email, and paid out through
the payroll-adjustment flow that already exists at `admin.html:5776` ("positive
= bonus/tip"). No new payout path, and tips do not enter booking revenue or the
accounting export.

## Reconciliation — what is actually possible

**Joe asked for a weekly job that checks the payment methods' transactions and
only prompts a reminder for what it can't find. That cannot be built as stated,
for a reason worth recording so it isn't re-litigated:**

Stripe card payments already record themselves through the webhook. Personal
Venmo and Cash App accounts have no transaction API — Cash App only through
Square if the account is a Square business account; Venmo only through PayPal
for a Venmo-via-PayPal merchant account. Cash and checks have no API by
definition. So a transaction-checking job would automatically verify exactly the
payments that need no verification, and stay blind to every payment that does.

Three tiers, cheapest first:

**Stage 1 — the worklist (build this).** A weekly job listing events that have
passed with `balance_due > 0`, showing the declared method and what the post-gig
report said, with "record payment" and "send reminder" beside each row. No
dependencies, certain to work. `automations-scheduled.js` and
`payroll-scheduled.js` are the existing pattern for a scheduled function.
Everything below only removes rows from this list automatically.

**Stage 2 — forward the receipt emails in (open).** Venmo and Cash App email a
receipt for every payment received. A Gmail filter forwarding those to an
inbound-parse address gives a real transaction feed with no API agreement and no
OAuth. Mail already goes out through Resend (`_email.js:148`); whether inbound
parsing is available on the current Resend plan needs checking before this is
planned.

**Stage 3 — a bank feed (open).** Plaid would catch mailed checks and cash
deposits too. Real recurring cost. Only worth it if stages 1 and 2 leave enough
manual work to justify it — likely to be a handful of rows a week, so this is
deliberately deferred.

## What already exists and needs no work

- The post-gig report, its "Balance Collected?" and "Amount Collected" fields,
  and the owner notification email (`staff-assignments.js:532-600`).
- The payroll adjustment that pays a staff bonus or tip (`admin.html:5776`).
- The client-editable finalisation path and its whitelist (`_finalise.js`).
- Recording a received payment against a booking, and telling a recorded
  payment from a cleared one (`booking.js:58-76`).

## Open questions

- Does a `check_mail` balance need a "posted on" date so the worklist can wait a
  week before flagging it, or is the declared method enough context for Joe to
  judge?
- Should the worklist include bookings whose event has not happened yet but
  whose balance the client said they would send early?
- Stage 2 depends on Resend inbound parsing being available on the current plan.
