# Pay type by role — design

**Date:** 2026-08-17
**Status:** decisions from Joe 2026-08-17; not yet planned or implemented
**Depends on:** the time clock, merged `8762701`

The same person is hourly on a foam party and per-event on story doodles. Today
pay type lives on the person, so they can only be one or the other.

## What Joe said

> "I have staff that are hourly for foam parties and pay per event for story
> doodles. it is dependent on the event if they are the main performer or not."
>
> "the flat rate is dependent on who works it more than what it is... it would be
> easiest if any flat rates were defaulted to that persons rate but easily edited."

Two separate facts, and keeping them separate is what makes this small:

- **Pay type** — hourly or flat — is a property of the **role on a service**.
- **The rate** is a property of the **person**.

So there is no rates matrix. One field moves.

## Where it goes

`staff_slots` already exists and is already exactly one row per (service, role):

```sql
staff_slots (id, service_id, tag_required, slot_count, exclusive, sort_order)
```

Add one nullable column:

```sql
ALTER TABLE staff_slots ADD COLUMN IF NOT EXISTS pay_type VARCHAR(20)
```

`NULL` means "no opinion — use the staff member's own setting", which is today's
behaviour. Nothing changes until a slot is given a value.

**Resolution order in `payroll.js:388`**, which currently reads `a.pay_type`
straight off the staff record:

1. `staff_slots.pay_type` for this booking's `service_id` and this assignment's
   `tag_filled`, when set
2. otherwise `staff.pay_type`, exactly as now

The rate is unchanged in both cases: `staff.hourly_rate` for hourly,
`staff.flat_rate` for flat.

## "Easily edited"

A flat rate defaults to the person's `flat_rate`, but a given gig sometimes pays
something else — a longer show, a favour, a stand-in.

Add one nullable column to the assignment:

```sql
ALTER TABLE staff_assignments ADD COLUMN IF NOT EXISTS pay_amount_override NUMERIC(10,2)
```

When set, it is the amount for that gig, whatever the type says. It appears on the
assignment card in admin beside the clock block, blank by default with the
resolved amount as placeholder text, so Joe can see what it would pay and type
over it.

**It must be logged.** An override is a manual change to a wage, so it goes to
`booking_changes` through `logChange` with both sides, the same as a clock
adjustment.

## What the seeding changes — read this before running it

Joe confirmed, 2026-08-17:

- **Flat:** performance shows, professor buckets, story doodles, balloon
  twisting, magic shows
- **Hourly:** foam parties

**Seeding these values changes what real people are paid**, and that is the whole
point — someone whose staff record says `hourly` but who does story doodles will
move to flat, which is the bug being fixed. But it means the seed is not a safe
no-op migration and must not be treated as one.

**Required before any seeded value is live:** run a payroll preflight over a
recent week before and after seeding, and compare line by line. Every difference
must be one Joe recognises as the correction he asked for. The preflight writes
nothing, so this is free to run as many times as needed.

The service IDs to seed against come from the **live `services` table, not
`DEFAULT_SERVICES` in `services.js`** — the catalogue in the database has drifted
from that seed before (see the `catalogue-prices-live-not-seed` memory). Read the
real list first.

## What this does not do

- **No per-person-per-role rates.** Joe's answer rules them out: the rate follows
  the person. If that ever changes, it is a new table, not a widened column.
- **No change to hours.** The time clock decides hours; this decides only which
  of the two rates is applied to them.
- **No retroactive recalculation.** Payroll runs already generated are untouched.
- **No new UI surface.** The slot editor at `admin.html:4532` already renders a
  row per (service, role) with a tag select and a count; pay type is one more
  select in that row.

## Open questions

1. **What should a slot's pay type do when the person has no matching rate?** An
   hourly slot filled by someone whose `hourly_rate` is 0 currently produces a $0
   line item and a warning. Should it fall back to their flat rate instead, or
   stay a loud $0?
2. **Is "main performer vs not" a distinct role, or a distinct service?** Joe's
   phrasing — "dependent on the event if they are the main performer or not" —
   suggests a booking where one person is flat and another hourly on the *same*
   service. That works if the two are different `tag_required` values on the
   slot; it does not if both fill the same role. Worth confirming against a real
   booking before building.
3. **Should the override live on the assignment or on the payroll line?** On the
   assignment it survives re-runs and reads as "this gig pays X". On the payroll
   line it is a per-run correction. The assignment is proposed here.

## Files this touches

| File | Change |
|---|---|
| `netlify/functions/staff-assignments.js` | `pay_type` column on `staff_slots`; `save_service_slots` accepts and stores it |
| `netlify/functions/payroll.js` | join `staff_slots`, resolve type slot-first, honour `pay_amount_override` |
| `admin.html` | pay-type select in the slot editor row; override input on the assignment card |
| `test/` | the resolution order, and that a NULL slot type reproduces today's behaviour exactly |
