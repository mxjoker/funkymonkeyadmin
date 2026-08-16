# Balance Link and Service Fee Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin email a client a Stripe link for the balance owed, carrying a 5% service fee shown as its own line, without the fee ever touching `balance_due` and without a balance payment being mis-recorded as a deposit.

**Architecture:** The fee is one pure function in `_items.js` (`balanceCharge`) computed from `balance_due` at link-creation time. `create-stripe-link.js` gains a `kind: 'balance'` mode that reads the amount from the database rather than the browser and builds a two-line-item session. The Stripe session carries `metadata[payment_kind]`, and `stripe-webhook.js` branches on it through a second pure function (`paymentEffect`) so a balance payment zeroes the balance instead of overwriting the deposit. The balance link is persisted in its own column, `stripe_balance_link`, so the four existing readers of `stripe_payment_link` keep their current meaning.

**Tech Stack:** Node 18 CommonJS Netlify Functions, `pg` against Neon, `node --test` with `node:assert`, static HTML admin page with pure helpers extracted into a `vm` context for tests.

## Global Constraints

- **The fee is 5% of `balance_due`, one formula, no special cases.** `balance_due` is already `total_price + mileage_cost - deposit_amount`, so a no-deposit booking's balance is the whole amount and needs no separate rule.
- **The fee must NEVER be written into `balance_due`, or into `total_price`, `deposit_amount` or `mileage_cost`.** `_items.js:151`'s `balanceIsDerivable()` would then fail permanently for that booking and `booking.js:269` would refuse every subsequent balance recompute. See `docs/superpowers/specs/2026-08-16-balance-link-and-late-fee.md`.
- **It is a service fee, not a card surcharge** (Joe, 2026-08-16). Client-facing copy says "Service fee (5%)". Never "card fee", "processing fee" or "surcharge" — a 5% card-only surcharge exceeds Stripe's ~2.9% + 30¢ cost of acceptance and would fall under Visa/Mastercard surcharge rules.
- **Client-facing money is always itemised, never blended:** `Balance` / `Service fee (5%)` / `Total due`, three lines, in both the email and the Stripe checkout page.
- **`deposit_amount` is authoritative and `0` is a legitimate value.** Schools and libraries deliberately have a $0 deposit; `booking.js:349` already refuses to mint a link for one. No code may fall back to a non-zero default.
- **The fee applies to any balance payment, whenever it is paid.** No event-date comparison (supersedes the spec's third open question).
- **`create-stripe-link.js` stays `requireAuth(['admin'])`.** No public endpoint may mint a Stripe session.
- **Tests run with `npm test`** (`node --test 'test/**/*.test.js'`). 331 tests pass on `main` at `c5999b3`; that number only goes up.

## Decisions that supersede the spec

The spec at `docs/superpowers/specs/2026-08-16-balance-link-and-late-fee.md` is otherwise the source of truth. Three things changed after it was written, and Task 2 amends the spec file itself:

1. **No event-date trigger.** The fee applies to any balance paid through the link, before or after the event. The spec's "Does the fee apply to a balance paid before the event?" open question is closed: it does.
2. **`stripe_payment_link` keeps its meaning; the balance link gets its own column.** The spec left this open. Making the existing column mean "current outstanding link" would silently change behaviour under four readers: `finalise.js:31` publishes it to the client, `my-booking.html:568` hardcodes the button text "Pay Deposit Now", `admin.html:1151` builds the deposit worklist from its *absence*, and `admin.html:1874` labels it "Last link".
3. **`stripe-webhook.js` is in scope.** The spec does not mention it. It is a prerequisite — see Task 3.

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `admin.html` | Modify: pure helpers `1412-1489`, modal render `~1871`, `sendStripeLink` `2744-2780` | Buttons that name the amount they will charge; the new balance button |
| `netlify/functions/_items.js` | Modify: append near `balanceIsDerivable` (`151`) | `SERVICE_FEE_RATE`, `balanceCharge()` — the one definition of the fee |
| `netlify/functions/stripe-webhook.js` | Modify: `52-180` | `paymentEffect()` and the deposit/balance branch |
| `netlify/functions/create-stripe-link.js` | Modify: whole handler | `kind: 'balance'` mode, two line items, `stripe_balance_link`, balance email |
| `netlify/functions/bookings.js` | Modify: `128` ALTER list | Schema for `stripe_balance_link` |
| `test/admin-link-buttons.test.js` | Create | Deposit and balance button amounts |
| `test/balance-fee.test.js` | Create | Fee arithmetic and `paymentEffect` |
| `test/stripe-link-params.test.js` | Create | Stripe session line items and metadata |

---

### Task 1: Stop the $100 demand and put the amount on the deposit button

`admin.html:2750` reads `Number(b.deposit_amount) || 100`, so a booking with a deliberate $0 deposit gets a **$100** Stripe demand. This is a live bug independent of everything else, and it must land before the button is relabelled with its amount — otherwise the button prints "Send $100 deposit link" on a booking that owes nothing.

**Files:**
- Modify: `admin.html` (pure-helper block ends `1489`; modal render `1868-1877`; `sendStripeLink` `2744-2750`)
- Test: `test/admin-link-buttons.test.js` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `depositLinkAmount(b) -> number` inside admin.html's pure-helper block, returning `0` for anything not a positive finite number. Task 5 adds a sibling to the same block and extends the same test file.

- [ ] **Step 1: Write the failing test**

Create `test/admin-link-buttons.test.js`. It extracts the pure-helper block from `admin.html` and runs it in a bare `vm` context, exactly as `test/bookings-sort.test.js` already does — if a helper ever reaches for `document`, the test throws instead of silently passing against a stub.

```js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const HTML = fs.readFileSync(path.join(__dirname, '../admin.html'), 'utf8');

function loadHelpers() {
  const a = HTML.indexOf('// ══ PURE HELPERS');
  const b = HTML.indexOf('// ══ END PURE HELPERS');
  assert.ok(a !== -1 && b !== -1, 'pure-helper sentinels missing from admin.html');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(HTML.slice(a, b) + '\nout = { depositLinkAmount };', ctx);
  return ctx.out;
}

const { depositLinkAmount } = loadHelpers();

// The bug this file exists for: a school or library booking is deliberately
// $0 deposit, and the old `Number(b.deposit_amount) || 100` billed it $100 for
// money the booking never asked for.
test('a deliberate $0 deposit charges nothing, not $100', () => {
  assert.strictEqual(depositLinkAmount({ deposit_amount: 0 }), 0);
  assert.strictEqual(depositLinkAmount({ deposit_amount: '0' }), 0);
  assert.strictEqual(depositLinkAmount({ deposit_amount: null }), 0);
  assert.strictEqual(depositLinkAmount({}), 0);
});

test('a real deposit passes through, including as a NUMERIC string from pg', () => {
  assert.strictEqual(depositLinkAmount({ deposit_amount: 100 }), 100);
  assert.strictEqual(depositLinkAmount({ deposit_amount: '150.00' }), 150);
});

test('junk never becomes a charge', () => {
  assert.strictEqual(depositLinkAmount({ deposit_amount: -50 }), 0);
  assert.strictEqual(depositLinkAmount({ deposit_amount: 'abc' }), 0);
  assert.strictEqual(depositLinkAmount({ deposit_amount: Infinity }), 0);
});

// The literal that caused it, gone for good.
test('the $100 fallback literal is not in admin.html any more', () => {
  assert.ok(!/deposit_amount\s*\)\s*\|\|\s*100/.test(HTML),
    'the `Number(b.deposit_amount) || 100` fallback is back');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern="deposit"` or simply `node --test test/admin-link-buttons.test.js`
Expected: FAIL — `depositLinkAmount is not defined`.

- [ ] **Step 3: Add the helper**

In `admin.html`, immediately before the `// ══ END PURE HELPERS ══` line at `1489`:

```js
// What the deposit button will actually charge. `deposit_amount` is
// authoritative and 0 is a legitimate value: schools and libraries are
// deliberately no-deposit, and booking.js:349 already refuses to mint a link
// for one. The previous `Number(b.deposit_amount) || 100` sent those bookings
// a $100 Stripe demand for money nobody asked them for.
function depositLinkAmount(b) {
  const n = Number(b && b.deposit_amount);
  return isFinite(n) && n > 0 ? n : 0;
}
```

- [ ] **Step 4: Use it in `sendStripeLink`**

In `admin.html:2750`, replace:

```js
  const depositAmount = Number(b.deposit_amount) || 100;
```

with:

```js
  const depositAmount = depositLinkAmount(b);
  if (depositAmount <= 0) {
    el.textContent = '❌ This booking has a $0 deposit — nothing to charge.';
    return;
  }
```

- [ ] **Step 5: Put the amount on the button**

In `admin.html`, replace the Stripe deposit block at `1868-1877`:

```html
    <!-- Stripe link -->
    <div class="stripe-block">
      <div style="display:flex;align-items:center;justify-content:space-between">
        <strong style="font-size:.875rem">💳 Stripe Deposit Link</strong>
        <button class="btn btn-primary btn-sm" onclick="sendStripeLink('${b.id}')">Send to Client</button>
      </div>
      ${b.stripe_payment_link?`<div class="stripe-result">Last link: <a href="${b.stripe_payment_link}" target="_blank" style="color:#7c3aed">Open →</a></div>`:''}
      <div class="stripe-result" id="stripe-msg-${b.id}"></div>
    </div>`}
