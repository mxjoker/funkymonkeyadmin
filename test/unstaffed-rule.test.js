const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SCHED = fs.readFileSync(path.join(__dirname, '..', 'netlify/functions/automations-scheduled.js'), 'utf8');
const AUTO = fs.readFileSync(path.join(__dirname, '..', 'netlify/functions/automations.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');

// The unstaffed alert's window, statuses and wording were literals in
// automations-scheduled.js. They live on a rule now, so the thing worth
// pinning is that the scheduler reads them rather than re-hardcoding them.
test('the unstaffed alert reads its settings from the rule', () => {
  const fn = SCHED.split('async function unstaffedAlerts')[1].split('\n}\n')[0];
  const code = fn.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('--')).join('\n');
  assert.ok(/trigger_event='unstaffed'/.test(code), 'it must look the rule up');
  assert.ok(/rule\.trigger_days/.test(code), 'the day window must come from the rule');
  assert.ok(/rule\.trigger_status/.test(code), 'the status filter must come from the rule');
  assert.ok(/rule\.body_sms/.test(code), 'the wording must come from the rule');
  assert.ok(/if \(!rule\.active\) return 0;/.test(code), 'switching the rule off must stop it');
  assert.ok(!/UNSTAFFED:/.test(code), 'the message must not be hardcoded here any more');
});

test('a blank status filter still means accepted and confirmed', () => {
  const fn = SCHED.split('async function unstaffedAlerts')[1].split('\n}\n')[0];
  assert.ok(/\['accepted', 'confirmed'\]/.test(fn),
    'the default must stay both statuses — that is the behaviour being replaced');
});

// The point of the whole change: an accepted-but-unpaid gig should be
// silenceable without switching the alert off entirely.
test('the editor offers confirmed-only, which is the reason for this change', () => {
  assert.ok(/Confirmed only \(deposit paid\)/.test(HTML), 'confirmed-only option missing');
  assert.ok(/Accepted only \(unpaid\)/.test(HTML), 'accepted-only option missing');
  assert.ok(/Accepted and confirmed/.test(HTML), 'the both-statuses default must stay selectable');
});

test('a day count of zero is not silently turned back into a default', () => {
  // 0 is legitimate: "today only" here, "day of the event" for days_before.
  // `r.trigger_days || null` turned it into null, which reads as absent.
  assert.ok(!/r\.trigger_days\s*\|\|\s*null/.test(AUTO),
    'trigger_days uses || which discards a deliberate 0 — use ?? instead');
  assert.ok(/r\.trigger_days \?\? null/.test(AUTO), 'trigger_days should be coalesced with ??');
});

test('the unstaffed rule cannot be fired by the rules engine', () => {
  // It is read directly by the scheduler. If a trigger query ever matched it,
  // the alert would go out twice and to the wrong recipient resolution.
  for (const ev of ['status_change', 'days_before_event', 'days_after_event', 'days_after_created']) {
    assert.ok(!new RegExp(`trigger_event='${ev}'[^\`]*unstaffed`).test(AUTO),
      `${ev} must not select unstaffed rules`);
  }
});
