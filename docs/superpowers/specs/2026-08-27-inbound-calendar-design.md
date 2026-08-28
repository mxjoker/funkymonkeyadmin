# Inbound calendar — design

**Date:** 2026-08-27
**Status:** approved, ready for implementation planning

## Why

`calendar.js` publishes an ICS feed *out*. Its header explains the choice well —
no OAuth, no stored refresh token, no third-party grant to revoke, one URL to
rotate if it leaks — and that reasoning still holds.

The consequence is that the CRM can only ever see gigs it created itself. A
dentist appointment, a school run, a family trip, a gig taken through someone
else: all invisible. So the conflict question Joe actually asks — *"am I free
that Saturday?"* — cannot be answered by the system that is supposed to answer
it.

This design adds the mirror image: a read-only inbound subscription to one or
more personal calendars, and a single availability check that both the admin UI
and the roadmap's Instant Booking gate consume.

Two consumers, one rule. `docs/ROADMAP.md:157` already specifies an availability
gate for Instant Booking v2 — *"no conflicting confirmed/pending booking on the
calendar"*. That is the same computation, and it is built once here.

## Approach

**Scheduled pull into a cache table, with a manual refresh.**

Rejected alternatives:

- **Live fetch per request.** Puts a third-party outage in the path of the
  booking modal, adds seconds of latency to every open, and is untenable for a
  public Instant Book gate that strangers would use to hammer Joe's personal
  calendar.
- **A recurrence library (`node-ical`).** The repo has two dependencies (`pg`,
  `pdf-lib`) and tests on `node --test`. Trading ~180 readable lines for a few
  thousand unread ones is the wrong side of that trade when the feeds are Joe's
  own two or three, from Google or Apple, whose ICS output is predictable — and
  when unparseable input is designed to produce a visible false positive rather
  than a silent miss.

Polling alone has one real failure: staleness at the worst moment — a date
blocked out twenty minutes ago while a client is on the phone. A manual refresh
endpoint costs almost nothing and removes it, which lets the schedule stay
unhurried at hourly.

## Schema

Created via the `ensureTables` pattern used across the repo.

### `calendar_feeds`

```
id                SERIAL PRIMARY KEY
label             TEXT NOT NULL      -- "Joe personal", "Family shared"
url               TEXT NOT NULL      -- the secret ICS address
active            BOOLEAN DEFAULT TRUE
last_synced_at    TIMESTAMPTZ
last_status       TEXT               -- 'ok' | 'error'
last_error        TEXT
last_event_count  INTEGER
last_warnings     JSONB DEFAULT '[]'
created_at        TIMESTAMPTZ DEFAULT NOW()
```

`last_status`, `last_error`, `last_event_count` and `last_warnings` exist so a
feed that quietly stops working is visible. A rotated Google URL must read as a
broken feed in settings, never as an empty calendar that reports Joe free.

**The URL is a credential.** Anyone holding it can read the calendar
indefinitely. Therefore:

- the API never returns it in full — the settings UI shows it masked;
- the only write operation is replace. A new URL is pasted in; the old one is
  never read back out.

### `external_busy`

```
id          SERIAL PRIMARY KEY
feed_id     INTEGER REFERENCES calendar_feeds(id) ON DELETE CASCADE
starts_at   TIMESTAMPTZ NOT NULL
ends_at     TIMESTAMPTZ NOT NULL
all_day     BOOLEAN DEFAULT FALSE
summary     TEXT               -- admin-only; never leaves via a public path
uid         TEXT               -- debugging only, not a dedupe key
synced_at   TIMESTAMPTZ DEFAULT NOW()
```

```
CREATE INDEX idx_busy_range ON external_busy (starts_at, ends_at);
```

Decisions:

- **Absolute instants, not wall-clock.** `TIMESTAMPTZ`, with `TZID` resolved at
  parse time. This is the mirror of the note in `calendar.js` about Netlify
  running UTC while a laptop does not: outbound must *avoid* shifting, inbound
  must *deliberately* shift, once, at the boundary. All-day entries become local
  midnight-to-midnight in `America/Chicago`.
- **Sync replaces a feed's rows wholesale**, in a transaction, rather than
  diffing by `UID` — which is why `uid` is not a dedupe key. Diffing would drag
  in `RECURRENCE-ID` overrides, tombstones and stale-row pruning; deleting and
  reinserting a few hundred rows is correct by construction and materially
  shorter.