```

with:

```html
    <!-- Stripe link -->
    <div class="stripe-block">
      <div style="display:flex;align-items:center;justify-content:space-between">
        <strong style="font-size:.875rem">💳 Stripe Deposit Link</strong>
        ${depositLinkAmount(b) > 0
          ? `<button class="btn btn-primary btn-sm" onclick="sendStripeLink('${b.id}')">Send $${depositLinkAmount(b).toFixed(2)} deposit link</button>`
          : `<span style="font-size:.75rem;color:#6b7280">No deposit on this booking</span>`}
      </div>
      ${b.stripe_payment_link?`<div class="stripe-result">Last link: <a href="${b.stripe_payment_link}" target="_blank" style="color:#7c3aed">Open →</a></div>`:''}
      <div class="stripe-result" id="stripe-msg-${b.id}"></div>
    </div>`}
```

- [ ] **Step 6: Run the tests**

Run: `npm test`
Expected: PASS, and the total test count is higher than 331.

- [ ] **Step 7: Commit**

```bash
git add admin.html test/admin-link-buttons.test.js
git commit -m "fix(admin): never bill a \$100 fallback deposit, and label the button with its amount"
```

---

### Task 2: The fee, defined once

**Files:**
- Modify: `netlify/functions/_items.js` (append after `balanceIsDerivable`, `151-155`; extend `module.exports`, `157-160`)
- Modify: `docs/superpowers/specs/2026-08-16-balance-link-and-late-fee.md` (close two open questions)
- Test: `test/balance-fee.test.js` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `SERVICE_FEE_RATE` (number, `0.05`) and `balanceCharge(row) -> { balance: number, fee: number, total: number }`, both exported from `_items.js`. Task 4 calls `balanceCharge`; Task 5 mirrors the rate client-side.

- [ ] **Step 1: Write the failing test**

Create `test/balance-fee.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { balanceCharge, SERVICE_FEE_RATE, balanceIsDerivable } = require('../netlify/functions/_items.js');

test('the fee is 5% of the balance, itemised', () => {
  const c = balanceCharge({ balance_due: 400 });
  assert.deepStrictEqual(c, { balance: 400, fee: 20, total: 420 });
});

// The whole point of one formula: no deposit means balance_due IS the whole
// amount, so the no-deposit case needs no special rule.
test('a booking that never took a deposit is charged on its whole amount', () => {
  const c = balanceCharge({ balance_due: 385 });
  assert.strictEqual(c.fee, 19.25);
  assert.strictEqual(c.total, 404.25);
});

test('money is rounded to cents and the three lines always add up', () => {
  const c = balanceCharge({ balance_due: 333.33 });
  assert.strictEqual(c.fee, 16.67);
  assert.strictEqual(c.total, 350);
  assert.strictEqual(Math.round((c.balance + c.fee) * 100), Math.round(c.total * 100));
});

test('pg NUMERIC strings are money too', () => {
  assert.strictEqual(balanceCharge({ balance_due: '400.00' }).fee, 20);
});

test('nothing owed means nothing charged', () => {
  for (const v of [0, null, undefined, -100, 'abc']) {
    assert.deepStrictEqual(balanceCharge({ balance_due: v }), { balance: 0, fee: 0, total: 0 },
      `balance_due=${v} should charge nothing`);
  }
  assert.deepStrictEqual(balanceCharge(null), { balance: 0, fee: 0, total: 0 });
});

// The invariant the whole design hangs on. Folding the fee into balance_due
// would make the stored balance permanently un-derivable, and booking.js:269
// would then refuse to recompute this booking's balance ever again.
test('computing the fee does not touch the row, so the balance stays derivable', () => {
  const row = { total_price: 500, mileage_cost: 0, deposit_amount: 100, balance_due: 400 };
  const before = JSON.stringify(row);
  const c = balanceCharge(row);
  assert.strictEqual(JSON.stringify(row), before, 'balanceCharge mutated the booking row');
  assert.strictEqual(c.fee, 20);
  assert.ok(balanceIsDerivable(row), 'balance stopped being derivable');
  // And the fee is emphatically not the balance.
  assert.notStrictEqual(c.total, Number(row.balance_due));
});

test('the rate is a single named constant', () => {
  assert.strictEqual(SERVICE_FEE_RATE, 0.05);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/balance-fee.test.js`
