const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SCHED = fs.readFileSync(path.join(__dirname, '..', 'netlify/functions/automations-scheduled.js'), 'utf8');
const AUTO = fs.readFileSync(path.join(__dirname, '..', 'netlify/functions/automations.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');

const fn = () => SCHED.split('async function incompleteAlerts')[1].split('\n}\n')[0];
// Comments in the function explain the traps by naming them ("IS NOT NULL is a
// dead test on this schema"), so a scan for a trap must read the code only.
const code = () => fn().split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

// Booking 18 was confirmed, 11 days out, staffed, and had no event_time and no
// ZIP — so the assignment had no shift window and the staff portal said "not
// calculated yet". Nothing told anyone. These pin the parts that made it
// invisible, not the wording.
test('the incomplete alert watches exactly the fields staffing needs', () => {
  const code = fn();
  for (const col of ['service_id', 'event_time', 'event_zip']) {
    assert.ok(code.includes(col), `${col} must be checked — a gig missing it cannot be scheduled`);
  }
});

test('emptiness is tested with coalesce, never IS NOT NULL', () => {
  // Every text column in this schema is DEFAULT '', so IS NOT NULL is always
  // true. A migration guard that could never fire shipped on exactly this.
  assert.ok(!/IS NOT NULL/.test(code()), 'IS NOT NULL is a dead test on this schema');
  assert.ok(/coalesce\(b\.service_id,''\) = ''/.test(code()), 'use coalesce(col,\'\') = \'\'');
});

test('it reads its settings from the rule rather than hardcoding them', () => {
  const code = fn().split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('--')).join('\n');
  assert.ok(/trigger_event='incomplete'/.test(code), 'it must look the rule up');
  assert.ok(/rule\.trigger_days/.test(code), 'the window must come from the rule');
  assert.ok(/rule\.trigger_status/.test(code), 'the status filter must come from the rule');
  assert.ok(/rule\.body_sms/.test(code), 'the wording must come from the rule');
  assert.ok(/if \(!rule\.active\) return 0;/.test(code), 'switching the rule off must stop it');
  assert.ok(!/need details before/.test(code), 'the message must not be hardcoded here');
});

// The alert fires daily while a gig stays incomplete, so the dedupe is the
// thing standing between "useful" and "ignored".
// One text a day about the whole window, not one per booking. Measured against
// production 2026-09-15, per-booking would have sent six on the first run and
// six every day after, until each was edited.
test('it sends one digest a day, not one text per booking', () => {
  const code = fn();
  assert.ok(/trigger_label = 'Incomplete gig'/.test(code), 'dedupe must match its own label');
  assert.ok(/created_at::date = CURRENT_DATE/.test(code), 'dedupe must be per day');
  assert.ok(/trigger_label: 'Incomplete gig'/.test(code), 'the send must write the label it dedupes on');
  assert.ok(!/l\.booking_id = b\.id/.test(code), 'a per-booking dedupe would send one text each');
  assert.ok((code.match(/await sendSms\(/g) || []).length === 1, 'exactly one send per run');
  assert.ok(!/for \(const b of rows\) \{[\s\S]*sendSms/.test(code), 'the send must not sit in a loop');
  assert.ok(/{{list}}/.test(code) && /{{count}}/.test(code), 'the digest needs both of its own tokens');
});

// Five copies of this formatter exist because the HTML pages share no JS. A
// sixth, written inline here, is how "Invalid Date" reached 23 live texts.
test('the digest formats dates with the shared helper', () => {
  assert.ok(/fmtEventDate\(b\.event_date/.test(fn()), 'use fmtEventDate, not a private formatter');
  // Short form keeps a six-gig digest inside two segments; it must still be
  // the shared formatter, with Intl options, not a hand-rolled substring.
  assert.ok(/month: 'short'/.test(fn()), 'the digest should use the short date form');
  assert.ok(/const \{ fmtEventDate \} = require\('\.\/_email'\);/.test(SCHED), 'it must actually be imported');
});

test('it cannot also be fired by the rules engine', () => {
  for (const ev of ['status_change', 'days_before_event', 'days_after_event', 'days_after_created']) {
    assert.ok(!new RegExp(`trigger_event='${ev}'[^\`]*incomplete`).test(AUTO),
      `${ev} must not select the incomplete rule`);
  }
});

test('the seed is keyed on trigger_event so renaming it cannot duplicate it', () => {
  assert.ok(/WHERE NOT EXISTS \(SELECT 1 FROM automation_rules WHERE trigger_event='incomplete'\)/.test(AUTO));
});

// The scheduler's log line is how a run is read after the fact. A job whose
// count never appears there is a job nobody knows ran.
test('the run reports how many incomplete alerts it sent', () => {
  assert.ok(/incompleteAlerts\(client, now\)/.test(SCHED), 'it must actually be called');
  assert.ok(/\$\{result\.gaps\} incomplete-gig alert\(s\)/.test(SCHED), 'the count must be logged');
  assert.ok(/guard\('incompleteAlerts', 0\)/.test(SCHED), 'a failure must name itself, not sink the run');
});

// The alert says the same thing the dashboard panel says. If the words drift,
// Joe gets a text that does not match the screen he fixes it on.
test('its reasons use admin.html incompleteReasons wording', () => {
  const code = fn();
  for (const reason of ['no service', 'no time', 'no ZIP']) {
    assert.ok(code.includes(`'${reason}'`), `alert is missing the reason "${reason}"`);
    assert.ok(HTML.includes(`'${reason}'`), `admin.html no longer says "${reason}" — they have drifted`);
  }
});

// The hazard this closes is silent: a trigger_event with no <option> shows the
// editor's first entry instead, so opening the incomplete rule to reword it and
// pressing Save would have turned it into a status_change rule — the alert
// stops, nothing errors, and the rule still looks fine in the list.
test('the rule editor can open and re-save the incomplete rule unchanged', () => {
  assert.ok(/<option value="incomplete"/.test(HTML), 'the trigger has no option — saving would rewrite it');
  assert.ok(/const isWindowedAlert = \(t\) => t === 'unstaffed' \|\| t === 'incomplete';/.test(HTML),
    'both admin alerts must be named in one place');
  assert.ok(!/trigger==='status_change' \|\| trigger==='unstaffed'/.test(HTML),
    'the save path still tests unstaffed by hand — incomplete would save with a null window');
});

// The editor's default and the seed's default must agree, or a rule opened and
// saved without touching the day box changes its own window.
test('the editor default window matches the seeded one', () => {
  assert.ok(/alertDefaultDays = \(t\) => \(t === 'incomplete' \? 14 : 3\)/.test(HTML));
  assert.ok(/'incomplete', NULL, 14,/.test(AUTO), 'the seed must also be 14 days');
});
