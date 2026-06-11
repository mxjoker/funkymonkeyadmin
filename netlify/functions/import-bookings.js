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
  'Processing': 'pending',
  'Unprocessed': 'review',
  'Cancelled': 'cancelled',
  'Completed': 'completed'
};

// Service name mapping (expand as needed)
const SERVICE_MAP = {
  'Deluxe Birthday Package': 'Deluxe Magic Birthday Show',
  'Basic Birthday Show': 'Magic Birthday Show',
  'Stage Show': 'Stage Magic Show',
  '45 Minute Foam Party': 'Foam Party Experience',
  '90 Minute Foam Party': 'Foam Party Experience'
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

// Parse CSV line (simple parser - handles quoted fields with commas)
function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());

  return result;
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

  // Determine event location
  let eventLocation = obj['Venue'] || '';
  if (!eventLocation) {
    eventLocation = obj['Addr. line 1'] || '';
  }

  // Determine ZIP
  let eventZip = obj['Postcode'] || '';
  if (!eventZip) {
    const town = obj['Town'] || '';
    eventZip = ZIP_MAP[town] || '';
  }

  // Parse date
  const eventDate = parseDate(obj['Event date']);

  return {
    reference: obj['Ref.'] || null,
    status,
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
    client_name: obj['Client name'] || '',
    client_phone: cleanPhone(obj['Phone number']),
    client_email: obj['Email'] || '',
    child_name: obj['Child name 1'] || '',
    customer_type: obj['Customer type'] || '',
    referral_source: obj['Heard about us'] || '',
    admin_notes: obj['Admin notes'] || '',
    balance_due: parseDecimal(obj['Tot. price']) - parseDecimal(obj['Deposit'])
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
      const lines = csvContent.split('\n').filter(l => l.trim());

      // Parse header
      const headers = parseCSVLine(lines[0]);
      console.log('CSV Headers:', headers.slice(0, 10).join(', '), '...');

      results.total = lines.length - 1; // Exclude header

      // Process rows
      for (let i = 1; i < lines.length; i++) {
        try {
          const row = parseCSVLine(lines[i]);
          const booking = transformRow(row, headers);
          const validation = validateBooking(booking);

          if (!validation.valid) {
            results.errors++;
            results.errorDetails.push({
              row: i,
              reference: booking.reference,
              errors: validation.errors
            });
            continue;
          }

          // Check for existing reference
          if (!isDryRun) {
            const existing = await client.query(
              'SELECT id FROM bookings WHERE reference = $1',
              [booking.reference]
            );

            if (existing.rows.length > 0) {
              results.skipped++;
              console.log(`Skip: ${booking.reference} (already exists)`);
              continue;
            }
          }

          // Import booking
          if (!isDryRun) {
            await client.query(`
              INSERT INTO bookings (
                reference, status, service_name, service_price,
                addon_total, mileage_cost, total_price, deposit_amount,
                balance_due, deposit_paid, event_date, event_time,
                event_zip, event_location, event_type, guest_count,
                notes, client_name, client_phone, client_email,
                child_name, customer_type, referral_source, admin_notes
              ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24
              )
            `, [
              booking.reference, booking.status, booking.service_name,
              booking.service_price, booking.addon_total, booking.mileage_cost,
              booking.total_price, booking.deposit_amount, booking.balance_due,
              booking.deposit_paid, booking.event_date, booking.event_time,
              booking.event_zip, booking.event_location, booking.event_type,
              booking.guest_count, booking.notes, booking.client_name,
              booking.client_phone, booking.client_email, booking.child_name,
              booking.customer_type, booking.referral_source, booking.admin_notes
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
            row: i,
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