- **Rolling window: today − 7 days to today + 18 months.** Gigs are booked a
  year out, so twelve months is not enough. The week of history keeps a conflict
  on a gig that has just happened from vanishing mid-review.

Deliberately not stored: attendees, locations, descriptions (the most sensitive
part of a personal calendar, and unnecessary here), and any notion of event
type.

## Components

| File | Responsibility |
|---|---|
| `netlify/functions/_ics.js` | Pure parser. String in, busy periods out. No I/O. |
| `netlify/functions/_schedule.js` | Working-span math, extracted from `autoCalcTimes`. |
| `netlify/functions/_availability.js` | The conflict check. Two projections. |
| `netlify/functions/calendar-feeds.js` | Admin CRUD + refresh action. |
| `netlify/functions/calendar-sync.js` | Scheduled function. |

`calendar.js` is not modified. It is 302 focused lines doing one thing outbound;
adding inbound would cost that clarity for no gain.

### `_ics.js`

Unfolds continuation lines (the mirror of `fold()` in `calendar.js`), splits
`VEVENT` blocks, reads `UID`, `DTSTART`, `DTEND`/`DURATION`, `SUMMARY`, `RRULE`,
`EXDATE`, `STATUS`, `TRANSP`.

**Timezones without a dependency.** `DTSTART` arrives in four shapes:
`VALUE=DATE`, a `Z`-suffixed UTC instant, `TZID=<zone>:<wall clock>`, or
floating (treated as `America/Chicago`). Wall-clock plus IANA zone is converted
to an instant using `Intl.DateTimeFormat`, which is stdlib and knows every zone:
format a guessed instant back into the target zone, diff against the wall-clock
wanted, correct, repeat once to settle DST boundaries. ~25 lines, and it handles
a calendar in any zone rather than assuming Central.

**Filters.** `STATUS:CANCELLED` is skipped — a cancelled event is not busy.
`TRANSP:TRANSPARENT` is skipped — that is what Google sets for "Free", so it
becomes a way to tell the CRM to ignore an entry without deleting it.

**Recurrence.** Supported: `FREQ` daily/weekly/monthly/yearly, `INTERVAL`,
`COUNT`, `UNTIL`, `BYDAY`, and `EXDATE` exclusions. Expansion is capped at the
window end. This covers effectively every recurrence a personal calendar
contains.

For a rule outside that subset: **store the first instance and raise a named
warning on the feed** — *"the recurring event 'X' in Personal couldn't be
expanded"*. The warning propagates to the conflict panel, where it would be
acted on, not to a log nobody reads. Silence is not an option here; a silently
dropped recurring commitment is precisely the failure this design exists to
prevent.

**Known limitation.** A meeting invitation Joe has declined still appears in the
feed and will register as busy. Detecting it requires matching
`ATTENDEE;PARTSTAT=DECLINED` against his own address, which needs configuration
not otherwise required. Deferred: the failure is a visible false positive, which
is the safe direction.

### `calendar-sync.js`

Scheduled hourly at `17 * * * *` — offset off the hour rather than queuing with
everything else's cron. Registered in `netlify.toml` alongside
`payroll-scheduled` and `automations-scheduled`.

Global `fetch` (Node 18+, no dependency), a 10-second `AbortController` timeout,
and a 5 MB ceiling so one runaway feed cannot take the run down.

Per feed: fetch, parse, then **delete and reinsert that feed's rows in a single
transaction**. Feeds are independent; one failing never blocks another.

`calendar-feeds.js` exposes the same sync as an admin-only POST action — the
"refresh now" button.

### Failure handling

The most important section, given the silent-failure class this codebase has
been clearing out.

- **A failing feed keeps its existing rows.** It records `last_status='error'`
  and the message; nothing is deleted. Stale busy data is far better than an
  empty calendar reporting Joe free.
- **Staleness is a first-class output, not a log line.** `_availability` returns
  `degraded: true` with reasons whenever any active feed has errored or has not
  synced in over 25 hours. The UI always renders it.
- **There is no path where a broken or never-synced feed yields a confident "no
  conflicts."** That is the same shape as `getDriveMins` returning `30` for an
  unknown ZIP, and avoiding it is the point of the design.

## `_schedule.js` — extraction, with one restraint

`spanFor(client, booking, overrides)` returns the working window computed from a
booking row alone:

```
{ startsAt, endsAt, totalMinutes, driveMinutes, windowKnown, unknowns[] }
```

