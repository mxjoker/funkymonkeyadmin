const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const BOOKINGS = read('netlify/functions/bookings.js');
const CREATE = read('netlify/functions/create-bookings.js');
const { sourceOf, platformBooked } = require('../netlify/functions/_source.js');

// Neither create path stored 'source' at all. Only booking.js PATCH did, so the
// only way a booking ever got one was an admin opening it afterwards and
// setting "Booked Via" by hand. All three GigSalad bookings in production
// arrived as 'direct', and one carried a $465 balance GigSalad had collected.
test('both create paths write the source column', () => {
  for (const [name, src] of [['bookings.js', BOOKINGS], ['create-bookings.js', CREATE]]) {
    const insert = src.split('INSERT INTO bookings')[1].split('RETURNING')[0];
    assert.ok(/\bsource\b/.test(insert.split('VALUES')[0]), name + ' must name the source column');
    assert.ok(/referral_source/.test(insert.split('VALUES')[0]), name + ': referral_source is a different field and stays');
  }
});

// bookings.js POST is the PUBLIC booking form as well as admin entry. A
// platform source suppresses every payment request, so an anonymous caller who
// could set it would be posting themselves a booking we never bill.
test('a non-direct source on the public endpoint requires an admin token', () => {
  const guard = BOOKINGS.split('let source = DIRECT;')[1].split('}')[0];
  assert.ok(/requireAuth\(event, \['admin'\]\)/.test(guard), 'it must check the token, not the payload');
  assert.ok(/if \(!auth\) return unauthorized\(\);/.test(guard), 'and refuse without one');
  const gated = BOOKINGS.indexOf('let source = DIRECT;');
  assert.ok(gated < BOOKINGS.indexOf('INSERT INTO bookings'), 'the gate must precede the write');
});

test('the public path still costs one round trip when nothing is claimed', () => {
  assert.ok(/if \(sourceOf\(b\) !== DIRECT\) \{/.test(BOOKINGS),
    'auth must only be checked when a platform source is actually asked for');
});

// A platform collected from the client, so we are owed nothing. Creating the
// booking with a balance is what produced the $465.
test('a platform booking is created owing nothing', () => {
  assert.ok(/platformBooked\(\{ source \}\)\n?\s*\? 0/.test(BOOKINGS), 'bookings.js must zero it');
  assert.ok(/platformBooked\(\{ source \}\) \|\| String\(b\.status\) === 'completed'/.test(CREATE),
    'create-bookings.js must zero it too');
});

test('an explicitly supplied balance still wins in the import seam', () => {
  assert.ok(/b\.balance_due !== undefined \? num\(b\.balance_due\)/.test(CREATE),
    'a caller correcting a figure by hand outranks the derivation');
});

// The decider itself, unchanged but worth pinning: anything unrecognised must
// read as direct, which is what keeps every pre-existing row behaving as before.
test('an unrecognised source reads as direct', () => {
  assert.strictEqual(sourceOf({ source: 'thumbtack' }), 'direct');
  assert.strictEqual(sourceOf({ source: null }), 'direct');
  assert.strictEqual(sourceOf({ source: 'GigSalad' }), 'gigsalad', 'case must not matter');
  assert.strictEqual(platformBooked({ source: 'gigsalad' }), true);
  assert.strictEqual(platformBooked({}), false);
});
