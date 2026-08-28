// A parser for the ICS feeds Joe subscribes to. Pure: a string in, busy periods
// out, no I/O and no database.
//
// The escaping and folding rules here are the inverse of esc() and fold() in
// calendar.js. RFC 5545 is unforgiving in both directions — a feed that is
// mis-unfolded produces silently wrong summaries rather than an error.
//
// Everything this file cannot understand becomes a WARNING, never a silent
// omission. A dropped event is a gig double-booked.

const { zonedToInstant, dayBoundsInZone } = require('./_tz');

// Continuation lines begin with a space or tab and belong to the line above.
function unfold(text) {
  return String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n[ \t]/g, '').split('\n');
}

// RFC 5545 unescaping must be a single left-to-right scan, not sequential
// global replaces — two passes let a backslash freed by the first pass pair
// with a character from a different original escape (a literal `\` followed
// by the letter `n` would wrongly collapse into a newline).
function unescapeText(v) {
  const s = String(v);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) {
      const next = s[i + 1];
      out += next === 'n' || next === 'N' ? '\n' : next;
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

// "DTSTART;TZID=America/Chicago:20260912T140000" -> name, params, value
function parseLine(line) {
  const colon = line.indexOf(':');
  if (colon === -1) return null;
  const left = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const [name, ...paramParts] = left.split(';');
  const params = {};
  for (const p of paramParts) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name: name.toUpperCase(), params, value };
}

// The three forms a date-time arrives in, plus VALUE=DATE.
function toInstant({ params, value }, tz) {
  if (params.VALUE === 'DATE' || /^\d{8}$/.test(value)) {
    const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
    return { at: dayBoundsInZone(iso, tz).start, allDay: true, isoDate: iso };
  }
  const m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
  if (!m) return null;
  const [, Y, Mo, D, h, mi, s, z] = m;
  if (z) return { at: new Date(Date.UTC(+Y, +Mo - 1, +D, +h, +mi, +s)), allDay: false };
  // No Z: either TZID-qualified or floating. Floating is read as the local zone,
  // which is what every calendar client does.
  return { at: zonedToInstant(+Y, +Mo, +D, +h, +mi, params.TZID || tz), allDay: false };
}

// PT90M, PT1H30M, P1D — enough of ISO 8601 for calendar durations.
function durationMs(v) {
  const m = String(v).match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return null;
  return ((+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0)) * 1000;
}

// SUMMARY if present, else UID, else a plain label — used only for naming an
// event in a warning, never for the event's own summary field.
function labelFor(props) {
  if (props.SUMMARY) return unescapeText(props.SUMMARY.value);
  if (props.UID) return props.UID.value;
  return 'an untitled event';
}

// A VEVENT that never got its END:VEVENT — a truncated feed download, or a
// BEGIN:VEVENT arriving before the previous one closed. Fail toward flagging,
// never toward silence: warn by name, then still try to recover it through
// finishEvent (which will itself skip-and-warn if it has no usable DTSTART).
// A truncated feed over-reports busy time rather than under-reporting it.
function closeUnterminated(cur, opts, events, warnings) {
  warnings.push(`"${labelFor(cur.props)}" was never closed (missing END:VEVENT) and was recovered rather than dropped`);
  finishEvent(cur, opts, events, warnings);
}

function parseIcs(text, { windowStart, windowEnd, tz }) {
  const lines = unfold(text);
  const opts = { windowStart, windowEnd, tz };
  const events = [];
  const warnings = [];
  let cur = null;

  for (const raw of lines) {
    if (/^BEGIN:VEVENT\s*$/i.test(raw)) {
      if (cur) closeUnterminated(cur, opts, events, warnings);
      cur = { props: {} };
      continue;
    }
    if (/^END:VEVENT\s*$/i.test(raw)) {
      if (cur) finishEvent(cur, opts, events, warnings);
      cur = null; continue;
    }
    if (!cur) continue;
    const p = parseLine(raw);
    if (!p) continue;
    if (p.name === 'EXDATE') (cur.props.EXDATE ||= []).push(p);
    else cur.props[p.name] = p;
  }
  if (cur) closeUnterminated(cur, opts, events, warnings);

  events.sort((a, b) => a.startsAt - b.startsAt);
  return { events, warnings };
}

