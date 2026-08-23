const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const HTML = fs.readFileSync(path.join(__dirname, '../staff-portal.html'), 'utf8');

// Browsers only offer to save a credential from a real <form> containing a
// type=password field. Lose any one of these and password managers go silent
// with no error anywhere — so pin all of them.
test('login can be saved by a password manager', () => {
  const form = HTML.match(/<form id="login-form"[\s\S]*?<\/form>/);
  assert.ok(form, 'login input must live inside a <form>');
  const f = form[0];
  assert.match(f, /onsubmit="doLogin\(event\)"/, 'form must submit through doLogin');
  assert.match(f, /id="login-pin"[^>]*type="password"/, 'code field must be type=password');
  assert.match(f, /id="login-pin"[^>]*autocomplete="current-password"/);
  assert.match(f, /id="login-btn"[^>]*type="submit"|type="submit"[^>]*id="login-btn"/,
    'Log In must be the form submit button');
  assert.match(HTML, /async function doLogin\(event\)[\s\S]{0,80}event\.preventDefault\(\)/,
    'doLogin must accept and cancel the submit event');
});
