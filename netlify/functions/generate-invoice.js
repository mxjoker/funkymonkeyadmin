const { withClient } = require('./_db');
const { CORS, preflight, requireAuth } = require('./_auth');
const { fmtEventDate } = require('./_email');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const { ensureBookingItems, getItems } = require('./_items');

// PDF responses need different Content-Type but still need CORS headers
const pdfHeaders = {
  'Access-Control-Allow-Origin': CORS['Access-Control-Allow-Origin'],
  'Access-Control-Allow-Headers': CORS['Access-Control-Allow-Headers'],
  'Access-Control-Allow-Methods': CORS['Access-Control-Allow-Methods'],
};

// The invoice's line items, as data. Pure so the arithmetic can be tested
// without a database or a PDF: this is the document a client checks a bill
// against, and every one of its numbers is a promise.
//
// booking_items is authoritative when the booking has any; bookings created
// before Phase 3 and never re-saved fall back to the legacy columns, which the
// backfill has already mirrored anyway.
function buildInvoiceLines(booking) {
  if (booking.items && booking.items.length) {
    return booking.items.map(i => ({
      label: i.name,
      qty: i.quantity,
      // A discount is stored as a positive amount and subtracted by rollupItems
      // (_items.js). It prints negative, because a line reading
      // "Repeat client  $92.00" beside a total that went DOWN by 92 is the kind
      // of arithmetic a client rings up about.
      amount: (i.kind === 'discount' ? -1 : 1)
              * Number(i.price || 0) * Math.max(1, Number(i.quantity) || 1),
      primary: i.kind === 'service',
      discount: i.kind === 'discount',
    }));
  }
  return [
    { label: booking.service_name || 'Service', qty: 1, amount: Number(booking.service_price || 0), primary: true },
    ...(Array.isArray(booking.addons) ? booking.addons : []).map(a => ({
      label: a.name, qty: 1, amount: Number(a.price || 0), primary: false,
    })),
    ...(Number(booking.mileage_cost) > 0
      ? [{ label: `Travel (${booking.mileage_miles || 0} miles)`, qty: 1, amount: Number(booking.mileage_cost), primary: false }]
      : []),
  ];
}

// A closed-out camp, shaped like a booking so the whole PDF below — bill-to,
// line items, totals, notes — runs unchanged. Phase 3 of camps: one invoice
// for the week, one line reading "20 kids @ $85.00", never five per-day PDFs
// the client has to add up themselves.
//
// A second PDF path would be a second set of numbers to keep in sync with
// this one; buildInvoiceLines() only ever reads `.items`, so synthesising a
// single `service` item is the whole of the integration.
function buildCampInvoiceBooking(camp, days) {
  const active = (days || []).filter(d => (d.status || '') !== 'cancelled');
  const dates = active.map(d => d.event_date).filter(Boolean).sort();
  const rate = Number(camp.rate_per_kid || 0);
  const headcount = Number(camp.headcount || 0);
  // Rounded in cents for the same reason splitAcrossDays is: 20 x 84.95 is
  // 1698.9999999999998 in float, and that prints as $1699.00 but sums wrong.
  const total = Math.round(rate * headcount * 100) / 100;
  return {
    reference: camp.reference,
    created_at: camp.closed_out_at || camp.created_at,
    event_date: dates[0] || null,
    client_name: camp.client_name,
    client_email: camp.client_email,
    client_phone: camp.client_phone,
    event_type: camp.label,
    event_location: camp.event_location,
    event_zip: camp.event_zip,
    event_time: camp.event_time,
    guest_count: headcount,
    notes: camp.notes,
    // The camp is billed as one thing, so there is no deposit and the whole
    // amount is outstanding — the days' own deposit fields are untouched by
    // close-out and mean nothing at camp level.
    total_price: total,
    deposit_amount: 0,
    deposit_paid: false,
    balance_due: total,
    items: [{
      name: `${camp.label} — ${active.length} day${active.length === 1 ? '' : 's'}`,
      price: rate,
      quantity: headcount,
      kind: 'service',
    }],
  };
}