It reads service duration and the time template exactly as `autoCalcTimes` does
today. `autoCalcTimes` becomes a caller, passing the assignment's own overrides.
This is what makes the check work on a brand-new booking with nobody assigned —
which is precisely when "am I free?" is asked, and precisely when the current
persisted `schedule_start` is null.

When `event_time` is null, `windowKnown` is `false` with a reason. Callers must
handle it; there is no default window.

**The restraint.** `getDriveMins` moves into this file and its `return 30`
fallback is **not** changed here. That number feeds `total_minutes`, which feeds
payroll's estimate path and its 5-hour floor. Deciding what payroll should do
with an unknown drive is a money-path decision that deserves its own thought,
not a side effect of a calendar feature. It gains only a second return value,
`zipKnown`, so the conflict panel can say "drive time estimated — ZIP not in the
table" without altering a single payroll figure.

**BUG-1 (the silent 30-minute fallback) remains its own task.**

Before the extraction: a pinning test capturing the current arithmetic exactly,
so the refactor is provably behaviour-preserving. Same pattern already used to
pin the stage array across three files.

## `_availability.js` — one computation, two projections

`conflictsFor(...)` returns the admin view:

```
{
  window: { startsAt, endsAt } | null,
  windowKnown: boolean,
  external: [ { feedLabel, summary, startsAt, endsAt, allDay } ],
  bookings: [ { id, reference, clientName, startsAt, endsAt, status, tier } ],
  degraded: boolean,
  degradedReasons: string[],
  warnings: string[]
}
```

Clashing **FME bookings are included** — "am I already booked?" includes Joe's
own gigs, which the modal cannot answer today either. Two tiers:

- **hard** — `accepted`, `confirmed`, `completed`
- **soft** — `quoted`, or a dated `draft`

Both shown, labelled differently: a quote is not a commitment, but it is still
worth knowing about.

`publicAvailability(...)` returns `{ available, degraded }` and nothing else —
no summaries, no feed labels, no client names. This is what the Instant Booking
gate imports.

Rules in the core:

- **Half-open intervals `[start, end)`.** A gig ending at 15:00 and an
  appointment starting at 15:00 do not clash. Getting this wrong generates the
  false positive that teaches Joe to ignore the warning.
- **All-day entries block their whole local day**, resolved in
  `America/Chicago`.
- **The public path fails closed.** If `degraded` is true, `publicAvailability`
  returns `available: false`. A stranger must never instant-book a slot the
  system is not certain about. The admin path does the opposite: it shows
  everything it knows plus the degraded banner, because Joe can judge.

## Surfaces

**The booking pop-up (`openBooking` in `admin.html`).** A panel beside the date
field, refetched whenever date, time, ZIP or service changes, excluding the
booking being edited. Either *"Clear — nothing else on Sat 12 Oct"*, or the
overlapping items with times and sources. It renders "clear" only when
`degraded` is false; otherwise it states what it does not know.

**The save warning.** Submitting with a hard conflict raises a confirm naming
what clashes. It does **not** block — double-booking is sometimes deliberate,
when two teams are out. On override it writes a line via `booking-changelog.js`,
so a deliberate double-booking is a recorded decision rather than a mystery six
weeks later.

**Settings.** The feeds list: label, masked URL, last synced, status, parser
warnings, plus Add / Replace / Delete and Refresh Now.

**Instant Booking gate.** `publicAvailability` and its tests exist; there is no
UI to wire until v2 is built.

Explicitly out of scope: rendering busy blocks on the admin month calendar grid.

## Testing

`node --test`, no framework, matching existing practice.

- `test/ics-parse.test.js` — pure, fixture strings, no DB or network: a `TZID`
  event; a UTC event; an all-day event; an event spanning the 1 Nov 2026
  fall-back; a weekly rule with `EXDATE`; `COUNT` and `UNTIL` termination; a
  cancelled event; a transparent event; folded lines; an unsupported rule
  producing a warning.
- `test/schedule-span.test.js` — pins the current span arithmetic through the
  extraction.
- `test/availability.test.js` — touching intervals do not clash; overlapping
  ones do; all-day blocks the day; self is excluded; hard versus soft tiers;
  and, most importantly, **a stale or errored feed never yields "clear", and
  fails closed on the public path.**

## Open questions

None blocking. Two noted for later:

1. Declined invitations register as busy (above).
2. Whether the month calendar grid should eventually render busy blocks — out
   of scope by decision, not oversight.
