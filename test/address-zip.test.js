const { test } = require('node:test');
const assert = require('node:assert');
const { splitZip, normaliseAddress } = require('../netlify/functions/_address.js');

// The live value from the admin screenshot that started this.
test('a pasted full address gives up its trailing ZIP', () => {
  assert.deepStrictEqual(
    splitZip('3001 Rossmore Place Oklahoma City, OK 73120'),
    { address: '3001 Rossmore Place Oklahoma City, OK', zip: '73120' }
  );
});

test('ZIP+4 is recognised and stored as the 5-digit form', () => {
  assert.deepStrictEqual(
    splitZip('123 Main St, Edmond, OK 73013-1234'),
    { address: '123 Main St, Edmond, OK', zip: '73013' }
  );
});

// A house number is also five digits. Matching anywhere would eat it.
test('a five-digit house number is not mistaken for a ZIP', () => {
  assert.deepStrictEqual(
    splitZip('12345 Main St'),
    { address: '12345 Main St', zip: '' }
  );
});

test('an address with no ZIP is returned untouched', () => {
  assert.deepStrictEqual(splitZip('The MAC, Edmond'), { address: 'The MAC, Edmond', zip: '' });
  assert.deepStrictEqual(splitZip(''), { address: '', zip: '' });
  assert.deepStrictEqual(splitZip(null), { address: '', zip: '' });
});

// ── normaliseAddress ────────────────────────────────────────────────────────
test('a ZIP found in the address fills an empty event_zip', () => {
  const r = normaliseAddress('3001 Rossmore Place Oklahoma City, OK 73120', '');
  assert.strictEqual(r.zip, '73120');
  assert.strictEqual(r.location, '3001 Rossmore Place Oklahoma City, OK');
  assert.strictEqual(r.conflict, null);
});

// The stored ZIP is what mileage was priced from. A pasted string must never
// silently overwrite it — that would change a quote nobody agreed to.
test('an existing ZIP wins a disagreement, and the conflict is reported', () => {
  const r = normaliseAddress('123 Main St, Norman, OK 73072', '73120');
  assert.strictEqual(r.zip, '73120', 'the priced ZIP is kept');
  assert.match(r.conflict, /73072/);
  assert.match(r.conflict, /73120/);
});

test('agreement is not a conflict', () => {
  assert.strictEqual(normaliseAddress('123 Main St, OKC, OK 73120', '73120').conflict, null);
});

test('a ZIP+4 stored against a matching 5-digit address ZIP is not a conflict', () => {
  assert.strictEqual(normaliseAddress('123 Main St, OKC, OK 73120', '73120-4455').conflict, null);
});

// The address line is the one thing that must always come back stripped,
// whichever way the ZIP question resolves.
test('the address loses its ZIP in every case', () => {
  for (const zip of ['', '73120', '99999']) {
    assert.strictEqual(
      normaliseAddress('123 Main St, OKC, OK 73120', zip).location,
      '123 Main St, OKC, OK'
    );
  }
});