Expected: FAIL — `balanceCharge is not a function`.

- [ ] **Step 3: Implement**

In `netlify/functions/_items.js`, after `balanceIsDerivable` (ends line `155`) and before `module.exports`:

```js
// A balance paid through the Stripe link carries a 5% service fee.
//
// One formula, no special cases: balance_due is already
// total + mileage - deposit, so a booking that never took a deposit has a
// balance equal to the whole amount and needs no separate rule.
//
// It is a SERVICE fee, not a card surcharge (Joe, 2026-08-16). A 5% card-only
// surcharge would exceed Stripe's ~2.9% + 30¢ cost of acceptance and fall
// under Visa/Mastercard surcharge rules. Client-facing copy must never call
// it a card, processing or convenience fee.
//
// The fee is computed here at link-creation time and lives only on the Stripe
// session and in the email. It must NEVER be written into balance_due:
// balanceIsDerivable() above would fail for this booking forever, and
// booking.js:269 would refuse every later balance recompute — the exact guard
// that stops a paid customer being re-billed.
//
// ponytail: a constant, not a column. Waiving the fee on one booking needs a
// code change; if that ever comes up, a nullable bookings.service_fee_rate
// defaulting to 0.05 is the upgrade path.
const SERVICE_FEE_RATE = 0.05;

const toCents = (n) => Math.round(n * 100) / 100;

function balanceCharge(row) {
  const raw = Number(row && row.balance_due);
  const balance = isFinite(raw) && raw > 0 ? toCents(raw) : 0;
  const fee = toCents(balance * SERVICE_FEE_RATE);
  return { balance, fee, total: toCents(balance + fee) };
}
```

Extend the exports at the bottom of the file:

```js
module.exports = {
  ITEM_KINDS, ensureBookingItems, normaliseItems, rollupItems,
  getItems, getItemsForBookings, replaceItems, balanceIsDerivable,
  SERVICE_FEE_RATE, balanceCharge,
};
```

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Amend the spec to match the decisions taken**

In `docs/superpowers/specs/2026-08-16-balance-link-and-late-fee.md`, replace the "Open questions for implementation" section (lines `102-112`) with:

```markdown
## Open questions — closed 2026-08-16

- **Where does the fee percentage live?** A constant, `SERVICE_FEE_RATE` in
  `_items.js`. Waiving the fee on one booking would need a code change; the
  upgrade path (a nullable `service_fee_rate` column) is noted there.
- **Should a $0 balance offer a link at all?** No. `create-stripe-link.js`
  400s on a balance of 0, and the admin button is hidden.
- **Does the fee apply to a balance paid *before* the event?** Yes. Joe,
  2026-08-16: the trigger is paying the balance through the link, not the
  event date having passed. No date comparison is implemented.
- **Which column holds the balance link?** Its own, `stripe_balance_link`.
  `stripe_payment_link` keeps meaning "the deposit link" — `finalise.js:31`,
  `my-booking.html:568`, `admin.html:1151` and `admin.html:1874` all read it
  with that meaning today.
```

- [ ] **Step 6: Commit**

```bash
git add netlify/functions/_items.js test/balance-fee.test.js docs/superpowers/specs/2026-08-16-balance-link-and-late-fee.md
git commit -m "feat(money): define the 5% balance service fee in one place"
```

---

### Task 3: Teach the Stripe webhook what kind of payment it received

**This is a prerequisite, not a nicety.** `stripe-webhook.js:106-119` treats every completed checkout session as a deposit: it sets `deposit_paid=TRUE`, overwrites `deposit_amount` with whatever was paid, forces `status='confirmed'` and recomputes `balance_due = total + mileage - amountPaid`. A client paying a $420 balance link on a $500 booking would lose the record of their $100 deposit, be shown **$80 still owed after paying in full**, have a completed booking dragged back to `confirmed`, and receive an email titled *"Deposit received — You're CONFIRMED! 🎊"* after their event. Ship the balance link without this and the first client to use it gets a corrupted booking.

