const { test } = require('node:test');
const assert = require('node:assert');

// Fresh module per test — _email.js reads env at call time, but we also want
// to reset the fetch stub between cases.
function loadEmail() {
  delete require.cache[require.resolve('../netlify/functions/_email.js')];
  return require('../netlify/functions/_email.js');
}

function stubFetch(response) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    return {
      ok: response.ok !== false,
      json: async () => response.json ?? { id: 'test-id-123' }
    };
  };
  return calls;
}

test('allowlist blocks a non-listed recipient', async () => {
  process.env.RESEND_API_KEY = 'test-key';
  process.env.EMAIL_ALLOWLIST = 'joe.coover@gmail.com';
  const calls = stubFetch({ ok: true });
  const { sendEmail } = loadEmail();

  await sendEmail('troy@example.com', 'Gig tomorrow', '<p>hi</p>');

  assert.strictEqual(calls.length, 0, 'must not call Resend for a blocked address');
});

test('allowlist permits a listed recipient', async () => {
  process.env.RESEND_API_KEY = 'test-key';
  process.env.EMAIL_ALLOWLIST = 'joe.coover@gmail.com';
  const calls = stubFetch({ ok: true });
  const { sendEmail } = loadEmail();

  await sendEmail('joe.coover@gmail.com', 'Test', '<p>hi</p>');

  assert.strictEqual(calls.length, 1, 'must call Resend for an allowed address');
});

test('allowlist is case-insensitive and tolerates spaces', async () => {
  process.env.RESEND_API_KEY = 'test-key';
  process.env.EMAIL_ALLOWLIST = ' joe.coover@gmail.com , other@x.com ';
  const calls = stubFetch({ ok: true });
  const { sendEmail } = loadEmail();

  await sendEmail('JOE.COOVER@GMAIL.COM', 'Test', '<p>hi</p>');

  assert.strictEqual(calls.length, 1, 'matching must ignore case and padding');
});

test('unset allowlist permits everyone (production behavior)', async () => {
  process.env.RESEND_API_KEY = 'test-key';
  delete process.env.EMAIL_ALLOWLIST;
  const calls = stubFetch({ ok: true });
  const { sendEmail } = loadEmail();

  await sendEmail('anyone@example.com', 'Test', '<p>hi</p>');

  assert.strictEqual(calls.length, 1, 'no allowlist means no filtering');
});

test('throws when Resend returns its error shape', async () => {
  process.env.RESEND_API_KEY = 'test-key';
  delete process.env.EMAIL_ALLOWLIST;
  stubFetch({ ok: false, json: { statusCode: 403, message: 'Domain not verified', name: 'validation_error' } });
  const { sendEmail } = loadEmail();

  await assert.rejects(
    () => sendEmail('anyone@example.com', 'Test', '<p>hi</p>'),
    /Domain not verified/,
    'a Resend rejection must throw, not return quietly'
  );
});

test('throws when the API key is missing', async () => {
  delete process.env.RESEND_API_KEY;
  delete process.env.EMAIL_ALLOWLIST;
  stubFetch({ ok: true });
  const { sendEmail } = loadEmail();

  await assert.rejects(
    () => sendEmail('anyone@example.com', 'Test', '<p>hi</p>'),
    /RESEND_API_KEY/,
    'a missing key is a configuration failure, not a silent no-op'
  );
});

test('returns the Resend id on success', async () => {
  process.env.RESEND_API_KEY = 'test-key';
  delete process.env.EMAIL_ALLOWLIST;
  stubFetch({ ok: true, json: { id: 'resend-abc-123' } });
  const { sendEmail } = loadEmail();

  const result = await sendEmail('anyone@example.com', 'Test', '<p>hi</p>');

  assert.strictEqual(result.id, 'resend-abc-123');
});
