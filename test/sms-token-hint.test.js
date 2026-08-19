const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// The admin SMS box's token hint was hand-written and drifted: it listed five
// tokens while renderSms supported twelve, so {{service_name}} and
// {{review_link}} looked unsupported and {{balance_link}} was invisible. A
// stale hint is worse than none — it reads as a whitelist. This pins the two
// together so adding a token to renderSms without listing it fails here.
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const tokensIn = (src, re) => new Set([...src.matchAll(re)].map((m) => m[1]));

test('the admin SMS token hint lists exactly the tokens renderSms resolves', () => {
  const code = tokensIn(read('netlify/functions/_sms.js'), /\.replace\(\/\{\{([a-z_]+)\}\}\/g/g);
  const hint = tokensIn(read('admin.html').split("SMS text")[1].split('</p>')[0], /'([a-z_]+)'/g);

  assert.ok(code.size >= 17, `expected renderSms to resolve at least 17 tokens, found ${code.size}`);

  const missing = [...code].filter((t) => !hint.has(t));
  assert.deepStrictEqual(missing, [], `renderSms resolves these but the admin hint omits them: ${missing.join(', ')}`);

  const phantom = [...hint].filter((t) => !code.has(t));
  assert.deepStrictEqual(phantom, [], `the admin hint advertises tokens renderSms does not resolve: ${phantom.join(', ')}`);
});