**Files:**
- Modify: `netlify/functions/stripe-webhook.js` (`52-180`, plus a new export at the end of file)
- Test: `test/balance-fee.test.js` (extend — same money path, same file)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `module.exports.paymentEffect(booking, amountPaid, kind) -> { kind, deposit_paid, deposit_amount, payment_method, status, balance_due, logAction }`, exported from `stripe-webhook.js` for tests (same pattern as `booking.js:438`'s `paymentLogEntry`). Task 4 writes the `metadata[payment_kind]` this reads.

- [ ] **Step 1: Write the failing test**

Append to `test/balance-fee.test.js`:

```js
const { paymentEffect } = require('../netlify/functions/stripe-webhook.js');

const PAID_DEPOSIT = {
  total_price: 500, mileage_cost: 0, deposit_amount: 100, balance_due: 400,
  deposit_paid: true, payment_method: 'stripe', status: 'completed',
};

// Before payment_kind existed, this row paying its $420 balance link came back
// with deposit_amount=420, status='confirmed' and balance_due=80 — $80 still
// owed by someone who had just paid in full.
test('a balance payment clears the balance and leaves the deposit alone', () => {
  const e = paymentEffect(PAID_DEPOSIT, 420, 'balance');
  assert.strictEqual(e.kind, 'balance');
  assert.strictEqual(e.balance_due, 0);
  assert.strictEqual(e.deposit_amount, 100, 'the balance payment overwrote the deposit');
  assert.strictEqual(e.deposit_paid, true);
  assert.strictEqual(e.status, 'completed', 'a completed booking was dragged back to confirmed');
  assert.match(e.logAction, /Balance/);
});

// The fee is part of what was charged, never part of what was owed.
test('the service fee does not survive into balance_due as a credit or a debt', () => {
  const e = paymentEffect(PAID_DEPOSIT, 420, 'balance');
  assert.strictEqual(e.balance_due, 0);
  assert.notStrictEqual(e.balance_due, -20);
});

test('a no-deposit booking paying its whole amount by balance link ends up settled', () => {
  const row = { total_price: 300, mileage_cost: 25, deposit_amount: 0, balance_due: 325,
                deposit_paid: false, payment_method: '', status: 'confirmed' };
  const e = paymentEffect(row, 341.25, 'balance');
  assert.strictEqual(e.balance_due, 0);
  assert.strictEqual(e.deposit_amount, 0);
  assert.strictEqual(e.deposit_paid, false);
});

// Regression: the deposit path must behave exactly as it did before the branch.
test('a deposit payment still confirms the booking and derives the balance', () => {
  const row = { total_price: 500, mileage_cost: 30, deposit_amount: 0, balance_due: 530,
                deposit_paid: false, payment_method: '', status: 'accepted' };
  const e = paymentEffect(row, 100, 'deposit');
  assert.strictEqual(e.kind, 'deposit');
  assert.strictEqual(e.deposit_paid, true);
  assert.strictEqual(e.deposit_amount, 100);
  assert.strictEqual(e.status, 'confirmed');
  assert.strictEqual(e.balance_due, 430);
  assert.strictEqual(e.payment_method, 'stripe');
});

// Every session created before this change carries no payment_kind at all.
test('a session with no payment_kind is treated as a deposit, as it always was', () => {
  const row = { total_price: 200, mileage_cost: 0, deposit_amount: 0, balance_due: 200,
                deposit_paid: false, payment_method: '', status: 'accepted' };
  for (const kind of [undefined, null, '', 'nonsense']) {
    assert.strictEqual(paymentEffect(row, 100, kind).kind, 'deposit', `kind=${kind}`);
  }
});

test('overpaying a deposit never produces a negative balance', () => {
  const row = { total_price: 100, mileage_cost: 0, deposit_amount: 0, balance_due: 100,
                deposit_paid: false, payment_method: '', status: 'accepted' };
  assert.strictEqual(paymentEffect(row, 150, 'deposit').balance_due, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/balance-fee.test.js`
Expected: FAIL — `paymentEffect is not a function`.

- [ ] **Step 3: Add the pure function**

In `netlify/functions/stripe-webhook.js`, immediately after the `verifySig` helper (ends line `15`):

```js
// What a completed checkout session does to the booking row. Pure, so both
// kinds can be tested without Stripe or a database.
//
// A balance payment is NOT a deposit. Before create-stripe-link.js started
// stamping metadata[payment_kind], this handler treated every session as one:
// it overwrote deposit_amount with whatever was paid, recomputed
// balance_due as total + mileage - <that>, and forced status back to
// 'confirmed'. A client paying a $420 balance link on a $500 booking lost the
// record of their $100 deposit and was still shown $80 owed after paying in
// full — and got a "Deposit received!" email after their event.
//
// The balance branch sets balance_due to 0 rather than subtracting what was
// paid: the payment includes the service fee, so subtracting it would leave a
// negative. Zeroing deliberately makes the balance un-derivable, which is
// correct — it is exactly the "settled out-of-band" state that
// _items.js:151 detects and booking.js:269 protects.
function paymentEffect(booking, amountPaid, kind) {
  const b = booking || {};
  if (kind === 'balance') {
    return {
      kind: 'balance',
      deposit_paid: b.deposit_paid === true,
      deposit_amount: Number(b.deposit_amount) || 0,
      payment_method: b.payment_method || '',
      status: b.status || 'confirmed',
      balance_due: 0,
      logAction: 'Balance paid via Stripe',
    };
  }
  const totalCents   = Math.round((parseFloat(b.total_price)  || 0) * 100);
  const mileageCents = Math.round((parseFloat(b.mileage_cost) || 0) * 100);
  const paidCents    = Math.round((Number(amountPaid) || 0) * 100);
  return {
    kind: 'deposit',
    deposit_paid: true,
    deposit_amount: Number(amountPaid) || 0,
    payment_method: 'stripe',
    status: 'confirmed',
    balance_due: Math.max(0, totalCents + mileageCents - paidCents) / 100,
    logAction: 'Deposit paid via Stripe',
  };
}
```

At the very end of the file, after the handler's closing `};`:

```js
// Exported for tests — the handler itself needs Stripe and a database.
module.exports.paymentEffect = paymentEffect;
```

- [ ] **Step 4: Run the new tests**

Run: `node --test test/balance-fee.test.js`
Expected: PASS.

- [ ] **Step 5: Use it in the handler**

In `stripe-webhook.js`, replace the balance arithmetic and UPDATE at `99-121`:

```js
          // Calculate balance_due in integer cents to avoid float drift
          const totalCents   = Math.round((parseFloat(booking.total_price)  || 0) * 100);
          const mileageCents = Math.round((parseFloat(booking.mileage_cost) || 0) * 100);
          const balanceCents = Math.max(0, totalCents + mileageCents - amountPaidCents);
          const balanceDue   = balanceCents / 100;

          // Mark deposit paid, set status confirmed, store session/intent, update balance
          const updated = await c.query(
            `UPDATE bookings
             SET deposit_paid=TRUE,
                 deposit_paid_at=NOW(),
                 deposit_amount=$1,
                 payment_method='stripe',
                 status='confirmed',
                 stripe_session_id=$2,
                 stripe_payment_intent_id=$3,
                 balance_due=$4
             WHERE id=$5
             RETURNING *`,
            [amountPaid, sessionId, paymentIntentId, balanceDue, booking.id]
          );
          const b = updated.rows[0];
          await logChange(c, b.id, 'Deposit paid via Stripe', `$${amountPaid.toFixed(2)}`);
```

with:

```js
          // create-stripe-link.js stamps metadata[payment_kind]. Anything
          // else — including every session minted before that existed — is a
          // deposit, which is what this handler always assumed.
          const kind = session.metadata?.payment_kind === 'balance' ? 'balance' : 'deposit';
          const effect = paymentEffect(booking, amountPaid, kind);
          const balanceDue = effect.balance_due;

          // The balance owed BEFORE this payment, so the receipt can itemise
          // what was actually charged. Read from the row, not from the
          // session, so a tampered session cannot rewrite the arithmetic.
          const balanceBefore = Math.max(0, Number(booking.balance_due) || 0);
          const feePaid = Math.max(0, Math.round((amountPaid - balanceBefore) * 100) / 100);

          const updated = await c.query(
            `UPDATE bookings
             SET deposit_paid=$1,
                 deposit_paid_at = CASE WHEN $2::boolean THEN NOW() ELSE deposit_paid_at END,
                 deposit_amount=$3,
                 payment_method=$4,
                 status=$5,
                 stripe_session_id=$6,
                 stripe_payment_intent_id=$7,
                 balance_due=$8
             WHERE id=$9
             RETURNING *`,
            [effect.deposit_paid, effect.kind === 'deposit', effect.deposit_amount,
             effect.payment_method, effect.status, sessionId, paymentIntentId,
             balanceDue, booking.id]
          );
          const b = updated.rows[0];
          await logChange(c, b.id, effect.logAction,
            effect.kind === 'balance'
              ? `$${amountPaid.toFixed(2)} (balance $${balanceBefore.toFixed(2)} + service fee $${feePaid.toFixed(2)})`
              : `$${amountPaid.toFixed(2)}`);
```

- [ ] **Step 6: Branch the client email**

The existing client email block (`127-149`) is the deposit one. Wrap it so it only runs for a deposit, and add the balance receipt. Replace the line:

```js
          // Client confirmation email
          try {
```

with:

```js
          // Client email — a balance receipt is not a deposit confirmation.
          // Sending the existing "You're CONFIRMED!" copy to someone settling
          // up after their event reads as if we had lost track of them.
          if (effect.kind === 'balance') {
            const subject = "Payment received — you're all paid up! 🎉 Funky Monkey Events";
            try {
              const res = await sendEmail(b.client_email, subject,
                wrap(`<p style="font-size:16px;margin-bottom:16px">Hi <strong>${esc(b.client_name)}</strong>! 🎉</p>
                  <p style="color:#A78BCA;line-height:1.7;margin-bottom:20px">Thank you — your balance for <strong style="color:#F3E8FF">${esc(b.service_name)}</strong> is settled in full.</p>
                  <div style="background:#1A1035;border-radius:12px;padding:16px;margin-bottom:20px">
                    <table style="width:100%;border-collapse:collapse;color:#F3E8FF;font-size:14px">
                      <tr><td style="padding:4px 0;color:#A78BCA">Balance</td><td style="padding:4px 0;text-align:right">$${balanceBefore.toFixed(2)}</td></tr>
                      <tr><td style="padding:4px 0;color:#A78BCA">Service fee (5%)</td><td style="padding:4px 0;text-align:right">$${feePaid.toFixed(2)}</td></tr>
                      <tr><td style="padding:8px 0 0;border-top:1px solid #3D2460;font-weight:900">Total paid</td><td style="padding:8px 0 0;border-top:1px solid #3D2460;text-align:right;color:#10B981;font-size:18px;font-weight:900">$${amountPaid.toFixed(2)}</td></tr>
                    </table>
                  </div>
                  <p style="color:#A78BCA;font-size:13px;text-align:center">Booking ref: ${esc(b.reference)} · Questions? <a href="tel:4054316625" style="color:#06B6D4;font-weight:700">(405) 431-6625</a></p>`));
              await logEmail(c, b.id, null, 'Balance Paid', subject, b.client_email, 'client', logStatus(res));
            } catch (emailErr) {
              console.error("Webhook: balance receipt failed:", emailErr.message);
              await logEmail(c, b.id, null, 'Balance Paid', subject, b.client_email, 'client', 'failed', emailErr.message);
            }
          } else {
          // Client confirmation email
          try {
```

Close that `else` after the deposit email's `catch` block (currently ending line `149`, immediately before the `// Admin notification email` comment) by adding a `}` on its own line.

- [ ] **Step 7: Branch the admin email subject**

Replace the two admin-email subject strings at `155`, `169` and `172` — currently `` `💰 Deposit In: ${b.client_name} — $${amountPaid.toFixed(2)}` `` in all three places — by defining the subject once above the admin email `try` block:

```js
          const adminSubject = effect.kind === 'balance'
            ? `💰 Balance In: ${b.client_name} — $${amountPaid.toFixed(2)}`
            : `💰 Deposit In: ${b.client_name} — $${amountPaid.toFixed(2)}`;
          const adminTrigger = effect.kind === 'balance' ? 'Balance Paid' : 'Deposit Paid';
```

and using `adminSubject` / `adminTrigger` in the `sendEmail` call and both `logEmail` calls. Leave the admin email body as it is — the figures in it are read from `b`, which is now correct for both kinds.

- [ ] **Step 8: Run the full suite**

Run: `npm test`
Expected: PASS, count higher than after Task 2.

- [ ] **Step 9: Commit**

```bash
git add netlify/functions/stripe-webhook.js test/balance-fee.test.js
git commit -m "fix(stripe): a balance payment is not a deposit"
```

---

### Task 4: Balance mode on `create-stripe-link.js`

The endpoint already takes an `amount` and already persists and emails. Balance mode adds a second line item rather than a second endpoint — but the amount comes from the **database**, not the request body: the browser may not name the price of a balance.

**Files:**
- Modify: `netlify/functions/create-stripe-link.js` (whole handler)
- Modify: `netlify/functions/bookings.js:128` (ALTER list)
- Test: `test/stripe-link-params.test.js` (create)

**Interfaces:**
- Consumes: `balanceCharge`, `SERVICE_FEE_RATE` from `_items.js` (Task 2). `metadata[payment_kind]` is read by `paymentEffect` (Task 3).
- Produces: `module.exports.buildSessionParams({ kind, amount, fee, service, client, email, bookingRef, bookingId, dbId }) -> URLSearchParams`, exported for tests. The endpoint accepts `{ bookingId | bookingRef, kind?: 'deposit' | 'balance', amount?, client, email, service, skip_client_email? }` and returns `{ url, sessionId, kind, balance?, fee?, total? }`. Task 5 posts `kind: 'balance'` and reads the returned totals.

- [ ] **Step 1: Write the failing test**

Create `test/stripe-link-params.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { buildSessionParams } = require('../netlify/functions/create-stripe-link.js');

const BASE = {
  client: 'Amanda Petty', email: 'a@example.com', service: 'Foam Party',
  bookingRef: 'FM-ABC123', bookingId: 42, dbId: 42,
};

// Regression: the deposit session must be exactly what it was before balance
// mode existed. Every session Stripe has ever created for this business is
// this shape.
test('a deposit session is one line item and no fee', () => {
  const p = buildSessionParams({ ...BASE, kind: 'deposit', amount: 100, fee: 0 });
  assert.strictEqual(p.get('line_items[0][price_data][unit_amount]'), '10000');
  assert.match(p.get('line_items[0][price_data][product_data][name]'), /^Deposit — Foam Party$/);
  assert.strictEqual(p.get('line_items[1][price_data][unit_amount]'), null, 'deposit grew a second line item');
  assert.strictEqual(p.get('metadata[payment_kind]'), 'deposit');
});

test('a balance session itemises balance and fee as separate lines', () => {
  const p = buildSessionParams({ ...BASE, kind: 'balance', amount: 400, fee: 20 });
  assert.strictEqual(p.get('line_items[0][price_data][unit_amount]'), '40000');
  assert.strictEqual(p.get('line_items[0][price_data][product_data][name]'), 'Balance — Foam Party');
  assert.strictEqual(p.get('line_items[1][price_data][unit_amount]'), '2000');
  assert.strictEqual(p.get('line_items[1][price_data][product_data][name]'), 'Service fee (5%)');
  assert.strictEqual(p.get('metadata[payment_kind]'), 'balance');
});

// The one word this must never say. A 5% card-only surcharge exceeds Stripe's
// cost of acceptance and falls under Visa/Mastercard surcharge rules; a
// service fee on every payment method does not.
test('the fee is never described to the client as a card or processing fee', () => {
  const p = buildSessionParams({ ...BASE, kind: 'balance', amount: 400, fee: 20 });
  const text = p.toString();
  for (const word of ['surcharge', 'card fee', 'processing fee', 'convenience']) {
    assert.ok(!text.toLowerCase().includes(word), `session copy says "${word}"`);
  }
});

test('rounding to Stripe cents is exact, not floating', () => {
  const p = buildSessionParams({ ...BASE, kind: 'balance', amount: 333.33, fee: 16.67 });
  assert.strictEqual(p.get('line_items[0][price_data][unit_amount]'), '33333');
  assert.strictEqual(p.get('line_items[1][price_data][unit_amount]'), '1667');
});

test('a zero fee produces no fee line even in balance mode', () => {
  const p = buildSessionParams({ ...BASE, kind: 'balance', amount: 400, fee: 0 });
  assert.strictEqual(p.get('line_items[1][price_data][unit_amount]'), null);
});

test('both kinds carry the ids the webhook matches on', () => {
  for (const kind of ['deposit', 'balance']) {
    const p = buildSessionParams({ ...BASE, kind, amount: 100, fee: kind === 'balance' ? 5 : 0 });
    assert.strictEqual(p.get('metadata[booking_db_id]'), '42');
    assert.strictEqual(p.get('client_reference_id'), 'FM-ABC123');
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/stripe-link-params.test.js`
Expected: FAIL — `buildSessionParams is not a function`.

- [ ] **Step 3: Extract and extend the session builder**

In `create-stripe-link.js`, add the import at the top, after line `3`:

```js
const { balanceCharge, SERVICE_FEE_RATE } = require('./_items');
```

Then delete the inline `const params = new URLSearchParams({...})` block (`54-68`) — Step 5 replaces it with a call — and add this pure function above `exports.handler`:

```js
const SITE = 'https://funkymonkeyadmin.netlify.app';

// The Stripe session, as data. Pure so the line items can be tested without
// calling Stripe.
//
// Balance mode is two line items on purpose: the client must be able to check
// the arithmetic against their quote and see where the difference came from.
// Never one blended figure. And it is a "Service fee", never a card or
// processing fee — see SERVICE_FEE_RATE in _items.js for why the wording is
// load-bearing.
function buildSessionParams({ kind, amount, fee, service, client, email, bookingRef, bookingId, dbId }) {
  const ref = bookingRef || String(bookingId);
  const isBalance = kind === 'balance';
  const params = new URLSearchParams({
    "mode": "payment",
    "success_url": `${SITE}/confirmation.html?ref=${ref}`,
    "cancel_url": `${SITE}/booking-form.html?cancelled=1`,
    "customer_email": email || "",
    "client_reference_id": ref,
    "metadata[booking_id]": ref,
    "metadata[booking_db_id]": String(dbId),
    "metadata[payment_kind]": isBalance ? 'balance' : 'deposit',
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][unit_amount]": String(Math.round(Number(amount) * 100)),
    "line_items[0][price_data][product_data][name]":
      isBalance ? `Balance — ${service || 'Event'}` : `Deposit — ${service || 'Event'}`,
    "line_items[0][price_data][product_data][description]":
      isBalance
        ? `Remaining balance for ${client || ''}'s event.`
        : `Deposit for ${client || ''}'s event. Balance due day-of.`,
    "line_items[0][quantity]": "1",
    "payment_method_types[0]": "card",
  });
  if (isBalance && Number(fee) > 0) {
    params.set("line_items[1][price_data][currency]", "usd");
    params.set("line_items[1][price_data][unit_amount]", String(Math.round(Number(fee) * 100)));
    params.set("line_items[1][price_data][product_data][name]",
      `Service fee (${Math.round(SERVICE_FEE_RATE * 100)}%)`);
    params.set("line_items[1][price_data][product_data][description]",
      "Applies to balances settled after the deposit.");
    params.set("line_items[1][quantity]", "1");
  }
  return params;
}
```

At the end of the file, after the handler:

```js
// Exported for tests — the handler itself calls Stripe and the database.
module.exports.buildSessionParams = buildSessionParams;
```

- [ ] **Step 4: Run the params tests**

Run: `node --test test/stripe-link-params.test.js`
Expected: PASS.

- [ ] **Step 5: Add balance mode to the handler**

Replace the destructure and amount validation (`27-33`):

```js
  const { bookingId, bookingRef, client, email, service, amount, skip_client_email } = body;

  // Validate amount: must be present and 0 < amount <= 10000
  const amountNum = Number(amount);
  if (!amount || isNaN(amountNum) || amountNum <= 0 || amountNum > 10000) {
    return json(400, { error: "amount must be a number between 0 (exclusive) and 10000" });
  }
