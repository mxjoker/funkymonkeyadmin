/**
 * Import Bookings from Party Enquiry Tracker CSV
 *
 * Usage:
 *   Dry run: /api/import-bookings?dryrun=true
 *   Import:  /api/import-bookings
 *
 * CSV must be placed at project root as 'import-data.csv'
 */

const { getPool, withClient } = require('./_db');
const { CORS, preflight, requireAuth, unauthorized } = require('./_auth');
const fs = require('fs');
const path = require('path');

// Status mapping from old system
const STATUS_MAP = {
  'Confirmed': 'confirmed',
  'Confirmed+': 'confirmed',
  'Balance settled': 'completed',
  // PPM's "Processing" means the client agreed and the paperwork is in flight,
  // which is exactly what 'accepted' means in the seven-status model. It used to
  // map to the retired 'pending' — the last producer of that status.
  'Processing': 'accepted',
  'Pending': 'review',
  'Unprocessed': 'review',
  'Cancelled': 'cancelled',
  'Dropped / Cancelled': 'cancelled',
  'Completed': 'completed'
};

// Service name mapping (expand as needed)
// Shared with scripts/backfill-service-ids.js so intake and backfill can never
// disagree about which catalogue entry a legacy package name means.
const { resolveServiceId } = require('./_service-map');
// Shared with scripts/reconcile-ppm-export.js for the same reason: the cutover
// reconciliation is only meaningful if it reads the export the way this does.
const { parseRows } = require('./_csv');
// One place builds the address line, shared with scripts/backfill-addresses.js.
const { fullAddress } = require('./_address');

const SERVICE_MAP = {
  'Deluxe Birthday Package': 'Deluxe Magic Birthday Show',
  'Basic Birthday Show': 'Magic Birthday Show',
  'Stage Show': 'Stage Magic Show',
  '45 Minute Foam Party': 'Foam Party Experience',
  '90 Minute Foam Party': 'Foam Party Experience',
  '90 minute Foam Party': 'Foam Party Experience'
};

// Oklahoma ZIP codes by town
const ZIP_MAP = {
  'Oklahoma City': '73132',
  'Edmond': '73013',
  'Norman': '73069',
  'Piedmont': '73078',
  'Yukon': '73099',
  'Moore': '73160'
};

// Parse date from "DD MMM YYYY" format
function parseDate(dateStr) {
  if (!dateStr || !dateStr.trim()) return null;

  const months = {
    'Jan': '01', 'Feb': '02', 'Mar': '03', 'Apr': '04',
    'May': '05', 'Jun': '06', 'Jul': '07', 'Aug': '08',
    'Sep': '09', 'Oct': '10', 'Nov': '11', 'Dec': '12'
  };

  try {
    const [day, month, year] = dateStr.trim().split(' ');
    if (!day || !month || !year || !months[month]) return null;
    return `${year}-${months[month]}-${day.padStart(2, '0')}`;
  } catch (e) {
    return null;
  }
}

