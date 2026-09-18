const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SCHED = fs.readFileSync(path.join(__dirname, '..', 'netlify/functions/automations-scheduled.js'), 'utf8');
const { STAFFABLE_STATUSES } = require('../netlify/functions/staff-assignments.js');

// Cancelling a booking leaves its staff_assignments rows at 'assigned', so the
// day-of reminder happily texted the crew of a dead gig. Four went out before
// anyone noticed — one to Noah Drews on 2026-08-29 about cancelled booking
// 26-276, and one to Joe today about cancelled FM-PM3CRC4Z, which is what
// surfaced it. Payroll was never exposed: its own query filters
// b.status IN ('confirmed','completed').
function runDayOf() {
  delete require.cache[require.resolve('../netlify/functions/automations-scheduled.js')];
  const mod = require('../netlify/functions/automations-scheduled.js');
  const seen = { sql: null, params: null, sent: [] };
  const client = {
    query: async (sql, params) => {
      if (/FROM staff_assignments/i.test(sql)) {
        seen.sql = sql; seen.params = params;
        return { rows: [] };   // nothing to send; we are inspecting the gate
      }
      return { rows: [] };
    },
  };
  return mod.staffDayOfReminders(client, new Date('2026-09-18T14:00:00Z')).then(() => seen);
}

test('the reminder asks the database only for staffable bookings', async () => {
  const seen = await runDayOf();
  assert.ok(seen.sql, 'expected the assignments query to run');
  assert.match(seen.sql, /b\.status = ANY\(\$1\)/, 'the booking status must be part of the query');
  assert.deepStrictEqual(seen.params, [STAFFABLE_STATUSES],
    'and it must be the shared constant, not a second hand-written list');
});

test('a cancelled or quoted booking is outside that list', () => {
  assert.ok(!STAFFABLE_STATUSES.includes('cancelled'), 'cancelled is not work');
  assert.ok(!STAFFABLE_STATUSES.includes('quoted'), 'a quote is not a booking yet');
  assert.deepStrictEqual(STAFFABLE_STATUSES, ['accepted', 'confirmed']);
});

// The same list the Notify Staff button and the open-gig list read. If this
// file grew its own copy, the two would drift the way the brand rule did.
test('the constant is imported, never redefined here', () => {
  assert.match(SCHED, /const \{ wantsSms, STAFFABLE_STATUSES \} = require\('\.\/staff-assignments'\)/);
  assert.ok(!/STAFFABLE_STATUSES\s*=\s*\[/.test(SCHED), 'no private copy in this file');
});

test('the dedupe still keys on the label it writes', () => {
  const fn = SCHED.split('async function staffDayOfReminders')[1].split('return sent;')[0];
  assert.match(fn, /l\.trigger_label = 'Day-of reminder'/);
  assert.match(fn, /trigger_label: 'Day-of reminder'/);
});