```

with:

```js
  const { bookingId, bookingRef, client, email, service, amount, skip_client_email } = body;
  const kind = body.kind === 'balance' ? 'balance' : 'deposit';

  // Deposit mode only. In balance mode the amount comes from the database
  // below — a browser may not name the price of a balance, admin-authenticated
  // or not, and the fee must be derived from the stored balance so the client
  // and the booking can never disagree about what was owed.
  const amountNum = Number(amount);
  if (kind === 'deposit' && (!amount || isNaN(amountNum) || amountNum <= 0 || amountNum > 10000)) {
    return json(400, { error: "amount must be a number between 0 (exclusive) and 10000" });
  }
```

Widen the booking lookup (`36-46`) so both queries select the money columns — replace both `SELECT id, reference FROM bookings` with:

```js
      const COLS = 'id, reference, balance_due, total_price, mileage_cost, deposit_amount';
```

used as `` `SELECT ${COLS} FROM bookings WHERE id=$1 LIMIT 1` `` and `` `SELECT ${COLS} FROM bookings WHERE reference=$1 LIMIT 1` ``.

After the `if (!bookingRow) return json(404, ...)` block (`48-50`), insert:

```js
  // What we are about to charge. In balance mode this is the only place the
  // number can come from.
  const charge = kind === 'balance'
    ? balanceCharge(bookingRow)
    : { balance: amountNum, fee: 0, total: amountNum };

  if (kind === 'balance') {
    if (charge.balance <= 0) {
      return json(400, { error: "This booking has no balance due." });
    }
    // The deposit cap of 10000 was written for a browser-supplied figure. A
    // balance comes from the database, so the cap is only a sanity bound on a
    // corrupt row — but a silent $1,000,000 Stripe session is not a thing this
    // endpoint should ever be able to create.
    if (charge.total > 25000) {
      return json(400, { error: `Balance of $${charge.total.toFixed(2)} is too large to bill by link — take this one by hand.` });
    }
  }
