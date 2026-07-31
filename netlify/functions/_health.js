// _health.js — pure configuration inspection. No I/O, so it is unit testable.
// The point of this module is to answer "what is actually true about this
// deployment" instead of assuming. Every check that has ever silently failed
// in production belongs here.

function inspectConfig(env) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });

  add('resend_key', !!env.RESEND_API_KEY,
      env.RESEND_API_KEY ? 'present' : 'MISSING — no email can send');

  const sk = env.STRIPE_SECRET_KEY || '';
  add('stripe_key', !!sk,
      !sk ? 'MISSING — no deposit links can be created'
          : sk.startsWith('sk_test') ? 'present (TEST mode — no real money moves)'
          : 'present (live mode)');

  add('stripe_webhook_secret', !!env.STRIPE_WEBHOOK_SECRET,
      env.STRIPE_WEBHOOK_SECRET ? 'present'
        : 'MISSING — the webhook is fail-closed, so deposits will not confirm');

  add('database_url', !!env.DATABASE_URL,
      env.DATABASE_URL ? 'present' : 'MISSING');

  // Not a failure — an active allowlist is correct during phases 1-3. It is
  // reported so nobody wonders why real clients stopped receiving mail.
  add('email_allowlist', true,
      env.EMAIL_ALLOWLIST
        ? `ACTIVE — only these addresses receive mail: ${env.EMAIL_ALLOWLIST}`
        : 'not set — all recipients receive mail (production behavior)');

  return { checks, ok: checks.every(c => c.ok) };
}

module.exports = { inspectConfig };
