const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const HTML = fs.readFileSync(path.join(__dirname, '../staff-portal.html'), 'utf8');

// Same extraction contract as staff-portal-times.test.js: run the pure block in
// a bare context so any reach for `document` throws instead of silently passing.
function loadHelpers() {
  const a = HTML.indexOf('// ══ PURE TIME HELPERS');
  const b = HTML.indexOf('// ══ END PURE TIME HELPERS');
  assert.ok(a !== -1 && b !== -1, 'pure-helper sentinels missing from staff-portal.html');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(HTML.slice(a, b) +
    '\nout = { groupGigsByBooking, CHECKLIST_ORDER };', ctx);
  return ctx.out;
}

const { groupGigsByBooking, CHECKLIST_ORDER } = loadHelpers();

// staff_assignments is UNIQUE(booking_id, staff_id, tag_filled), so one person
// taking two roles on one booking is two legitimate rows — not a join fanout.
// The portal rendered a card per row, which is the reported duplicate.
const driver = {
  id: 11, booking_id: 900, tag_filled: 'Driver', log_id: 501,
  checklist_status: 'arrived', service_name: 'Foam Party', event_date: '2026-09-01',
};
const performer = {
  id: 12, booking_id: 900, tag_filled: 'Performer', log_id: 502,
  checklist_status: 'clocked_in', service_name: 'Foam Party', event_date: '2026-09-01',
};
const otherBooking = { id: 13, booking_id: 901, tag_filled: 'Driver', log_id: 503,
  checklist_status: 'upcoming', service_name: 'Petting Zoo', event_date: '2026-09-02' };

test('two roles on one booking collapse to a single card', () => {
  const out = groupGigsByBooking([driver, performer, otherBooking]);
  assert.equal(out.length, 2, 'one card per booking, not per assignment');
  assert.equal(out[0].booking_id, 900);
  assert.deepEqual(out[0].tags, ['Driver', 'Performer'], 'both roles stay visible');
});

test('the merged card can still act on every assignment', () => {
  const [merged] = groupGigsByBooking([driver, performer]);
  // Pay is computed per assignment from its own gig_logs row. If the card only
  // clocked one of them, the other silently falls back to the estimate.
  assert.deepEqual(merged.assignment_ids, [11, 12]);
  assert.deepEqual(merged.log_ids, [501, 502]);
});

test('the merged card shows the least-advanced step', () => {
  const [merged] = groupGigsByBooking([driver, performer]);
  // driver=arrived, performer=clocked_in. Claiming the further-along step would
  // tell someone they had finished work they had not started.
  assert.equal(merged.checklist_status, 'clocked_in');
  assert.ok(CHECKLIST_ORDER.indexOf('clocked_in') < CHECKLIST_ORDER.indexOf('arrived'));
});

test('a single-role gig is unchanged apart from the new fields', () => {
  const [only] = groupGigsByBooking([otherBooking]);
  assert.equal(only.service_name, 'Petting Zoo');
  assert.equal(only.checklist_status, 'upcoming');
  assert.deepEqual(only.assignment_ids, [13]);
  assert.deepEqual(only.tags, ['Driver']);
});

test('the post-gig report stays open until every role has filed', () => {
  const a = { ...driver,    checklist_status: 'clocked_out', survey_submitted_at: '2026-09-01T20:00:00Z' };
  const b = { ...performer, checklist_status: 'clocked_out', survey_submitted_at: null };
  assert.equal(groupGigsByBooking([a, b])[0].survey_submitted_at, null);
  const bothFiled = { ...b, survey_submitted_at: '2026-09-01T20:05:00Z' };
  assert.ok(groupGigsByBooking([a, bothFiled])[0].survey_submitted_at);
});

test('log_ids stay column-aligned with assignment_ids', () => {
  // A role with no gig_logs row yet must hold its place with '' — updateChecklist
  // pairs the two lists by index, so a collapsed list would stamp log 501 against
  // the Performer assignment: someone else's row, and the wrong pay stamps.
  const noLogYet = { ...performer, log_id: null };
  const [merged] = groupGigsByBooking([driver, noLogYet]);
  assert.deepEqual(merged.assignment_ids, [11, 12]);
  assert.deepEqual(merged.log_ids, [501, '']);
  assert.equal(merged.assignment_ids.length, merged.log_ids.length);
});

test('empty input is empty output', () => {
  assert.deepEqual(groupGigsByBooking([]), []);
});