// Clean phone number (remove leading apostrophe)
function cleanPhone(phone) {
  if (!phone) return '';
  return phone.replace(/^'/, '').trim();
}

// Parse decimal, handle empty/invalid
function parseDecimal(str) {
  if (!str || str.trim() === '') return 0;
  const num = parseFloat(str.replace(/,/g, ''));
  return isNaN(num) ? 0 : num;
}

// Parse integer (named to avoid shadowing global parseInt)
function parseIntVal(str) {
  if (!str || str.trim() === '') return 0;
  const num = Number(str);
  return isNaN(num) ? 0 : num;
}

// Transform old row to new booking format
function transformRow(row, headers) {
  const obj = {};
  headers.forEach((h, i) => obj[h] = row[i] || '');

  // Map status
  const oldStatus = obj['Event status'];
  const status = STATUS_MAP[oldStatus] || 'review';

  // Map service name
  const oldPackage = obj['Package'];
  const serviceName = SERVICE_MAP[oldPackage] || oldPackage || 'Custom Event';

  // ...and link it to the catalogue. Without this the row lands with a name but
  // no service_id, which joins to zero staff_slots — the booking then reports
  // "no staff requirements" and notifies nobody. Resolves to '' for names too
  // ambiguous to map ("Custom Event"); those get linked by hand in the admin's
  // Quote Breakdown. Re-runnable via scripts/backfill-service-ids.js.
  const serviceId = resolveServiceId(serviceName);

  // Full address, not just the venue. This used to take Venue and fall back to
  // Addr. line 1, so a gig at KinderCare stored "KinderCare" and discarded
  // "1812 North Eastern Ave, Moore" — invisible in the admin, useless on a
  // phone where the calendar entry has to be tappable for directions.
  const eventLocation = fullAddress(obj);

  // Determine ZIP
  let eventZip = obj['Postcode'] || '';
  if (!eventZip) {
    const town = obj['Town'] || '';
    eventZip = ZIP_MAP[town] || '';
  }

  // Parse date
  const eventDate = parseDate(obj['Event date']);

  // Brand: magic/bubbles/balloons = Joe Coover Magic, everything else = Funky Monkey Events
  const brandText = [obj['Package'], obj['Pathway'], obj['Celebration'], obj['Organisation']].join(' ');
  const brand = /magic|bubble|balloon/i.test(brandText) ? 'jcm' : 'fme';

  return {
    reference: obj['Ref.'] || null,
    status,
    brand,
    service_id: serviceId,
    service_name: serviceName,
    service_price: parseDecimal(obj['Party price']),
    addon_total: parseDecimal(obj['Price of extras']),
    mileage_cost: parseDecimal(obj['Travel fee']),
    total_price: parseDecimal(obj['Tot. price']),
    deposit_amount: parseDecimal(obj['Deposit']),
    deposit_paid: (obj['Deposit paid'] && obj['Deposit paid'].trim() !== '') ? true : false,
    event_date: eventDate,
    event_time: obj['Event time'] || '',
    event_zip: eventZip,
    event_location: eventLocation,
    event_type: obj['Celebration'] || '',
    guest_count: parseIntVal(obj['No. children']),
    notes: obj['Enq. text'] || '',
    // An organisation booking has no individual client — PPM puts the name in
    // Organisation and leaves Client name empty. Ten real bookings at The MAC
    // (a confirmed 5-day camp, July 2025, plus a cancelled June week) were
    // rejected by the "Missing client name" validator for exactly this reason,
    // and schools, libraries and venues all book this way. The organisation IS
    // the client.
    client_name: obj['Client name'] || obj['Organisation'] || '',
    organisation_name: obj['Organisation'] || '',
    client_phone: cleanPhone(obj['Phone number']),
    client_email: obj['Email'] || '',
    child_name: obj['Child name 1'] || '',
    customer_type: obj['Customer type'] || '',
    referral_source: obj['Heard about us'] || '',
    admin_notes: obj['Admin notes'] || '',
    // Settled gigs carry no balance; otherwise remaining = total minus deposit
    balance_due: status === 'completed' ? 0 : Math.max(0, parseDecimal(obj['Tot. price']) - parseDecimal(obj['Deposit']))
  };
}

// Validate booking before import
function validateBooking(booking) {
  const errors = [];

  if (!booking.client_name) errors.push('Missing client name');
  if (!booking.event_date) errors.push('Invalid or missing event date');
  if (!booking.reference) errors.push('Missing reference');

  return {
    valid: errors.length === 0,
    errors
  };
}

exports.handler = async (event) => {
  const pre = preflight(event);
  if (pre) return pre;

  // Admin-only endpoint — runs mass-import against production
  const auth = await requireAuth(event, ['admin']);
  if (!auth) return unauthorized();

  const isDryRun = event.queryStringParameters?.dryrun === 'true';
  const startTime = Date.now();

  const results = {
    total: 0,
    imported: 0,
    skipped: 0,
    errors: 0,
    errorDetails: []
  };

  return withClient(async (client) => {
    try {
      // Read CSV file
      const csvPath = path.join('/var/task', 'import-data.csv');

      if (!fs.existsSync(csvPath)) {
        return {
          statusCode: 404,
          headers: CORS,
          body: JSON.stringify({
            error: 'CSV file not found',
            message: 'Place import-data.csv in project root and redeploy'
          })
        };
      }

      const csvContent = fs.readFileSync(csvPath, 'utf-8');

      // parseRows(), NOT split('\n'). PPM puts newlines inside quoted fields —
      // addresses and enquiry notes run across several lines — so splitting on
      // newlines first tears one booking into fragments and writes the shrapnel
      // to the bookings table. The 2026-08-10 export split into 1007 "rows" of
      // which only 702 had a reference; parsed properly it is 702 records.
      const allRows = parseRows(csvContent);
      const headers = allRows[0] || [];
      console.log('CSV Headers:', headers.slice(0, 10).join(', '), '...');

      const dataRows = allRows.slice(1);
      results.total = dataRows.length;

      // Process rows
      for (let i = 0; i < dataRows.length; i++) {
        try {
          const row = dataRows[i];
          const booking = transformRow(row, headers);
          const validation = validateBooking(booking);

          if (!validation.valid) {
            results.errors++;
            results.errorDetails.push({
              row: i + 2, // +2: 0-indexed data rows, plus the header line
              reference: booking.reference,
              errors: validation.errors
            });
            continue;
          }

          // Check for existing reference — in BOTH modes, deliberately.
          //
          // This used to sit inside `if (!isDryRun)`, so a dry run never looked
          // for duplicates and counted every valid row as importable. Against
          // the 2026-08-10 export it reported "692 rows ready to import" when
          // 665 of them already existed and only 27 were new. A preview that
          // cannot distinguish those two outcomes is not a preview.
          const existing = await client.query(
            'SELECT id FROM bookings WHERE reference = $1',
            [booking.reference]
          );

          if (existing.rows.length > 0) {
            results.skipped++;
            if (!isDryRun) console.log(`Skip: ${booking.reference} (already exists)`);
            continue;
          }

          // Import booking
          if (!isDryRun) {
            await client.query(`
              INSERT INTO bookings (
                reference, status, brand, service_id, service_name, service_price,
                addon_total, mileage_cost, total_price, deposit_amount,
                balance_due, deposit_paid, event_date, event_time,
                event_zip, event_location, event_type, guest_count,
                notes, client_name, client_phone, client_email,
                child_name, customer_type, referral_source, admin_notes,
                organisation_name
              ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26,
                $27
              )
            `, [
              booking.reference, booking.status, booking.brand, booking.service_id,
              booking.service_name,
              booking.service_price, booking.addon_total, booking.mileage_cost,
              booking.total_price, booking.deposit_amount, booking.balance_due,
              booking.deposit_paid, booking.event_date, booking.event_time,
              booking.event_zip, booking.event_location, booking.event_type,
              booking.guest_count, booking.notes, booking.client_name,
              booking.client_phone, booking.client_email, booking.child_name,
              booking.customer_type, booking.referral_source, booking.admin_notes,
              booking.organisation_name
            ]);

            results.imported++;

            if (results.imported % 50 === 0) {
              console.log(`Imported ${results.imported}/${results.total} rows...`);
            }
          } else {
            results.imported++;
          }

        } catch (rowError) {
          results.errors++;
          results.errorDetails.push({
            row: i + 2, // +2: 0-indexed data rows, plus the header line
            error: 'Row processing failed'
          });
          console.error(`Row ${i} error:`, rowError.message);
        }
      }

      const duration = Date.now() - startTime;

      console.log(`Import ${isDryRun ? 'Preview' : 'Complete'}:`,
        `Total: ${results.total}, Imported: ${results.imported},`,
        `Skipped: ${results.skipped}, Errors: ${results.errors},`,
        `Duration: ${duration}ms`);

      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({
          success: true,
          dryRun: isDryRun,
          summary: results,
          duration_ms: duration,
          message: isDryRun
            ? `Dry run complete - ${results.imported} rows ready to import`
            : `Import complete - ${results.imported} bookings imported`
        }, null, 2)
      };

    } catch (error) {
      console.error('Import failed:', error.message);
      return {
        statusCode: 500,
        headers: CORS,
        body: JSON.stringify({
          success: false,
          error: 'Import failed',
          results
        })
      };
    }
  });
};
