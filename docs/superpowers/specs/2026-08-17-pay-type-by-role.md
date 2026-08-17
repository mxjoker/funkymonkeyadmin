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

**Revised 2026-08-17 after Joe's answer.** He wants the pay type on the **role
itself**, not on the (service, role) pair — *"having the role being assigned either
flat rate or hourly would handle this... I can always make a new role if I need to
to differentiate."* That is fewer rows and one fact per role: Foam Crew is hourly
everywhere, Professor Buckets is flat everywhere.

**The obstacle: roles are not stored anywhere.** `skillTags()`
(`admin.html:911`) derives the list at runtime from the hardcoded `SKILL_PRESETS`
array, unioned with every tag found on a staff record or a service slot.
`addSkillTag` only pushes onto that in-memory array — the comment above it records
that custom tags used to vanish on reload, and that the union is the workaround.
`tag_required` and `tag_filled` are bare `VARCHAR` strings. There is no role row.

**Do not build a role registry to answer a pay question.** One small table keyed by
role name, carrying only the pay decision, leaves tag handling exactly as it is:

```sql
CREATE TABLE IF NOT EXISTS role_pay (
  role_name  VARCHAR(100) PRIMARY KEY,
  pay_type   VARCHAR(20) NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
)
```

A role with no row has no opinion, which is today's behaviour.

**Resolution order in `payroll.js:388`**, which currently reads `a.pay_type`
straight off the staff record:

1. `role_pay.pay_type` for this assignment's `tag_filled`, when a row exists
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

## Answered 2026-08-17

1. **Main performer vs not** is a **role** distinction, not a service one. Joe
   will create a new role where he needs to differentiate. This is what moved
   `pay_type` from `staff_slots` to `role_pay`.
2. **No hourly rate on an hourly role must be an error, caught at assignment.**
   Joe believed this was already checked. It is not: `staff-assignments.js`
   contains no reference to `pay_type`, `hourly_rate` or `flat_rate`, so nothing
   validates a rate when someone is assigned. The only existing signal is the
   `$0` line-item warning at `payroll.js:396`, which fires after the week is over.
   **New requirement:** the assign action refuses — with a message naming the
   person and the missing rate — when the resolved pay type is hourly and the
   staff member's `hourly_rate` is 0 or null. Same rule for a flat role with no
   `flat_rate`. Joe can then fix the rate and assign again.
3. **The override lives on the assignment**, not the payroll line — it survives
   re-runs and reads as "this gig pays X". Taken as the default; not contested.

4. **Two roles on one booking pay once, at whichever resolution is higher.**
   Joe, 2026-08-17: *"whichever is higher pay, once not doubled. Rare cases can be
   resolved on a case by case basis if editing/altering the pay per event is easy
   to do."* So the per-gig override is not a nicety — it is the designated escape
   hatch for the cases this rule gets wrong, and it has to be obvious and quick to
   reach, not buried in a sub-panel.

## Background to that decision

**Stackable roles on one booking can double-pay hours, today.** Support roles stack on
   top of a performer (`STACKABLE_TAGS`, `admin.html:901`), and
   `staff_assignments` is unique on `(booking_id, staff_id, tag_filled)` — so one
   person filling two roles on one gig is two assignment rows, and `payroll.js`
   iterates assignments. The flat branch is protected: `amount = existingPayment
   .length > 0 ? null : flat_rate` (`payroll.js:393`) pays the second row nothing.
   **The hourly branch has no such guard** (`payroll.js:391`) — it computes
   `hours × rate` on every row, so today someone hourly on two roles at one gig is
   paid the full span twice. Per-role pay types make that combination far more
   likely, because one role can now be hourly while the other is flat. This is a
   pre-existing defect that this change would promote from rare to routine, and it
   should be fixed in the same pass: hours for one person on one booking must be
   paid once.

## Files this touches

| File | Change |
|---|---|
| `netlify/functions/staff-assignments.js` | `pay_type` column on `staff_slots`; `save_service_slots` accepts and stores it |
| `netlify/functions/payroll.js` | join `staff_slots`, resolve type slot-first, honour `pay_amount_override` |
| `admin.html` | pay-type select in the slot editor row; override input on the assignment card |
| `test/` | the resolution order, and that a NULL slot type reproduces today's behaviour exactly |
