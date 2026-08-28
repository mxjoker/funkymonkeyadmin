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
  if (!end) end = new Date(start.at.getTime());

  // Task 5 replaces this with expansion.
  pushIfInWindow(events, { uid, summary, startsAt: start.at, endsAt: end, allDay: start.allDay }, opts);
}

function pushIfInWindow(events, e, { windowStart, windowEnd }) {
  if (e.endsAt <= windowStart || e.startsAt >= windowEnd) return;
  events.push(e);
}

module.exports = { parseIcs, unfold, parseLine, toInstant, durationMs, unescapeText };
