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
  vm.runInContext(HTML.slice(a, b) + '\nout = { formatConflicts };', ctx);
  return ctx.out;
}
const { formatConflicts } = loadHelpers();

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
