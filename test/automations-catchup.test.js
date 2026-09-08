const { test } = require('node:test');
const assert = require('node:assert');

// The two guards that stop a dead cron run from costing a client her mail:
// _db.js retries a cold Neon connect, and runScheduledAutomations looks back
// CATCHUP_DAYS so a run that never happened is made good by the next one.

function loadDb() {
  delete require.cache[require.resolve('../netlify/functions/_db.js')];
  return require('../netlify/functions/_db.js');
}

// ── _db.js: the connect retry ───────────────────────────────────────────────

test('a cold-start connect timeout is retried rather than losing the run', async () => {
  // withClient closes over the module's own getPool, so drive it through a
  // stubbed pg Pool rather than trying to replace the export.
  const client = { release: () => {} };
  const pg = require('pg');
  const realPool = pg.Pool;
  let attempts = 0;
  pg.Pool = function () {
    return {
      on: () => {},
      connect: async () => {
        attempts++;
        if (attempts === 1) throw new Error('timeout exceeded when trying to connect');
        return client;
      }
    };
  };
  try {
    const fresh = loadDb();
    const out = await fresh.withClient(async c => {
      assert.strictEqual(c, client);
      return 'ran';
    });
    assert.strictEqual(out, 'ran', 'the callback must run after the retry');
    assert.strictEqual(attempts, 2, 'exactly one retry');
  } finally {
    pg.Pool = realPool;
  }
});

test('a database that is genuinely down still fails rather than hanging forever', async () => {
  const pg = require('pg');
  const realPool = pg.Pool;
  let attempts = 0;
  pg.Pool = function () {
    return {
      on: () => {},
      connect: async () => { attempts++; throw new Error('ECONNREFUSED'); }
    };
  };
  try {
    const fresh = loadDb();
    await assert.rejects(() => fresh.withClient(async () => 'never'), /ECONNREFUSED/);
    assert.strictEqual(attempts, 2, 'tried twice, then gave up');
  } finally {
    pg.Pool = realPool;
  }
});

// ── automations.js: the catch-up window ─────────────────────────────────────

function loadAutomations() {
  delete require.cache[require.resolve('../netlify/functions/automations.js')];
  return require('../netlify/functions/automations.js');
}

// Captures the booking-selection SQL each rule loop issues.
function fakeClient(rules) {
  const selects = [];
  return {
    selects,
    query: async (sql, params) => {
      if (/FROM automation_rules/i.test(sql)) {
        const kind = /days_before_event/.test(sql) ? 'days_before_event'
          : /days_after_event/.test(sql) ? 'days_after_event'
          : 'days_after_created';
        return { rows: rules.filter(r => r.trigger_event === kind) };
      }
      if (/FROM bookings/i.test(sql)) {
        selects.push({ sql, params });
        return { rows: [] };
      }
      return { rows: [] };
    }
  };
}

const RULES = [
  { id: 2, name: 'Pre-Event Reminder', trigger_event: 'days_before_event', trigger_days: 3, channel: 'email', recipient: 'client' },
  { id: 3, name: 'Post-Event Follow-up', trigger_event: 'days_after_event', trigger_days: 1, channel: 'email', recipient: 'client' },
  { id: 8, name: 'Stale Lead', trigger_event: 'days_after_created', trigger_days: 2, trigger_status: 'review', channel: 'email', recipient: 'admin' },
];

test('every date-driven rule looks back over a window, not one exact day', async () => {
  const { runScheduledAutomations } = loadAutomations();
  const c = fakeClient(RULES);
  await runScheduledAutomations(c);

  assert.strictEqual(c.selects.length, 3, 'one booking query per rule');
  for (const { sql } of c.selects) {
    assert.match(sql, /BETWEEN/, 'a single-day "= $1::date" match is what lost the 09-02 mail');
    assert.doesNotMatch(sql, /date\s*=\s*\$1::date/, 'no exact-day equality left');
  }
});

test('a pre-event reminder is never sent after the event has happened', async () => {
  const { runScheduledAutomations } = loadAutomations();
  const c = fakeClient(RULES);
  await runScheduledAutomations(c);

  const before = c.selects.find(s => /'quoted'/.test(s.sql));
  assert.match(before.sql, /GREATEST\(CURRENT_DATE/,
    'the window floor must be pinned at today, or a 1-day rule mails about a past event');
});

test('the dedupe cannot be disabled by a NULL booking_id', async () => {
  const { runScheduledAutomations } = loadAutomations();
  const c = fakeClient(RULES);
  await runScheduledAutomations(c);

  // `id NOT IN (… NULL …)` is NULL for every row, which would silently switch
  // the rule off forever. logEmail permits a NULL booking_id, so exclude them.
  for (const { sql } of c.selects) {
    assert.match(sql, /booking_id IS NOT NULL/, 'NOT IN must never see a NULL');
  }
});

test('the catch-up reach is bounded, so a rule cannot mail old history', async () => {
  const { runScheduledAutomations } = loadAutomations();
  const c = fakeClient(RULES);
  await runScheduledAutomations(c);

  for (const { params } of c.selects) {
    const catchup = params[params.length - 1];
    assert.strictEqual(catchup, 2, 'CATCHUP_DAYS is passed as a bound parameter');
  }
});