// What the discount lines add up to. The invoice prints a Subtotal above the
// Total only when this is non-zero — without it the discount line and the
// Total do not visibly reconcile on the page.
function invoiceDiscountTotal(booking) {
  return (booking.items || [])
    .filter(i => i.kind === 'discount')
    .reduce((s, i) => s + Number(i.price || 0) * Math.max(1, Number(i.quantity) || 1), 0);
}

exports.handler = async (event, context) => {
  const pre = preflight(event);
  if (pre) return pre;

  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: pdfHeaders, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const bookingId = event.path.split('/').pop();
  if (!bookingId) {
    return { statusCode: 400, headers: pdfHeaders, body: JSON.stringify({ error: 'Booking ID required' }) };
  }

  // Determine if caller is admin (bypasses email requirement)
  const adminAuth = await requireAuth(event, ['admin']);

  // Public: ?email= required, must match booking (case-insensitive)
  const emailParam = (event.queryStringParameters?.email || '').trim().toLowerCase();

  try {
    return await withClient(async (client) => {
      // A CAMP- reference invoices the whole week off the camps table rather
      // than a single booking. Same URL, same access rule, same PDF below —
      // only where the numbers come from differs.
      let booking;
      if (/^CAMP-/i.test(bookingId)) {
        const campRes = await client.query('SELECT * FROM camps WHERE reference = $1', [bookingId.toUpperCase()]);
        if (!campRes.rows.length) {
          return { statusCode: 404, headers: pdfHeaders, body: JSON.stringify({ error: 'Camp not found' }) };
        }
        const camp = campRes.rows[0];
        if (!adminAuth && (!emailParam || (camp.client_email || '').toLowerCase() !== emailParam)) {
          return { statusCode: 404, headers: pdfHeaders, body: JSON.stringify({ error: 'Not found' }) };
        }
        // Invoicing a camp nobody has closed out would print $0.00 and read
        // as a bill for nothing — say what is missing instead.
        if (!camp.closed_out_at) {
          return { statusCode: 400, headers: pdfHeaders,
                   body: JSON.stringify({ error: 'This camp has not been closed out yet — set the rate and headcount first.' }) };
        }
        const dayRes = await client.query(
          'SELECT event_date, status FROM bookings WHERE camp_id = $1 ORDER BY event_date', [camp.id]);
        booking = buildCampInvoiceBooking(camp, dayRes.rows);
      } else {

        // Fetch booking — handle both numeric ID and reference string
        let bookingRes;
        const isNumeric = /^\d+$/.test(bookingId);

        if (isNumeric) {
          bookingRes = await client.query(
            'SELECT * FROM bookings WHERE id = $1',
            [parseInt(bookingId)]
          );
        } else {
          bookingRes = await client.query(
            'SELECT * FROM bookings WHERE reference = $1',
            [bookingId.toUpperCase()]
          );
        }

        if (bookingRes.rows.length === 0) {
          return { statusCode: 404, headers: pdfHeaders, body: JSON.stringify({ error: 'Booking not found' }) };
        }

        booking = bookingRes.rows[0];

        // Access control: public requires matching email; admin bypasses
        if (!adminAuth) {
          if (!emailParam) {
            return { statusCode: 404, headers: pdfHeaders, body: JSON.stringify({ error: 'Not found' }) };
          }
          if ((booking.client_email || '').toLowerCase() !== emailParam) {
            return { statusCode: 404, headers: pdfHeaders, body: JSON.stringify({ error: 'Not found' }) };
          }
        }

        await ensureBookingItems(client);
        booking.items = await getItems(client, booking.id);

      }

      // Create PDF
      const pdfDoc = await PDFDocument.create();
      const page = pdfDoc.addPage([612, 792]); // Letter size
      const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
      const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

      const { width, height } = page.getSize();
      let y = height - 50;

      // Colors
      const purple = rgb(0.486, 0.227, 0.929); // #7C3AED
      const darkBlue = rgb(0.118, 0.106, 0.294); // #1E1B4B
      const gray = rgb(0.420, 0.451, 0.502); // #6B7280
      const darkGray = rgb(0.216, 0.255, 0.318); // #374151
      const lightGray = rgb(0.898, 0.906, 0.922); // #E5E7EB
      const green = rgb(0.024, 0.337, 0.412); // #059669
      const amber = rgb(0.851, 0.620, 0.039); // #D97706
      const yellowBg = rgb(0.996, 0.953, 0.780); // #FEF3C7
      const brownText = rgb(0.573, 0.251, 0.055); // #92400E

      // ══════════════════════════════════════════════════
      // HEADER - Company Info
      // ══════════════════════════════════════════════════
      page.drawText('FUNKY MONKEY EVENTS', { x: 50, y, size: 24, font: fontBold, color: purple });
      y -= 30;
      page.drawText('Joe Coover', { x: 50, y, size: 10, font, color: gray });
      y -= 15;
      page.drawText('Oklahoma City, OK', { x: 50, y, size: 10, font, color: gray });
      y -= 15;
      page.drawText('(405) 431-6625', { x: 50, y, size: 10, font, color: gray });
      y -= 15;
      page.drawText('bookings@funkymonkeyevents.com', { x: 50, y, size: 10, font, color: gray });

      // INVOICE title on right
      y = height - 50;
      page.drawText('INVOICE', { x: 450, y, size: 32, font: fontBold, color: darkBlue });
      y -= 40;
      page.drawText(`Invoice #: ${booking.reference}`, { x: 380, y, size: 10, font, color: gray });
      y -= 15;
      page.drawText(`Date: ${new Date(booking.created_at).toLocaleDateString('en-US')}`, { x: 380, y, size: 10, font, color: gray });
      y -= 15;
      // fmtEventDate normalises pg's Date objects and formats in UTC, so the
      // printed date can't shift a day. Numeric style to match the old invoice.
      page.drawText(`Event Date: ${fmtEventDate(booking.event_date, { weekday: undefined, month: 'numeric', day: 'numeric' })}`, { x: 380, y, size: 10, font, color: gray });

      // Horizontal line
      y = height - 155;
      page.drawLine({ start: { x: 50, y }, end: { x: 562, y }, thickness: 1, color: lightGray });

      // ══════════════════════════════════════════════════
      // BILL TO
      // ══════════════════════════════════════════════════
      y -= 20;
      page.drawText('BILL TO:', { x: 50, y, size: 12, font: fontBold, color: darkBlue });
      y -= 20;
      page.drawText(booking.client_name || '—', { x: 50, y, size: 10, font, color: darkGray });
      y -= 15;
      page.drawText(booking.client_email || '—', { x: 50, y, size: 10, font, color: darkGray });
      y -= 15;
      page.drawText(booking.client_phone || '—', { x: 50, y, size: 10, font, color: darkGray });

      // Event details on right
      y = height - 175;
      page.drawText('EVENT DETAILS:', { x: 320, y, size: 12, font: fontBold, color: darkBlue });
      y -= 20;
      page.drawText(`Type: ${formatEventType(booking.event_type)}`, { x: 320, y, size: 10, font, color: darkGray });
      y -= 15;
      const location = booking.event_location || booking.event_zip || '—';
      page.drawText(`Location: ${location.substring(0, 40)}`, { x: 320, y, size: 10, font, color: darkGray });
      y -= 15;
      page.drawText(`Time: ${booking.event_time || '—'}`, { x: 320, y, size: 10, font, color: darkGray });
      y -= 15;
      page.drawText(`Guests: ${booking.guest_count || '—'}`, { x: 320, y, size: 10, font, color: darkGray });

      // ══════════════════════════════════════════════════
      // LINE ITEMS TABLE
      // ══════════════════════════════════════════════════
      y = height - 280;

      // Table header background
      page.drawRectangle({ x: 50, y: y - 17, width: 512, height: 25, color: rgb(0.953, 0.957, 0.965) });

      // Table headers
      page.drawText('DESCRIPTION', { x: 60, y, size: 10, font: fontBold, color: gray });
      page.drawText('QTY', { x: 400, y, size: 10, font: fontBold, color: gray });
      page.drawText('AMOUNT', { x: 480, y, size: 10, font: fontBold, color: gray });

      y -= 25;
      page.drawLine({ start: { x: 50, y }, end: { x: 562, y }, thickness: 1, color: lightGray });
      y -= 15;

      const invoiceLines = buildInvoiceLines(booking);

      for (const line of invoiceLines) {
        const size = line.primary ? 10 : 9;
        const useFont = line.primary ? fontBold : font;
        const colour = line.discount ? green : line.primary ? darkBlue : gray;
        const prefix = line.primary ? '' : line.discount ? '  \u2212 ' : '  + ';
        page.drawText(`${prefix}${String(line.label).substring(0, 46)}`,
          { x: 60, y, size, font: useFont, color: colour });
        page.drawText(String(line.qty), { x: 400, y, size, font, color: line.primary ? darkGray : gray });
        // The minus goes before the $, not inside it: "-$92.00" reads as money
        // off, "$-92.00" reads as a bug.
        page.drawText(`${line.amount < 0 ? '-' : ''}$${Math.abs(line.amount).toFixed(2)}`,
          { x: 480, y, size, font, color: line.discount ? green : line.primary ? darkGray : gray });
        y -= line.primary ? 20 : 18;
      }

      y -= 10;
      page.drawLine({ start: { x: 50, y }, end: { x: 562, y }, thickness: 1, color: lightGray });
      y -= 15;

      // ══════════════════════════════════════════════════
      // TOTALS
      // ══════════════════════════════════════════════════
      const totalPrice = Number(booking.total_price || 0);
      const depositAmount = Number(booking.deposit_amount || 0);
      const depositPaid = booking.deposit_paid;
      const balanceDue = Number(booking.balance_due || 0);

      // Subtotal, only when something was taken off.
      const discountTotal = invoiceDiscountTotal(booking);
      if (discountTotal > 0) {
        page.drawText('Subtotal:', { x: 400, y, size: 10, font, color: gray });
        page.drawText(`$${(totalPrice + discountTotal).toFixed(2)}`, { x: 480, y, size: 10, font, color: gray });
        y -= 16;
        page.drawText('Discount:', { x: 400, y, size: 10, font, color: green });
        page.drawText(`-$${discountTotal.toFixed(2)}`, { x: 480, y, size: 10, font, color: green });
        y -= 18;
      }

      // Total
      page.drawText('Total:', { x: 400, y, size: 10, font, color: darkGray });
      page.drawText(`$${totalPrice.toFixed(2)}`, { x: 480, y, size: 10, font: fontBold, color: darkGray });
      y -= 20;

      // Deposit
      if (depositAmount > 0) {
        const depositColor = depositPaid ? green : amber;
        const depositLabel = `Deposit ${depositPaid ? '(Paid)' : '(Due)'}:`;
        page.drawText(depositLabel, { x: 400, y, size: 10, font, color: depositColor });
        page.drawText(`$${depositAmount.toFixed(2)}`, { x: 480, y, size: 10, font: fontBold, color: depositColor });
        y -= 20;
      }

      // Balance Due
      if (balanceDue > 0) {
        y -= 5; // Add spacing before balance box
        page.drawRectangle({ x: 380, y: y - 25, width: 182, height: 30, color: yellowBg });
        page.drawText('Balance Due:', { x: 400, y: y - 5, size: 12, font: fontBold, color: brownText });
        page.drawText(`$${balanceDue.toFixed(2)}`, { x: 480, y: y - 5, size: 14, font: fontBold, color: brownText });
        y -= 30;
      } else if (depositPaid && balanceDue === 0) {
        y -= 5; // Add spacing before paid box
        page.drawRectangle({ x: 380, y: y - 25, width: 182, height: 30, color: rgb(0.820, 0.980, 0.898) });
        page.drawText('PAID IN FULL', { x: 430, y: y - 5, size: 12, font: fontBold, color: green });
        y -= 30;
      }

      // ══════════════════════════════════════════════════
      // PAYMENT INSTRUCTIONS
      // ══════════════════════════════════════════════════
      y -= 20;
      page.drawText('PAYMENT INSTRUCTIONS:', { x: 50, y, size: 12, font: fontBold, color: darkBlue });
      y -= 20;
      page.drawText('• Cash, check, or Venmo accepted', { x: 50, y, size: 9, font, color: darkGray });
      y -= 15;
      page.drawText('• Venmo: @Joe-Coover (last 4 digits: 6625)', { x: 50, y, size: 9, font, color: darkGray });
      y -= 15;
      page.drawText('• Checks payable to: Joe Coover', { x: 50, y, size: 9, font, color: darkGray });
      y -= 15;
      page.drawText('• Balance due on day of event unless otherwise arranged', { x: 50, y, size: 9, font, color: darkGray });

      // ══════════════════════════════════════════════════
      // NOTES
      // ══════════════════════════════════════════════════
      if (booking.notes || booking.admin_notes) {
        y -= 30;
        page.drawText('NOTES:', { x: 50, y, size: 12, font: fontBold, color: darkBlue });
        y -= 20;
        const notes = [booking.notes, booking.admin_notes].filter(Boolean).join(' | ');
        const noteLines = wrapText(notes, 80);
        noteLines.forEach(line => {
          page.drawText(line, { x: 50, y, size: 9, font, color: gray });
          y -= 12;
        });
      }

      // ══════════════════════════════════════════════════
      // FOOTER
      // ══════════════════════════════════════════════════
      page.drawText('Thank you for choosing Funky Monkey Events!', {
        x: 156, y: 50, size: 8, font, color: rgb(0.612, 0.639, 0.686)
      });
      page.drawText('Questions? Call (405) 431-6625 or email bookings@funkymonkeyevents.com', {
        x: 106, y: 35, size: 8, font, color: rgb(0.612, 0.639, 0.686)
      });

      // Generate PDF
      const pdfBytes = await pdfDoc.save();

      return {
        statusCode: 200,
        headers: {
          ...pdfHeaders,
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename="Funky-Monkey-Invoice-${booking.reference}.pdf"`
        },
        body: Buffer.from(pdfBytes).toString('base64'),
        isBase64Encoded: true
      };
    });
  } catch (err) {
    console.error('Invoice generation error:', err.message);
    return {
      statusCode: 500,
      headers: pdfHeaders,
      body: JSON.stringify({ error: 'Failed to generate invoice' })
    };
  }
};

function formatEventType(type) {
  const map = {
    kids_bday: 'Kids Birthday Party',
    family: 'Family Gathering',
    school_asm: 'School Assembly',
    school_fund: 'School Fundraiser',
    corporate: 'Corporate Event',
    community: 'Community Event',
    wedding: 'Wedding',
    library: 'Library Program'
  };
  return map[type] || type;
}

function wrapText(text, maxChars) {
  const words = text.split(' ');
  const lines = [];
  let currentLine = '';

  words.forEach(word => {
    if ((currentLine + ' ' + word).length <= maxChars) {
      currentLine += (currentLine ? ' ' : '') + word;
    } else {
      if (currentLine) lines.push(currentLine);
      currentLine = word;
    }
  });

  if (currentLine) lines.push(currentLine);
  return lines;
}

module.exports.buildInvoiceLines = buildInvoiceLines;
module.exports.invoiceDiscountTotal = invoiceDiscountTotal;
module.exports.buildCampInvoiceBooking = buildCampInvoiceBooking;