```

Then replace the `const params = ...` block with:

```js
    const params = buildSessionParams({
      kind, amount: charge.balance, fee: charge.fee,
      service, client, email, bookingRef, bookingId, dbId: bookingRow.id,
    });
```

- [ ] **Step 6: Persist to the right column**

Replace the persist block (`94-101`) so the column depends on the kind:

```js
    // Persist the link. Without this the URL exists only in the caller's
    // memory: booking.js:353 is otherwise the sole writer of stripe_payment_link
    // and it only fires on status='confirmed', which happens AFTER payment. The
    // client-facing finalisation page reads that column, so an unpersisted link
    // means the pay step silently never appears. Failure to persist must not
    // lose the URL the caller is waiting for, but must be loud — a
    // returned-but-unsaved link reproduces exactly this bug.
    //
    // The balance link gets its OWN column. stripe_payment_link means "the
    // deposit link" to four existing readers — finalise.js:31 publishes it,
    // my-booking.html:568 labels its button "Pay Deposit Now", admin.html:1151
    // builds the deposit worklist from its absence, admin.html:1874 calls it
    // "Last link" — and overwriting it with a balance link would point a client
    // at a balance demand from the page that asks them to pay their deposit.
    const linkCol = kind === 'balance' ? 'stripe_balance_link' : 'stripe_payment_link';
    try {
      await withClient(async (c) => {
        if (kind === 'balance') {
          await c.query("ALTER TABLE bookings ADD COLUMN IF NOT EXISTS stripe_balance_link TEXT DEFAULT ''");
        }
        await c.query(
          `UPDATE bookings SET ${linkCol}=$1, updated_at=NOW() WHERE id=$2`,
          [url, bookingRow.id]
        );
      });
    } catch (persistErr) {
      console.error(`create-stripe-link: FAILED TO PERSIST ${linkCol} for booking`, bookingRow.id, '|', persistErr.message);
    }
