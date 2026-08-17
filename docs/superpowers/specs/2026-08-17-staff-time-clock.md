# Staff time clock — design

**Date:** 2026-08-17
**Status:** drafted overnight while Joe slept; **every decision below is mine and needs his yes or no**
**Author's note:** Joe asked for staff clock in/out with admin adjustments, the
existing checklist doubling as the clock, the 5-hour minimum still in force, and
freedom to add stages. He went to bed before I could ask anything, so this spec
makes the calls and flags each one. Nothing here is deployed.

## The short version

The clock already half-exists. `gig_logs` stamps `on_my_way_at`, `arrived_at` and
`completed_at` every time a staff member taps the day-of checklist
(`staff-assignments.js:893`). What is missing is a stage at each **end** — nobody
records starting to load, or getting home — and nothing feeds those timestamps
into pay.

So: add two stages, bracket the three that exist, and let payroll prefer the
measured span over its estimate when the record is complete.

## What pay does today

`payroll.js:317` builds every hour from an estimate — no measured time enters it:

```
totalMins  = load + drive + unload + party + pack + drive + homeUnload
rawHours   = totalMins / 60
totalHours = max(5, rawHours)          ← the 5-hour minimum
amount     = hourly ? totalHours × hourly_rate : flat_rate
```

`load`/`unload`/`pack`/`homeUnload` come from `staff_assignments`, falling back to
`service_time_templates`, falling back to hardcoded 30/15/20/15. `drive` is
derived from the event ZIP. `party` is the service's `duration_minutes`.

Note what that estimate spans: **from starting to load at base, to arriving home
and finishing unloading.** Any clock meant to replace it has to cover the same
ground, or actual and estimated hours are not comparable and pay changes for
reasons nobody intended.

## The five stages

| # | Stage | Meaning | Status |
|---|---|---|---|
| 1 | `clocked_in` | Started loading at base | **new** |
| 2 | `on_my_way` | Loaded, driving to the venue | exists |
| 3 | `arrived` | At the venue | exists |
| 4 | `completed` | Packed out, leaving the venue | exists |
| 5 | `clocked_out` | Home, unloaded, done | **new** |

**Worked time = `clocked_out` − `clocked_in`.** One subtraction.

The two new stages are not decoration — they are exactly the two ends the estimate
already pays for and the checklist never captured. And the intermediate stamps
then decompose the day into the same four segments the estimate uses:

| Segment | Measured as | Estimate's name |
|---|---|---|
| Loading | `on_my_way` − `clocked_in` | `load` |
| Drive out | `arrived` − `on_my_way` | `drive` |
| On site | `completed` − `arrived` | `unload + party + pack` |
| Drive back and unload | `clocked_out` − `completed` | `drive + homeUnload` |

That table is the whole reason to use these five and not some other five: every
segment has an estimate to compare against, so a template that is systematically
wrong becomes visible instead of just being paid.

**Decision — the post-gig report stays on `completed`.** Staff fill it in at the
venue while it's fresh, not after driving home. `clocked_out` is one tap after.

## What changes in pay, and what does not

**The 5-hour minimum is untouched.** `max(5, hours)` still wraps whatever number
comes out. A 90-minute gig still pays five hours.

**Actual replaces the estimate only when the record is complete and sane.**
Otherwise payroll keeps using today's estimate and says so. Concretely, actual
hours are used when all of:

- `clocked_in` and `clocked_out` are both present
- `clocked_out` is after `clocked_in`
- the span is at most **16 hours**

Anything else — a missing tap, a backwards pair, someone who forgot to clock out
until the next morning — falls back to the estimate and adds a line to the
existing payroll `warnings` array naming the staff member and the booking.

**Why fall back rather than pay the measured number:** a forgotten clock-out is
the likely failure, and its measured span is enormous. Paying it would quietly
overpay by hundreds of dollars, and a wrong-but-believable number in a money path
is this codebase's documented recurring failure (`silent-failure-bug-class`).
Falling back is wrong in the safe direction and it is loud.

**Flat-rate staff are unaffected in pay** — `amount` is `flat_rate` regardless of
hours — but their hours are still recorded, because Joe needs to know what a gig
actually costs in labour even when the pay is fixed.

## Admin adjustments

Joe's phrase was "clock in/out adjustments". This is where it lives:

- Any of the five timestamps is editable by an admin on the assignment card in
  `admin.html` (`renderAssignmentCard`, ~line 2206).
- Every edit writes a line to `booking_changes` through the existing `logChange`
  — who, which stage, from what to what. A wage record that can be silently
  rewritten is worth less than no record.
- Staff never edit a timestamp. They tap stages in real time; corrections are
  Joe's. That keeps the audit story simple: the portal is a witness, the admin is
  the editor.
- An adjusted log stays flagged as adjusted so a payroll run can show it.

## Ordering, and walking backwards

`buildChecklistTimestampClause()` already handles the hard part: stepping back
clears every later timestamp, so the stamps can never contradict the status. The
two new stages extend the same array and inherit that behaviour — `clocked_in`
at the front, `clocked_out` at the end.

One consequence worth stating: stepping back from `clocked_out` to `completed`
clears the clock-out, and payroll reverts to the estimate for that gig. Correct,
and the reason adjustments exist.

## What this does NOT do

- **No geofencing, no photo, no "are you really there" check.** The clock is a
  record of what staff say they did, exactly as the checklist is today.
- **No overtime, no breaks, no multi-day.** One gig, one span.
- **No change to how staff are paid** beyond the hours number. Rates, flat vs
  hourly, the payroll run and the payment records are untouched.
- **No retroactive pay.** Runs already generated are not recomputed.

## Open questions for Joe

1. **Is `clocked_in` the start of loading, or arriving at base?** I assumed the
   start of loading, because that is what the estimate's `load` pays for.
2. **Should a completed clock record ever *lower* pay below the estimate?** As
   specced, yes — actual wins when it is sane, whether higher or lower (the
   5-hour floor still catches short gigs). If you would rather never pay less
   than the estimate, that is `max(estimate, actual)` and one line.
3. **16 hours as the sanity cap** — a guess. What is the longest gig anyone has
   ever legitimately worked?
4. **Do you want the four segment comparisons surfaced anywhere?** They fall out
   of the data for free; a "template says 30 min to load, actual averages 47"
   view would pay for itself, but it is not in this build.
5. **Should `clocked_out` be required before a gig counts as done?** Right now
   `completed` is the end of the staff's obligations and triggers the report.

## Files this touches

| File | Change |
|---|---|
| `netlify/functions/staff-assignments.js` | `CHECKLIST_STATUSES` + `CHECKLIST_TS_COLS` gain two entries; two new `gig_logs` columns; an admin-only `adjust_clock` action |
| `netlify/functions/payroll.js` | join `gig_logs`, prefer a sane measured span, warn on every fallback |
| `staff-portal.html` | two more buttons in the day-of checklist |
| `admin.html` | editable timestamps + measured-vs-estimated on the assignment card |
| `test/` | the clock arithmetic and the fallback rules |
