// The day-of checklist doubles as a time clock: gig_logs stamps a timestamp per
// stage, and clocked_in_at → clocked_out_at is the worked span.
//
// This module is pure and has no database. payroll.js pays from it and the admin
// page displays from it, so the rules about what counts as a usable record live
// in exactly one place.

// A span longer than this is a forgotten clock-out, not a shift. Paying it would
// silently overpay by hundreds of dollars, and a wrong-but-believable number in
// a money path is this codebase's documented recurring failure — so an
// over-long span is refused and payroll falls back to its estimate, loudly.
//
// ponytail: a constant, not a per-staff setting. If a legitimate gig ever runs
// longer, raise it here rather than inventing a policy table.
const MAX_SHIFT_HOURS = 16;

// pg hands back TIMESTAMPTZ as a Date; the admin page and tests hand back ISO
// strings. Both must work, and anything unparseable must read as absent rather
// than as NaN, which compares false against everything and would slip through.
function ms(value) {
  if (!value) return null;
  const t = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

const round2 = (n) => Math.round(n * 100) / 100;

function workedHours(log) {
  const inMs  = ms(log && log.clocked_in_at);
  const outMs = ms(log && log.clocked_out_at);
  if (inMs === null)  return { usable: false, hours: null, reason: 'no clock-in recorded' };
  if (outMs === null) return { usable: false, hours: null, reason: 'no clock-out recorded' };
  if (outMs <= inMs)  return { usable: false, hours: null, reason: 'clock-out is before clock-in' };
  const spanMs = outMs - inMs;
  if (spanMs > MAX_SHIFT_HOURS * 3600000) {
    const hours = round2(spanMs / 3600000);
    return { usable: false, hours: null, reason: `${hours}h exceeds the ${MAX_SHIFT_HOURS}h maximum — likely a missed clock-out` };
  }
  const hours = round2(spanMs / 3600000);
  return { usable: true, hours, reason: null };
}

// The same four segments payroll estimates, measured. A segment whose ends are
// not both present, or which runs backwards, reads null — never a negative or a
// guess, so a partial record degrades one row at a time instead of poisoning the
// whole comparison.
function clockSegments(log) {
  const gap = (a, b) => {
    const from = ms(log && log[a]);
    const to   = ms(log && log[b]);
    if (from === null || to === null || to < from) return null;
    return Math.round((to - from) / 60000);
  };
  return {
    loading:            gap('clocked_in_at', 'on_my_way_at'),
    driveOut:           gap('on_my_way_at', 'arrived_at'),
    onSite:             gap('arrived_at', 'completed_at'),
    driveBackAndUnload: gap('completed_at', 'clocked_out_at'),
  };
}

// What payroll should pay, and why. Keeping the choice here rather than inline
// in payroll.js means the fallback rule is testable without a database — the
// computation loop it lives in cannot be run without one.
//
// The 5-hour minimum wraps BOTH branches: it is a floor on what a gig pays, not
// a property of how the hours were arrived at.
const MIN_PAID_HOURS = 5;

function payableHours(log, estimatedHours) {
  const est = Math.round((Number(estimatedHours) || 0) * 100) / 100;
  const measured = workedHours(log);
  if (measured.usable) {
    return { source: 'measured', hours: Math.max(MIN_PAID_HOURS, measured.hours),
             measured: measured.hours, warning: null };
  }
  // Most assignments today have never touched the clock at all — that is the
  // expected, silent case, and warning on it would bury the two warnings that
  // matter (a $0 line item, a genuine forgotten clock-out) under one copy of
  // "no clock-in recorded" per booking every week. Only warn when there is
  // clock data to be suspicious of: a clock-in with no clock-out, a backwards
  // pair, or an over-cap span.
  const hasClockData = !!(log && (log.clocked_in_at || log.clocked_out_at));
  return { source: 'estimated', hours: Math.max(MIN_PAID_HOURS, est),
           measured: null, warning: hasClockData ? measured.reason : null };
}

module.exports = { MAX_SHIFT_HOURS, workedHours, clockSegments, payableHours, MIN_PAID_HOURS };
