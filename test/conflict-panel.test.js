const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Same trick as bookings-sort.test.js: run the pure helpers in a bare context so
// any reach for `document` throws instead of silently passing.
const HTML = fs.readFileSync(path.join(__dirname, '../admin.html'), 'utf8');
function loadHelpers() {
  const a = HTML.indexOf('// ══ PURE HELPERS');
  const b = HTML.indexOf('// ══ END PURE HELPERS');
  assert.ok(a !== -1 && b !== -1, 'pure-helper sentinels missing from admin.html');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(HTML.slice(a, b) + '\nout = { formatConflicts, hardConflictSummary, conflictConfirmation, feedStatusLabel };', ctx);
  return ctx.out;
}
const { formatConflicts, hardConflictSummary, conflictConfirmation, feedStatusLabel } = loadHelpers();

const clean = { windowKnown: true, external: [], bookings: [], degraded: false, degradedReasons: [], warnings: [], unknowns: [] };

test('a clean result reads as clear', () => {
  const v = formatConflicts(clean);
  assert.strictEqual(v.tone, 'clear');
  assert.match(v.headline, /clear|nothing/i);
});

test('a degraded result NEVER reads as clear, even with nothing found', () => {
  const v = formatConflicts({ ...clean, degraded: true, degradedReasons: ['"Personal" last synced 40 hours ago'] });
  assert.notStrictEqual(v.tone, 'clear', 'degraded must not be presented as clear');
  assert.strictEqual(v.tone, 'unknown');
  assert.match(v.notes.join(' '), /40 hours/);
});

test('an unknown window is not clear either', () => {
  const v = formatConflicts({ ...clean, windowKnown: false, unknowns: ['no event time on this booking'] });
  assert.strictEqual(v.tone, 'unknown');
  assert.match(v.notes.join(' '), /no event time/);
});

test('external events are listed with their feed and time', () => {
  const v = formatConflicts({ ...clean, external: [{
    feedLabel: 'Personal', summary: 'Dentist', allDay: false,
    startsAt: '2026-09-12T18:30:00Z', endsAt: '2026-09-12T19:00:00Z' }] });
  assert.strictEqual(v.tone, 'warn');
  assert.match(v.lines[0], /Dentist/);
  assert.match(v.lines[0], /Personal/);
});

test('an all-day event says so instead of printing midnight', () => {
  const v = formatConflicts({ ...clean, external: [{
    feedLabel: 'Personal', summary: 'Tulsa trip', allDay: true,
    startsAt: '2026-09-12T05:00:00Z', endsAt: '2026-09-13T05:00:00Z' }] });
  assert.match(v.lines[0], /all day/i);
  assert.ok(!/00:00/.test(v.lines[0]));
});

test('hard and soft bookings are distinguishable', () => {
  const v = formatConflicts({ ...clean, bookings: [
    { reference: 'FM-A', clientName: 'Ann', status: 'confirmed', tier: 'hard', windowKnown: true, startsAt: '2026-09-12T19:00:00Z', endsAt: '2026-09-12T21:00:00Z' },
    { reference: 'FM-B', clientName: 'Bob', status: 'quoted',    tier: 'soft', windowKnown: true, startsAt: '2026-09-12T19:00:00Z', endsAt: '2026-09-12T21:00:00Z' },
  ] });
  assert.strictEqual(v.tone, 'warn');
  assert.match(v.lines.join('\n'), /FM-A/);
  assert.match(v.lines.join('\n'), /FM-B/);
  assert.match(v.lines.find(l => /FM-B/.test(l)), /quoted/i);
});

test('parser warnings appear as notes even when nothing clashes', () => {
  const v = formatConflicts({ ...clean, warnings: ['Personal: the recurring event "School run" uses BYSETPOS'] });
  assert.match(v.notes.join(' '), /School run/);
  assert.notStrictEqual(v.tone, 'clear', 'an unexpanded recurring rule means the answer is not certain');
});

// Fix round 1: formatConflicts and the render used to sit outside
// refreshConflictPanel's try/catch, so a malformed 200 body left the panel
// stuck on "Checking the calendar…" forever — silence dressed up as motion.
test('an empty object is unknown, not clear — a malformed-but-truthy body must not read as a clean sweep', () => {
  const v = formatConflicts({});
  assert.strictEqual(v.tone, 'unknown');
});

test('null throws rather than silently rendering — the render path\'s try/catch is what must catch this', () => {
  assert.throws(() => formatConflicts(null));
});

test('hardConflictSummary: a clean result needs no confirmation', () => {
  assert.strictEqual(hardConflictSummary(clean), null);
});

test('hardConflictSummary: a soft (quoted) clash alone does not block the save', () => {
  const r = { ...clean, bookings: [{ reference: 'FM-B', clientName: 'Bob', status: 'quoted', tier: 'soft', windowKnown: true, startsAt: '2026-09-12T19:00:00Z', endsAt: '2026-09-12T21:00:00Z' }] };
  assert.strictEqual(hardConflictSummary(r), null);
});