const DAY_CODES = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
// Every part below is gated to the FREQ(s) it actually changes the outcome
// for — membership here is necessary but not sufficient. A part that is
// waved through by this set but ignored by expandRrule for the FREQ it
// arrived on would expand a rule wrongly and silently, which is the one
// failure this file exists to prevent. See the per-part gates in parseRrule.
const SUPPORTED_RRULE_PARTS = new Set(['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'BYDAY', 'WKST', 'BYMONTHDAY', 'BYMONTH']);
const MAX_OCCURRENCES = 1000; // a hard stop, independent of the window — a malformed feed cannot spin.

function parseRrule(value) {
  const parts = {};
  for (const bit of String(value).split(';')) {
    const eq = bit.indexOf('=');
    if (eq > 0) parts[bit.slice(0, eq).toUpperCase()] = bit.slice(eq + 1);
  }
  const unsupported = Object.keys(parts).filter(k => !SUPPORTED_RRULE_PARTS.has(k));
  // A missing or unrecognised FREQ is not one of the "extra part" cases above
  // (there may be no extra parts at all) but it is just as unexpandable, and
  // silently keeping one occurrence with no warning is the exact bug this
  // file exists to prevent.
  const freq = String(parts.FREQ || '').toUpperCase();
  if (!/^(DAILY|WEEKLY|MONTHLY|YEARLY)$/.test(freq)) {
    unsupported.push('FREQ');
  }
  const interval = Math.max(1, Number(parts.INTERVAL || 1));

  // WKST only changes anything when WEEKLY has both INTERVAL > 1 and a BYDAY
  // spanning the week boundary — it decides which days fall in a skipped
  // week. Everywhere else (including every FREQ=WEEKLY;INTERVAL=1 rule,
  // which is most of them — Google emits WKST on every weekly rule) it is
  // decorative, so only reject it in the one case where ignoring it would
  // silently change the result.
  if (parts.WKST && freq === 'WEEKLY' && interval > 1) {
    unsupported.push('WKST');
  }

  // BYDAY applies to WEEKLY, MONTHLY and YEARLY. On WEEKLY, an entry is
  // always a bare weekday (MO, TU, ...) — an ordinal prefix there (1MO)
  // is meaningless and genuinely unsupported. On MONTHLY/YEARLY, an ordinal
  // prefix picks the Nth occurrence in the month (1FR = first Friday, -1FR
  // = last) and a bare entry means every matching weekday in the period;
  // expandRrule honours both. On DAILY, BYDAY changes nothing expandRrule
  // reads and is unsupported outright — same failure class as WKST above,
  // caught the same way: gate support on the FREQ it actually applies to.
  if (parts.BYDAY) {
    const entries = String(parts.BYDAY).split(',').map(d => d.trim().toUpperCase());
    if (freq === 'DAILY') unsupported.push('BYDAY');
    else if (freq === 'WEEKLY' && entries.some(e => /^[+-]?\d/.test(e))) unsupported.push('BYDAY');
  }

  // BYMONTHDAY (a day-of-month, negative counting from the end) applies to
  // MONTHLY and YEARLY.
  if (parts.BYMONTHDAY && freq !== 'MONTHLY' && freq !== 'YEARLY') {
    unsupported.push('BYMONTHDAY');
  }

  // BYMONTH filters which months an occurrence may fall in. Only YEARLY is
  // implemented (the real case: annual events) and tested here — Google's
  // MONTHLY UI option never emits it, so leaving MONTHLY+BYMONTH unsupported
  // costs nothing and keeps expandRrule from having to reason about a month
  // filter racing against its own month-stepping cursor.
  if (parts.BYMONTH && freq !== 'YEARLY') {
    unsupported.push('BYMONTH');
  }

  return { parts, unsupported };
}

// Day-of-month numbers (1-based, ascending) satisfying BYDAY (bare or
// ordinal-prefixed) or BYMONTHDAY within ONE calendar month. BYDAY takes
// precedence when both are given — Google's UI never emits both together on
// the same rule, and combining them per RFC 5545's intersection/union rules
// is real work for a case this file will never see.
// ponytail: returns null (not []) when neither is given, so the caller can
// fall back to DTSTART's own day-of-month for a plain "same day every
// month/year" rule — a real state, not an empty result.
function daysInPeriodMonth(year, month /* 1-based */, byDayOrdinal, byMonthDay) {
  const lastDom = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (byDayOrdinal) {
    const out = new Set();
    for (const entry of byDayOrdinal) {
      const m = /^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/.exec(entry);
      if (!m) continue;
      const dow = DAY_CODES[m[2]];
      const ord = m[1] ? Number(m[1]) : null;
      const matches = [];
      for (let d = 1; d <= lastDom; d++) {
        if (new Date(Date.UTC(year, month - 1, d)).getUTCDay() === dow) matches.push(d);
      }
      if (ord == null) matches.forEach(d => out.add(d));
      else if (ord > 0 && matches[ord - 1] != null) out.add(matches[ord - 1]);
      else if (ord < 0 && matches[matches.length + ord] != null) out.add(matches[matches.length + ord]);
    }
    return Array.from(out).sort((a, b) => a - b);
  }
  if (byMonthDay) {
    const out = new Set();
    for (const n of byMonthDay) {
      const day = n > 0 ? n : lastDom + n + 1;
      if (day >= 1 && day <= lastDom) out.add(day);
    }
    return Array.from(out).sort((a, b) => a - b);
  }
  return null;
}

// One period's occurrence instants for MONTHLY/YEARLY. `cursor` carries the
// period's year (and, absent BYMONTH, its month/day too — the plain
// "same day every month/year" case). BYMONTH (YEARLY only) picks which
// month(s) of that year are in play; each is expanded independently and the
// results are date-ordered since months don't overlap.
function monthlyOrYearlyCandidates(cursor, byDayOrdinal, byMonthDay, byMonth, H, Mi, tz) {
  const year = cursor.getUTCFullYear();
  const months = byMonth ? byMonth.slice().sort((a, b) => a - b) : [cursor.getUTCMonth() + 1];
  const out = [];
  for (const month of months) {
    const days = daysInPeriodMonth(year, month, byDayOrdinal, byMonthDay) || [cursor.getUTCDate()];
    for (const d of days) out.push(zonedToInstant(year, month, d, H, Mi, tz));
  }
  return out.sort((a, b) => a - b);
}

// Occurrence starts, as instants. BYDAY/BYMONTHDAY/BYMONTH are each read only
// on the FREQ they are gated to (see parseRrule); any other combination is a
// pattern we do not support, and parseRrule has already flagged it.
//
// Each occurrence is re-derived through zonedToInstant from wall-clock
// Y/M/D/H/Mi rather than by adding multiples of 24h, so a 3pm weekly event
// stays at 3pm across a DST boundary instead of drifting to 2pm.
function expandRrule(startAt, parts, windowEnd, tz) {
  const freq = String(parts.FREQ || '').toUpperCase();
  const interval = Math.max(1, Number(parts.INTERVAL || 1));
  const count = parts.COUNT ? Number(parts.COUNT) : null;
  const until = parts.UNTIL ? toInstant({ params: {}, value: parts.UNTIL }, tz)?.at : null;
  const hardEnd = until && until < windowEnd ? until : windowEnd;

  const byDay = (freq === 'WEEKLY' && parts.BYDAY)
    ? String(parts.BYDAY).split(',').map(d => DAY_CODES[d.trim().toUpperCase()]).filter(n => n != null)
    : null;

  // MONTHLY/YEARLY BYDAY keeps its ordinal prefix (1FR, -1SA) — resolved per
  // calendar month by daysInPeriodMonth, not collapsed to a day-of-week set
  // the way WEEKLY's byDay is.
  const byDayOrdinal = ((freq === 'MONTHLY' || freq === 'YEARLY') && parts.BYDAY)
    ? String(parts.BYDAY).split(',').map(d => d.trim().toUpperCase())
    : null;

  const byMonthDay = parts.BYMONTHDAY
    ? String(parts.BYMONTHDAY).split(',').map(Number).filter(n => Number.isFinite(n) && n !== 0)
    : null;

  const byMonth = (freq === 'YEARLY' && parts.BYMONTH)
    ? String(parts.BYMONTH).split(',').map(Number).filter(n => Number.isFinite(n))
    : null;

  const useMonthlyYearlyExpansion = (freq === 'MONTHLY' || freq === 'YEARLY')
    && (byDayOrdinal || byMonthDay || byMonth);

  // Wall-clock hour/minute of the first occurrence, in the calendar's zone.
  const wall = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(startAt).reduce((a, p) => (a[p.type] = p.value, a), {});
  const H = Number(wall.hour) % 24, Mi = Number(wall.minute);
  // For MONTHLY with BYDAY/BYMONTHDAY, the cursor's day is never read (the
  // real day-of-month is recomputed per period in monthlyOrYearlyCandidates)
  // — only its year/month are. Pin it to 1 so setUTCMonth's own stepping
  // never overflows: a cursor sitting on day 31 rolls "Feb 31" forward into
  // March, silently skipping February every year the rule runs. YEARLY
  // doesn't need this (setUTCFullYear never changes month length), and every
  // other FREQ keeps using the day for real, so only this one case is pinned.
  const cursorDay = (useMonthlyYearlyExpansion && freq === 'MONTHLY') ? 1 : +wall.day;
  let cursor = new Date(Date.UTC(+wall.year, +wall.month - 1, cursorDay));

  const out = [];
  let n = 0;
  for (; n < MAX_OCCURRENCES; n++) {
    if (count != null && out.length >= count) break;

    let candidates;
    if (freq === 'WEEKLY' && byDay) {
      const weekStart = new Date(cursor);
      weekStart.setUTCDate(weekStart.getUTCDate() - weekStart.getUTCDay());
      candidates = byDay
        .slice().sort((a, b) => a - b)
        .map(dow => {
          const d = new Date(weekStart);
          d.setUTCDate(d.getUTCDate() + dow);
          return zonedToInstant(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), H, Mi, tz);
        })
        .filter(at => at >= startAt);
    } else if (useMonthlyYearlyExpansion) {
      candidates = monthlyOrYearlyCandidates(cursor, byDayOrdinal, byMonthDay, byMonth, H, Mi, tz)
        .filter(at => at >= startAt);
    } else {
      candidates = [zonedToInstant(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, cursor.getUTCDate(), H, Mi, tz)];
    }

    // Dates only move forward, so once every candidate this period falls past
    // the window/UNTIL cutoff, no later period can produce anything earlier —
    // stop here rather than spinning to the MAX_OCCURRENCES cap. But a period
    // that produced NO candidates at all (BYMONTHDAY=31 in April, "5th Friday"
    // in a 4-Friday month) is not the same thing as one whose candidates all
    // fell past the cutoff — that just means this period is empty, and a
    // later one may still be in range, so only the latter stops the loop.
    const periodHadCandidates = candidates.length > 0;
    let anyWithinEnd = false;
    for (const at of candidates) {
      if (at > hardEnd) continue;
      anyWithinEnd = true;
      if (count == null || out.length < count) out.push(at);
    }
    if (periodHadCandidates && !anyWithinEnd) break;

    if (freq === 'DAILY') cursor.setUTCDate(cursor.getUTCDate() + interval);
    else if (freq === 'WEEKLY') cursor.setUTCDate(cursor.getUTCDate() + 7 * interval);
    else if (freq === 'MONTHLY') cursor.setUTCMonth(cursor.getUTCMonth() + interval);
    else if (freq === 'YEARLY') cursor.setUTCFullYear(cursor.getUTCFullYear() + interval);
    else break;
  }

  // The loop ran out its full iteration budget without a natural stop (past
  // UNTIL/the window, or COUNT satisfied) — an old daily rule with no COUNT
  // or UNTIL exhausts MAX_OCCURRENCES counting from DTSTART, not from the
  // window, and would otherwise expand to zero occurrences with no warning.
  const capped = n >= MAX_OCCURRENCES;

  return { occurrences: out, capped };
}

function finishEvent(cur, opts, events, warnings) {
  const p = cur.props;
  const summary = p.SUMMARY ? unescapeText(p.SUMMARY.value) : '(no title)';
  const uid = p.UID ? p.UID.value : null;

  if (p.STATUS && /CANCELLED/i.test(p.STATUS.value)) return;
  if (p.TRANSP && /TRANSPARENT/i.test(p.TRANSP.value)) return;

  if (!p.DTSTART) { warnings.push(`"${summary}" has no start time and was skipped`); return; }
  const start = toInstant(p.DTSTART, opts.tz);
  if (!start) { warnings.push(`"${summary}" has an unreadable start time and was skipped`); return; }

  let end;
  if (p.DTEND) {
    const e = toInstant(p.DTEND, opts.tz);
    // DTEND on an all-day event is exclusive: DTEND 20261102 means the event
    // ends at the START of 2 Nov, which is the end of 1 Nov.
    end = e ? e.at : null;
  } else if (p.DURATION) {
    const ms = durationMs(p.DURATION.value);
    end = ms == null ? null : new Date(start.at.getTime() + ms);
  }
  // RFC 5545 §3.6.1: a DATE-valued DTSTART with no DTEND/DURATION lasts one
  // day, not zero — only a timed event with no end is genuinely zero-length.
  // toInstant already computed isoDate for the all-day case; dayBoundsInZone
  // turns it into local-midnight-to-next-local-midnight, the same way an
  // explicit DTEND on an all-day event is read a few lines above.
  if (!end) end = start.allDay ? dayBoundsInZone(start.isoDate, opts.tz).end : new Date(start.at.getTime());

  const durMs = end.getTime() - start.at.getTime();
  const base = { uid, summary, allDay: start.allDay };

  if (!p.RRULE) {
    pushIfInWindow(events, { ...base, startsAt: start.at, endsAt: end }, opts);
    return;
  }

  const { parts, unsupported } = parseRrule(p.RRULE.value);
  if (unsupported.length) {
    // The first instance is still real, so it is still busy. But an unexpanded
    // rule is a standing commitment the CRM cannot see, and that has to be said
    // out loud — it ends up in the conflict panel, not in a log.
    warnings.push(`the recurring event "${summary}" uses ${unsupported.join(', ')}, which cannot be expanded — only its first occurrence is known`);
    pushIfInWindow(events, { ...base, startsAt: start.at, endsAt: end }, opts);
    return;
  }

  const exdates = new Set();
  for (const x of (p.EXDATE || [])) {
    for (const v of String(x.value).split(',')) {
      const inst = toInstant({ params: x.params, value: v.trim() }, opts.tz);
      if (inst) exdates.add(inst.at.getTime());
    }
  }

  const { occurrences, capped } = expandRrule(start.at, parts, opts.windowEnd, opts.tz);
  if (capped) {
    warnings.push(`the recurring event "${summary}" has too many occurrences to expand from its start date — some are not known`);
  }
  for (const at of occurrences) {
    if (exdates.has(at.getTime())) continue;
    pushIfInWindow(events, { ...base, startsAt: at, endsAt: new Date(at.getTime() + durMs) }, opts);
  }
}

function pushIfInWindow(events, e, { windowStart, windowEnd }) {
  if (e.endsAt <= windowStart || e.startsAt >= windowEnd) return;
  events.push(e);
}

module.exports = { parseIcs, unescapeText };
