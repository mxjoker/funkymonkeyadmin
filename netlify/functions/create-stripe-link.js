const { withClient } = require('./_db');
const { CORS, preflight, requireAuth, unauthorized } = require('./_auth');
const { esc, sendEmail, wrap } = require('./_email');
const { balanceCharge, SERVICE_FEE_RATE } = require('./_items');

const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

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
  // The webhook reads these two back to itemise the client's receipt. It must
  // NOT re-derive the fee from the booking row: that row's balance_due is
  // zeroed by the payment itself, and a quote edited between minting this link
  // and the client paying would move it — either way the receipt would print a
  // wrong-but-believable number. Stripe signs the whole session payload, so
  // what is set here is exactly what comes back.
  if (isBalance) {
    params.set("metadata[balance_amount]", Number(amount).toFixed(2));
    params.set("metadata[fee_amount]", Number(fee).toFixed(2));
  }
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

exports.handler = async (event) => {
  const pre = preflight(event);
  if (pre) return pre;

  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  // Admin token required
  const auth = await requireAuth(event, ['admin']);
  if (!auth) return unauthorized();

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) return json(500, { error: "Stripe not configured" });

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: "Invalid JSON" });
  }

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

  // Validate the referenced booking exists
  const COLS = 'id, reference, balance_due, total_price, mileage_cost, deposit_amount, deposit_paid';
  const bookingRow = await withClient(async (c) => {
    if (bookingId) {
      const { rows } = await c.query(`SELECT ${COLS} FROM bookings WHERE id=$1 LIMIT 1`, [parseInt(bookingId)]);
      return rows[0] || null;
    }
    if (bookingRef) {
      const { rows } = await c.query(`SELECT ${COLS} FROM bookings WHERE reference=$1 LIMIT 1`, [bookingRef]);
      return rows[0] || null;
    }
    return null;
  });

  if (!bookingRow) {
    return json(404, { error: "Booking not found" });
  }

  // What we are about to charge. In balance mode this is the only place the
  // number can come from.
  const charge = kind === 'balance'
    ? balanceCharge(bookingRow)
    : { balance: amountNum, fee: 0, total: amountNum };

  if (kind === 'balance') {
    if (charge.balance <= 0) {
      return json(400, { error: "This booking has no balance due." });
    }
    // Both links live at once is a money bug, not a tidiness one. The balance
    // payment zeroes balance_due; the still-live deposit link's webhook then
    // recomputes it as total + mileage - deposit, so a client who has paid
    // $520 on a $500 booking is shown $400 owing. admin.html's
    // balanceLinkEligible() hides the button, but the button is not the only
    // possible caller and this codebase's documented recurring failure mode is
    // trusting that it is. A deposit_amount of 0 is the deliberate no-deposit
    // booking (school, library) — nothing to settle first.
    if (bookingRow.deposit_paid !== true && Number(bookingRow.deposit_amount) > 0) {
      return json(400, { error: "This booking's deposit has not been paid yet — send the deposit link first." });
    }
    // The deposit cap of 10000 was written for a browser-supplied figure. A
    // balance comes from the database, so the cap is only a sanity bound on a
    // corrupt row — but a silent $1,000,000 Stripe session is not a thing this
    // endpoint should ever be able to create.
    if (charge.total > 25000) {
      return json(400, { error: `Balance of $${charge.total.toFixed(2)} is too large to bill by link — take this one by hand.` });
    }
  }

  try {
    // Create Stripe Checkout Session
    const params = buildSessionParams({
      kind, amount: charge.balance, fee: charge.fee,
      service, client, email, bookingRef, bookingId, dbId: bookingRow.id,
    });

    const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${stripeKey}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: params.toString()
    });

    const session = await res.json();
    if (!res.ok) {
      console.error("Stripe error:", JSON.stringify(session.error));
      throw new Error(session.error?.message || "Stripe API error");
    }

    const url = session.url;

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
    // The ALTER gets its OWN try/catch. Sharing one with the UPDATE meant a
    // DDL failure — lock timeout, a role without DDL rights — took the persist
    // down with it, producing exactly the returned-but-unsaved link this
    // comment exists to prevent. bookings.js:129 adds the column on every
    // bookings request anyway, so this one is belt-and-braces.
    try {
      if (kind === 'balance') {
        await withClient((c) =>
          c.query("ALTER TABLE bookings ADD COLUMN IF NOT EXISTS stripe_balance_link TEXT DEFAULT ''"));
      }
    } catch (ddlErr) {
      console.error('create-stripe-link: could not ensure stripe_balance_link column |', ddlErr.message);
    }
    try {
      await withClient(async (c) => {
        await c.query(
          `UPDATE bookings SET ${linkCol}=$1, updated_at=NOW() WHERE id=$2`,
          [url, bookingRow.id]
        );
      });
    } catch (persistErr) {
      console.error(`create-stripe-link: FAILED TO PERSIST ${linkCol} for booking`, bookingRow.id, '|', persistErr.message);
    }

    // Email the client with the payment link. Skippable via skip_client_email:
    // the finalisation flow sends its own, better email right after this call
    // (it points at the page where the client completes details AND pays, not
    // just Stripe) — without this flag that flow fires this one too, so the
    // client gets two emails about the same thing seconds apart. Default stays
    // "send it": the existing sendStripeLink() button in admin.html relies on
    // this being the only email and never sets the flag.
    if (!skip_client_email && kind === 'balance') {
      try {
        await sendEmail(email, `Your balance is ready to pay 💳 — Funky Monkey Events`,
          wrap(`<p style="font-size:16px;margin-bottom:16px">Hi <strong>${esc(client)}</strong>! 👋</p>
            <p style="color:#A78BCA;line-height:1.7;margin-bottom:20px">Here's the balance for <strong style="color:#F3E8FF">${esc(service)}</strong>. You can settle it with the button below.</p>
            <div style="background:#1A1035;border-radius:12px;padding:16px;margin-bottom:24px">
              <table style="width:100%;border-collapse:collapse;color:#F3E8FF;font-size:14px">
                <tr><td style="padding:4px 0;color:#A78BCA">Balance</td><td style="padding:4px 0;text-align:right">$${charge.balance.toFixed(2)}</td></tr>
                <tr><td style="padding:4px 0;color:#A78BCA">Service fee (${Math.round(SERVICE_FEE_RATE * 100)}%)</td><td style="padding:4px 0;text-align:right">$${charge.fee.toFixed(2)}</td></tr>
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
          wrap(`<p style="font-size:16px;margin-bottom:16px">Hi <strong>${esc(client)}</strong>! 🎉</p>
            <p style="color:#A78BCA;line-height:1.7;margin-bottom:20px">Your booking for <strong style="color:#F3E8FF">${esc(service)}</strong> is approved! Pay your deposit to lock in your date.</p>
            <div style="background:#1A1035;border-radius:12px;padding:16px;margin-bottom:24px;text-align:center">
              <div style="font-size:11px;color:#A78BCA;text-transform:uppercase;font-weight:700;margin-bottom:6px">Deposit Amount</div>
              <div style="font-size:36px;font-weight:900;color:#10B981;font-family:'Fredoka One',sans-serif">$${amountNum.toFixed(2)}</div>
              <div style="font-size:12px;color:#A78BCA;margin-top:4px">Secure your date — balance due day of event</div>
            </div>
            <div style="text-align:center;margin-bottom:24px">
              <a href="${url}" style="background-color:#10B981;color:#ffffff;padding:16px 40px;border-radius:12px;text-decoration:none;font-weight:900;font-size:16px;display:inline-block">Pay Deposit Now →</a>
              <div style="font-size:11px;color:#A78BCA;margin-top:14px;line-height:1.5">
                Button not working? Copy this link into your browser:<br>
                <a href="${url}" style="color:#06B6D4;word-break:break-all">${url}</a>
              </div>
            </div>
            <div style="background:#FFFFFF08;border-radius:10px;padding:12px;font-size:11px;color:#A78BCA;line-height:1.6;text-align:center">
              🔒 Secure payment powered by Stripe · Accepts all major cards, Apple Pay &amp; Google Pay<br>
              Link expires in 24 hours · Booking ref: ${esc(String(bookingRef || bookingId))}
            </div>
            <p style="font-size:13px;color:#A78BCA;text-align:center;margin-top:16px">Questions? <a href="tel:4054316625" style="color:#06B6D4;font-weight:700">(405) 431-6625</a></p>`));
      } catch(emailErr) {
        console.error("create-stripe-link: email failed:", emailErr.message);
        // Email failure does not fail the link creation
      }
    }

    return json(200, { url, sessionId: session.id, kind,
      balance: charge.balance, fee: charge.fee, total: charge.total });
  } catch(e) {
    console.error("Stripe link error:", e.message);
    return json(500, { error: "Internal server error" });
  }
};

// Exported for tests — the handler itself calls Stripe and the database.
module.exports.buildSessionParams = buildSessionParams;
