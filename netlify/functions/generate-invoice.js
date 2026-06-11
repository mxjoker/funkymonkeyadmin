const { withClient } = require('./_db');
const { CORS, preflight, requireAuth } = require('./_auth');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');

// PDF responses need different Content-Type but still need CORS headers
const pdfHeaders = {
  'Access-Control-Allow-Origin': CORS['Access-Control-Allow-Origin'],
  'Access-Control-Allow-Headers': CORS['Access-Control-Allow-Headers'],
  'Access-Control-Allow-Methods': CORS['Access-Control-Allow-Methods'],
};

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

      const booking = bookingRes.rows[0];

      // Access control: public requires matching email; admin bypasses
      if (!adminAuth) {
        if (!emailParam) {
          return { statusCode: 404, headers: pdfHeaders, body: JSON.stringify({ error: 'Not found' }) };
        }
        if ((booking.client_email || '').toLowerCase() !== emailParam) {
          return { statusCode: 404, headers: pdfHeaders, body: JSON.stringify({ error: 'Not found' }) };
        }
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
      // Anchor to T00:00:00 to avoid timezone-driven date shift
      page.drawText(`Event Date: ${new Date(String(booking.event_date).split('T')[0] + 'T00:00:00').toLocaleDateString('en-US')}`, { x: 380, y, size: 10, font, color: gray });

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

      // Service line
      page.drawText(booking.service_name || 'Service', { x: 60, y, size: 10, font: fontBold, color: darkBlue });
      page.drawText('1', { x: 400, y, size: 10, font, color: darkGray });
      page.drawText(`$${Number(booking.service_price || 0).toFixed(2)}`, { x: 480, y, size: 10, font, color: darkGray });
      y -= 20;

      // Add-ons
      if (booking.addons && Array.isArray(booking.addons) && booking.addons.length > 0) {
        booking.addons.forEach(addon => {
          page.drawText(`  + ${addon.name}`, { x: 60, y, size: 9, font, color: gray });
          page.drawText('1', { x: 400, y, size: 9, font, color: gray });
          page.drawText(`$${Number(addon.price || 0).toFixed(2)}`, { x: 480, y, size: 9, font, color: gray });
          y -= 18;
        });
      }

      // Mileage
      if (booking.mileage_cost && Number(booking.mileage_cost) > 0) {
        page.drawText(`  + Travel (${booking.mileage_miles || 0} miles)`, { x: 60, y, size: 9, font, color: gray });
        page.drawText('1', { x: 400, y, size: 9, font, color: gray });
        page.drawText(`$${Number(booking.mileage_cost).toFixed(2)}`, { x: 480, y, size: 9, font, color: gray });
        y -= 18;
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