```

And in `netlify/functions/bookings.js`, add to the ALTER list at `128`, immediately after the `stripe_payment_link` line:

```js
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS stripe_balance_link TEXT DEFAULT ''",
```

- [ ] **Step 7: Send the balance email instead of the deposit one**

Wrap the existing email block (`110-136`). Replace:

```js
    if (!skip_client_email) {
      try {
        await sendEmail(email, `Your deposit link is ready! 💳 — Funky Monkey Events`,
```

with:

```js
    if (!skip_client_email && kind === 'balance') {
      try {
        await sendEmail(email, `Your balance is ready to pay 💳 — Funky Monkey Events`,
          wrap(`<p style="font-size:16px;margin-bottom:16px">Hi <strong>${esc(client)}</strong>! 👋</p>
            <p style="color:#A78BCA;line-height:1.7;margin-bottom:20px">Here's the balance for <strong style="color:#F3E8FF">${esc(service)}</strong>. You can settle it with the button below.</p>
            <div style="background:#1A1035;border-radius:12px;padding:16px;margin-bottom:24px">
              <table style="width:100%;border-collapse:collapse;color:#F3E8FF;font-size:14px">
                <tr><td style="padding:4px 0;color:#A78BCA">Balance</td><td style="padding:4px 0;text-align:right">$${charge.balance.toFixed(2)}</td></tr>
                <tr><td style="padding:4px 0;color:#A78BCA">Service fee (5%)</td><td style="padding:4px 0;text-align:right">$${charge.fee.toFixed(2)}</td></tr>
                <tr><td style="padding:8px 0 0;border-top:1px solid #3D2460;font-weight:900">Total due</td><td style="padding:8px 0 0;border-top:1px solid #3D2460;text-align:right;color:#10B981;font-size:20px;font-weight:900">$${charge.total.toFixed(2)}</td></tr>
              </table>
            </div>
            <div style="text-align:center;margin-bottom:24px">
              <a href="${url}" style="background-color:#10B981;color:#ffffff;padding:16px 40px;border-radius:12px;text-decoration:none;font-weight:900;font-size:16px;display:inline-block">Pay Balance Now →</a>
              <div style="font-size:11px;color:#A78BCA;margin-top:14px;line-height:1.5">
                Button not working? Copy this link into your browser:<br>
                <a href="${url}" style="color:#06B6D4;word-break:break-all">${url}</a>
              </div>
            </div>
            <div style="background:#FFFFFF08;border-radius:10px;padding:12px;font-size:11px;color:#A78BCA;line-height:1.6;text-align:center">
              🔒 Secure payment powered by Stripe · Booking ref: ${esc(String(bookingRef || bookingId))}
            </div>
            <p style="font-size:13px;color:#A78BCA;text-align:center;margin-top:16px">Questions? <a href="tel:4054316625" style="color:#06B6D4;font-weight:700">(405) 431-6625</a></p>`));
      } catch (emailErr) {
        console.error("create-stripe-link: balance email failed:", emailErr.message);
        // Email failure does not fail the link creation
      }
    } else if (!skip_client_email) {
      try {
        await sendEmail(email, `Your deposit link is ready! 💳 — Funky Monkey Events`,
```

Leave the rest of the deposit email exactly as it is, including its `catch`.

- [ ] **Step 8: Return the itemised figures**

Replace the success return at `138`:

```js
    return json(200, { url, sessionId: session.id });
```

with:

```js
    return json(200, { url, sessionId: session.id, kind,
      balance: charge.balance, fee: charge.fee, total: charge.total });
```

- [ ] **Step 9: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add netlify/functions/create-stripe-link.js netlify/functions/bookings.js test/stripe-link-params.test.js
git commit -m "feat(stripe): balance links with an itemised 5% service fee"
```

---

### Task 5: The balance button

**Files:**
- Modify: `admin.html` (pure helpers, before `1489`; modal, after the Stripe deposit block; a new `sendBalanceLink` beside `sendStripeLink` at `2744`)
- Test: `test/admin-link-buttons.test.js` (extend)

**Interfaces:**
- Consumes: `depositLinkAmount` (Task 1); the `kind: 'balance'` endpoint contract and its `{ balance, fee, total }` response (Task 4).
- Produces: `balanceLinkAmounts(b) -> { balance, fee, total }` in admin.html's pure-helper block. This mirrors `balanceCharge` in `_items.js` and exists only to label the button — the server always recomputes from the database.

- [ ] **Step 1: Write the failing test**

Append to `test/admin-link-buttons.test.js`, and change the `out = {...}` line in `loadHelpers()` to `out = { depositLinkAmount, balanceLinkAmounts };`:

```js
const { balanceCharge } = require('../netlify/functions/_items.js');

const { balanceLinkAmounts } = loadHelpers();

test('the button label agrees with the server, to the cent', () => {
  for (const balance_due of [400, 385, 333.33, 1250.5, '400.00', 0]) {
    assert.deepStrictEqual(
      JSON.parse(JSON.stringify(balanceLinkAmounts({ balance_due }))),
      balanceCharge({ balance_due }),
      `admin.html and _items.js disagree at balance_due=${balance_due}`
    );
  }
});

test('nothing owed offers no balance link', () => {
  assert.strictEqual(balanceLinkAmounts({ balance_due: 0 }).total, 0);
  assert.strictEqual(balanceLinkAmounts({}).total, 0);
  assert.strictEqual(balanceLinkAmounts({ balance_due: -5 }).total, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/admin-link-buttons.test.js`
Expected: FAIL — `balanceLinkAmounts is not defined`.

- [ ] **Step 3: Add the helper**

In `admin.html`, before `// ══ END PURE HELPERS ══`, under `depositLinkAmount`:

```js
// Mirrors balanceCharge() and SERVICE_FEE_RATE in _items.js. Duplicated
// deliberately — admin.html is a static page with no access to server modules,
// the same reason finaliseLinkClient() below is duplicated — so if the rate or
// the rounding changes there, change it here in the same commit.
// test/admin-link-buttons.test.js asserts the two agree to the cent.
//
// This only labels the button. create-stripe-link.js recomputes the charge
// from the database and its answer is the one that bills.
function balanceLinkAmounts(b) {
  const raw = Number(b && b.balance_due);
  const cents = (n) => Math.round(n * 100) / 100;
  const balance = isFinite(raw) && raw > 0 ? cents(raw) : 0;
  const fee = cents(balance * 0.05);
  return { balance, fee, total: cents(balance + fee) };
}
```

- [ ] **Step 4: Add the block to the modal**

In `admin.html`, immediately after the Stripe deposit block's closing `</div>`}` (the block edited in Task 1):

```html
    ${isNew || balanceLinkAmounts(b).balance <= 0 ? '' : `
    <!-- Balance link -->
    <div class="stripe-block">
      <div style="display:flex;align-items:center;justify-content:space-between">
        <strong style="font-size:.875rem">💰 Balance Link</strong>
        <button class="btn btn-primary btn-sm" onclick="sendBalanceLink('${b.id}')">Send $${balanceLinkAmounts(b).total.toFixed(2)} balance link</button>
      </div>
      <div style="font-size:.75rem;color:#6b7280;margin-top:6px">Balance $${balanceLinkAmounts(b).balance.toFixed(2)} + service fee $${balanceLinkAmounts(b).fee.toFixed(2)} (5%).</div>
      ${b.stripe_balance_link?`<div class="stripe-result">Last balance link: <a href="${b.stripe_balance_link}" target="_blank" style="color:#7c3aed">Open →</a></div>`:''}
      <div class="stripe-result" id="balance-msg-${b.id}"></div>
    </div>`}
```

- [ ] **Step 5: Add the sender**

In `admin.html`, immediately after `sendStripeLink` closes (`~2780`):

```js
// ── Balance link — the amount is confirmed here but decided by the server:
// create-stripe-link.js reads balance_due from the database and recomputes the
// fee, so a stale allBookings row can never bill the wrong figure. ──
async function sendBalanceLink(id) {
  const b = allBookings.find(x => String(x.id) === String(id));
  if (!b) return;
  const el = document.getElementById('balance-msg-' + id);
  const { balance, fee, total } = balanceLinkAmounts(b);
  if (balance <= 0) { el.textContent = '❌ This booking has no balance due.'; return; }
  if (!b.client_email) { el.textContent = '❌ No client email on this booking.'; return; }
  if (!confirm(`Email ${b.client_email} a balance link?\n\n`
      + `Balance          $${balance.toFixed(2)}\n`
      + `Service fee (5%)  $${fee.toFixed(2)}\n`
      + `Total due        $${total.toFixed(2)}`)) return;
  el.textContent = 'Generating…';
  try {
    const res = await apiFetch('/api/create-stripe-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind:       'balance',
        bookingId:  b.id,
        bookingRef: b.reference,
        client:     b.client_name,
        email:      b.client_email,
        service:    b.service_name,
      })
    });
    const data = await res.json();
    if (data.url) {
      if (!String(data.url).startsWith('https://')) {
        el.textContent = '❌ Invalid payment link URL returned';
        return;
      }
      const a = document.createElement('a');
      a.href = encodeURI(data.url); a.target = '_blank'; a.style.color = '#7c3aed'; a.textContent = 'Open →';
      el.textContent = `✅ Sent — $${Number(data.total).toFixed(2)} ($${Number(data.balance).toFixed(2)} + $${Number(data.fee).toFixed(2)} fee). `;
      el.appendChild(a);
      b.stripe_balance_link = data.url;
    } else {
      el.textContent = '❌ ' + (data.error || 'Unknown error');
    }
  } catch (e) { el.textContent = '❌ ' + e.message; }
}
```

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS. Note the final count for the completion report.

- [ ] **Step 7: Commit**

```bash
git add admin.html test/admin-link-buttons.test.js
git commit -m "feat(admin): send a balance link that names its amount"
```

---

## Manual verification before this is called done

Automated tests cover the arithmetic and the session shape. They cannot cover Stripe or Neon. In Stripe **test mode** (swap `STRIPE_SECRET_KEY` locally — never point this at live keys):

- [ ] A booking with `deposit_amount = 0` shows "No deposit on this booking" and no deposit button.
- [ ] A booking with `deposit_amount = 100` shows "Send $100.00 deposit link" and charges $100.
- [ ] A booking with `balance_due = 400` shows "Send $420.00 balance link"; the Stripe page lists **Balance $400.00** and **Service fee (5%) $20.00** as two lines.
- [ ] Paying that balance link leaves `deposit_amount` unchanged, sets `balance_due` to 0, does not change `status`, and sends the "all paid up" email with three lines — not "You're CONFIRMED!".
- [ ] Paying a *deposit* link still confirms the booking and still emails the deposit confirmation. This is the regression that matters most.
- [ ] `my-booking.html` still shows the deposit link, not the balance link, after a balance link has been created.

**Deploying:** auto-publishing is off. A push does not deploy — Netlify needs a manual **Trigger deploy**, and it should be verified as published before any of the above is tested against production.
