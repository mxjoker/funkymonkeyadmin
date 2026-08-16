# Balance link and late-payment service fee — design

**Date:** 2026-08-16
**Status:** approved by Joe, not yet implemented

A payment link for the balance owed after an event, carrying a 5% service fee,
plus clearer labelling on the deposit link that already exists.

## Why

Today the only payment link this system can create is the deposit. Anyone
paying their balance after the event is handled by hand. And the deposit button
is labelled generically, so there is no way to tell from the button what it is
about to charge.

## The rule, and why it is one rule rather than three

Joe described three cases: no fee on the deposit, 5% on the balance, and 5% on
the whole amount when no deposit was taken.

Those collapse into **one** formula, because of how balance is already derived
(`_items.js:151`):

```
balance_due = max(0, total_price + mileage_cost - deposit_amount)
```

With no deposit, `deposit_amount` is 0 and `balance_due` **is** the entire
amount. So:

> **The service fee is 5% of `balance_due`. Money paid before the event carries
> no fee; money paid after it does.**

No special case for the no-deposit booking. It falls out of the arithmetic.

## It is a service fee, not a card surcharge

**Joe's decision, 2026-08-16.** The 5% applies to any balance paid after the
event, whatever the method — card, check, Venmo, cash.

This matters beyond wording. A card-only surcharge falls under Visa and
Mastercard rules: it may not exceed the actual cost of acceptance, must be
disclosed before payment, and requires acquirer notification. Stripe costs
about 2.9% + 30¢, so a 5% card surcharge would exceed cost of acceptance and
attract those rules. A fee applied to every payment method is a pricing
decision and attracts none of them.

Practically it also points the incentive the right way: it rewards paying on
time rather than penalising paying by card.

## What the client sees

**Joe's decision, 2026-08-16.** Itemised, never a single blended figure:

```
Balance                 $400.00
Late payment fee (5%)    $20.00
Total due               $420.00
```

Shown that way in the email and on the Stripe checkout page. A client who
checks the arithmetic against their quote must be able to see where the
difference came from.

## The invariant this must not break

`_items.js:151` defines `balance_due` as `total + mileage - deposit`, and
`booking.js:269` refuses to recompute a balance that does not match that
derivation — the comment says why: *"This booking's balance was settled
out-of-band. Recomputing would re-bill a customer who has already paid."*

**So the fee must never be written into `balance_due`.** Doing so would make
the stored balance permanently un-derivable, trip that guard on every
subsequent edit, and leave the booking unable to have its balance recomputed
ever again.

The fee is computed **at link-creation time** from `balance_due`, and lives on
the Stripe session and in the email. If it needs to be recorded, it belongs in
its own column, never folded into the balance.

## Scope

1. **Relabel the deposit button** to carry its amount — "Send $100 deposit
   link" — so the button says what it will charge. It already emails the client
   via `create-stripe-link.js`; no change needed there.

2. **A balance link.** `create-stripe-link.js` already takes an `amount`, so
   the endpoint needs a second line item for the fee rather than a new
   endpoint. A new admin button — "Send $420 balance link" — computes
   `balance_due` plus 5%, creates the session with both lines itemised, and
   emails the client.

3. **The balance email.** New copy, distinct from the deposit email, stating
   the balance, the fee, and the total, with the link.

4. **`stripe_payment_link` currently holds one link.** The deposit link and a
   balance link cannot both live in that column. Decide whether the balance
   link gets its own column or whether the column becomes the *current*
   outstanding link. The finalisation page reads this column, so whichever way
   it goes must not leave that page pointing at a paid deposit.

## Open questions for implementation

- **Where does the fee percentage live?** A constant is simplest and this
  codebase prefers that, but a booking Joe wants to waive it on would then need
  code. A nullable column defaulting to 5% is the alternative.
- **Should a $0 balance offer a link at all?** It should not — the same shape
  as the existing `depositAmount > 0` guard.
- **Does the fee apply to a balance paid *before* the event?** By the rule as
  stated, no — the trigger is the event date having passed, not the payment
  being a balance. The implementation needs a date comparison, not just a
  balance check.

## What already holds and needs no work

- Every payment link already goes out with an email. The deposit button emails
  via `create-stripe-link.js:96`; the finalisation button sends its own and
  suppresses the built-in one so a client gets one email rather than two.
- `create-stripe-link.js` is admin-only (`requireAuth(['admin'])`) and must
  stay so. No public endpoint may mint a Stripe session.
- As of `2e478ab`, `create-stripe-link.js` persists the link it creates, so a
  balance link will survive a page reload.

## Related, unfixed

`admin.html:2750`'s existing `sendStripeLink()` does
`Number(b.deposit_amount) || 100`. A school or library booking with a
deliberate $0 deposit gets a **$100** Stripe demand. `booking.js:348` guards
this correctly on the backend; the button does not. Pre-existing, one
character, wants its own commit — and it should be fixed in the same pass as
the relabel, since the relabel would otherwise print "Send $100 deposit link"
on a booking that owes nothing.