test('hardConflictSummary: a confirmed booking clash asks first', () => {
  const r = { ...clean, bookings: [{ reference: 'FM-A', clientName: 'Ann', status: 'confirmed', tier: 'hard', windowKnown: true, startsAt: '2026-09-12T19:00:00Z', endsAt: '2026-09-12T21:00:00Z' }] };
  const s = hardConflictSummary(r);
  assert.ok(s, 'a hard clash must produce a confirmation message');
  assert.match(s, /FM-A/);
});

test('hardConflictSummary: any calendar event asks first', () => {
  const r = { ...clean, external: [{ feedLabel: 'Personal', summary: 'Dentist', allDay: false, startsAt: '2026-09-12T18:30:00Z', endsAt: '2026-09-12T19:00:00Z' }] };
  assert.match(hardConflictSummary(r), /Dentist/);
});

// Fix round 1: a save that goes through before the conflict check has an
// answer used to fail silently — lastConflictResult was simply null, and
// hardConflictSummary(null || {}) has nothing to say. The panel can show
// "not cleared" to a human looking at it; the save path has no panel, so
// silence there means Joe never finds out at all. conflictConfirmation is
// the fix: an absent or uncertain result asks too, distinctly from a real
// hard conflict.

test('conflictConfirmation: no date entered means no check is owed', () => {
  assert.strictEqual(conflictConfirmation(false, clean), null);
});

test('conflictConfirmation: a clean result with a date present needs no confirmation', () => {
  assert.strictEqual(conflictConfirmation(true, clean), null);
});

test('conflictConfirmation: a null result (check never returned) asks, distinctly from a hard conflict', () => {
  const c = conflictConfirmation(true, null);
  assert.ok(c, 'an absent result must still ask before saving');
  assert.strictEqual(c.kind, 'uncertain');
});

test('conflictConfirmation: a degraded result with no findings still asks', () => {
  const r = { ...clean, degraded: true, degradedReasons: ['"Personal" last synced 40 hours ago'] };
  const c = conflictConfirmation(true, r);
  assert.ok(c);
  assert.strictEqual(c.kind, 'uncertain');
});

test('conflictConfirmation: a hard booking conflict takes priority over an uncertain check', () => {
  const r = { ...clean, warnings: ['some parser warning'], bookings: [
    { reference: 'FM-A', clientName: 'Ann', status: 'confirmed', tier: 'hard', windowKnown: true, startsAt: '2026-09-12T19:00:00Z', endsAt: '2026-09-12T21:00:00Z' },
  ] };
  const c = conflictConfirmation(true, r);
  assert.strictEqual(c.kind, 'hard');
  assert.match(c.message, /FM-A/);
});

// A soft (quoted) clash alone must not block a save — only hardConflictSummary
// was exercised for this before; conflictConfirmation is the actual save gate
// and the easy way to get this backwards is to have it ask anyway.
test('conflictConfirmation: a soft-only clash needs no confirmation', () => {
  const r = { ...clean, bookings: [
    { reference: 'FM-B', clientName: 'Bob', status: 'quoted', tier: 'soft', windowKnown: true, startsAt: '2026-09-12T19:00:00Z', endsAt: '2026-09-12T21:00:00Z' },
  ] };
  assert.strictEqual(conflictConfirmation(true, r), null);
});

test('feedStatusLabel: a fresh successful sync is ok', () => {
  const s = feedStatusLabel({ label: 'Personal', last_status: 'ok', last_synced_at: '2026-09-01T11:00:00Z', last_event_count: 42, last_warnings: [] }, new Date('2026-09-01T12:00:00Z'));
  assert.strictEqual(s.tone, 'ok');
  assert.match(s.text, /42/);
});

test('feedStatusLabel: an error is an error, and shows the reason', () => {
  const s = feedStatusLabel({ label: 'Personal', last_status: 'error', last_error: 'HTTP 404', last_synced_at: '2026-09-01T11:00:00Z' }, new Date('2026-09-01T12:00:00Z'));
  assert.strictEqual(s.tone, 'error');
  assert.match(s.text, /404/);
});

test('feedStatusLabel: never synced is an error, not a blank', () => {
  const s = feedStatusLabel({ label: 'Personal', last_status: null, last_synced_at: null }, new Date('2026-09-01T12:00:00Z'));
  assert.strictEqual(s.tone, 'error');
  assert.match(s.text, /never/i);
});

test('feedStatusLabel: stale is a warning', () => {
  const s = feedStatusLabel({ label: 'Personal', last_status: 'ok', last_synced_at: '2026-08-29T11:00:00Z', last_event_count: 42 }, new Date('2026-09-01T12:00:00Z'));
  assert.strictEqual(s.tone, 'warn');
  assert.match(s.text, /hours ago/);
});

test('feedStatusLabel: warnings are mentioned even on a successful sync', () => {
  const s = feedStatusLabel({ label: 'Personal', last_status: 'ok', last_synced_at: '2026-09-01T11:00:00Z', last_event_count: 42, last_warnings: ['a thing'] }, new Date('2026-09-01T12:00:00Z'));
  assert.strictEqual(s.tone, 'warn');
  assert.match(s.text, /1 warning/);
});
