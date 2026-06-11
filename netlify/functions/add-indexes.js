/**
 * Database Index Migration
 *
 * Adds critical indexes to improve query performance 10-50x
 * Run this once after deployment: https://yoursite.netlify.app/.netlify/functions/add-indexes
 *
 * SAFE TO RUN MULTIPLE TIMES - Uses "IF NOT EXISTS" and "CONCURRENTLY" where possible
 */

const { getPool, withClient } = require('./_db');
const { CORS, preflight, requireAuth, unauthorized } = require('./_auth');

// Index definitions with performance impact notes
const INDEXES = [
  // ═══════════════════════════════════════════════════════════════
  // BOOKINGS TABLE - Most queried table
  // ═══════════════════════════════════════════════════════════════

  // Reference lookup - CRITICAL (used on every confirmation page load)
  {
    name: 'idx_bookings_reference',
    table: 'bookings',
    columns: 'reference',
    impact: 'HIGH - Confirmation page, booking lookup',
    sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_bookings_reference ON bookings(reference)'
  },

  // Created timestamp - CRITICAL (default sort on bookings page)
  {
    name: 'idx_bookings_created_at',
    table: 'bookings',
    columns: 'created_at DESC',
    impact: 'HIGH - Bookings list, dashboard recent bookings',
    sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_bookings_created_at ON bookings(created_at DESC)'
  },

  // Event date - HIGH (calendar, upcoming events, date range filters)
  {
    name: 'idx_bookings_event_date',
    table: 'bookings',
    columns: 'event_date',
    impact: 'HIGH - Calendar, upcoming events, date filters',
    sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_bookings_event_date ON bookings(event_date)'
  },

  // Status - HIGH (filtering by status, dashboard stats)
  {
    name: 'idx_bookings_status',
    table: 'bookings',
    columns: 'status',
    impact: 'HIGH - Status filters, dashboard counts',
    sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_bookings_status ON bookings(status)'
  },

  // Composite: Status + Event Date - VERY HIGH (dashboard unstaffed warnings)
  {
    name: 'idx_bookings_status_event_date',
    table: 'bookings',
    columns: 'status, event_date',
    impact: 'VERY HIGH - "Confirmed bookings in next 14 days" query',
    sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_bookings_status_event_date ON bookings(status, event_date)'
  },

  // Client email - MEDIUM (Stripe webhook lookup, client CRM)
  {
    name: 'idx_bookings_client_email',
    table: 'bookings',
    columns: 'LOWER(client_email)',
    impact: 'MEDIUM - Stripe webhook fallback, client history',
    sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_bookings_client_email ON bookings(LOWER(client_email))'
  },

  // Deposit paid - MEDIUM (filtering paid/unpaid deposits)
  {
    name: 'idx_bookings_deposit_paid',
    table: 'bookings',
    columns: 'deposit_paid',
    impact: 'MEDIUM - Payment tracking, deposit reports',
    sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_bookings_deposit_paid ON bookings(deposit_paid)'
  },

  // ═══════════════════════════════════════════════════════════════
  // STAFF_ASSIGNMENTS TABLE - Heavily queried for staffing
  // ═══════════════════════════════════════════════════════════════

  // Booking ID - CRITICAL (every booking modal load)
  {
    name: 'idx_assignments_booking_id',
    table: 'staff_assignments',
    columns: 'booking_id',
    impact: 'CRITICAL - Loading staff for each booking',
    sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_assignments_booking_id ON staff_assignments(booking_id)'
  },

  // Staff ID - HIGH (staff portal "my gigs")
  {
    name: 'idx_assignments_staff_id',
    table: 'staff_assignments',
    columns: 'staff_id',
    impact: 'HIGH - Staff portal gig list',
    sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_assignments_staff_id ON staff_assignments(staff_id)'
  },

  // Composite: Booking + Staff - HIGH (prevents duplicate assignments)
  {
    name: 'idx_assignments_booking_staff',
    table: 'staff_assignments',
    columns: 'booking_id, staff_id',
    impact: 'HIGH - Duplicate check, assignment lookup',
    sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_assignments_booking_staff ON staff_assignments(booking_id, staff_id)'
  },

  // Status - MEDIUM (filtering interested/assigned/backup)
  {
    name: 'idx_assignments_status',
    table: 'staff_assignments',
    columns: 'status',
    impact: 'MEDIUM - Status filtering',
    sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_assignments_status ON staff_assignments(status)'
  },

  // ═══════════════════════════════════════════════════════════════
  // EMAIL_LOG TABLE - Growing table, needs indexes
  // ═══════════════════════════════════════════════════════════════

  // Booking ID - HIGH (booking modal activity log)
  {
    name: 'idx_email_log_booking_id',
    table: 'email_log',
    columns: 'booking_id',
    impact: 'HIGH - Email history per booking',
    sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_email_log_booking_id ON email_log(booking_id)'
  },

  // Sent timestamp - MEDIUM (recent email log)
  {
    name: 'idx_email_log_sent_at',
    table: 'email_log',
    columns: 'sent_at DESC',
    impact: 'MEDIUM - Recent email activity',
    sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_email_log_sent_at ON email_log(sent_at DESC)'
  },

  // ═══════════════════════════════════════════════════════════════
  // STAFF_PAYMENTS TABLE - Payroll queries
  // ═══════════════════════════════════════════════════════════════

  // Staff ID - HIGH (staff earnings, payroll generation)
  {
    name: 'idx_staff_payments_staff_id',
    table: 'staff_payments',
    columns: 'staff_id',
    impact: 'HIGH - Staff earnings summary',
    sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_staff_payments_staff_id ON staff_payments(staff_id)'
  },

  // Paid status - HIGH (unpaid payments report)
  {
    name: 'idx_staff_payments_paid',
    table: 'staff_payments',
    columns: 'paid',
    impact: 'HIGH - Unpaid payments tracking',
    sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_staff_payments_paid ON staff_payments(paid)'
  },

  // Payroll run ID - MEDIUM (payments in a payroll run)
  {
    name: 'idx_staff_payments_payroll_run',
    table: 'staff_payments',
    columns: 'payroll_run_id',
    impact: 'MEDIUM - Payroll run details',
    sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_staff_payments_payroll_run ON staff_payments(payroll_run_id)'
  },

  // ═══════════════════════════════════════════════════════════════
  // PAYROLL_RUNS TABLE - Weekly payroll
  // ═══════════════════════════════════════════════════════════════

  // Week ending - HIGH (finding existing payroll runs)
  {
    name: 'idx_payroll_runs_week_ending',
    table: 'payroll_runs',
    columns: 'week_ending',
    impact: 'HIGH - Payroll run lookup',
    sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payroll_runs_week_ending ON payroll_runs(week_ending)'
  },

  // Status - MEDIUM (filtering draft/approved/paid)
  {
    name: 'idx_payroll_runs_status',
    table: 'payroll_runs',
    columns: 'status',
    impact: 'MEDIUM - Payroll status filtering',
    sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payroll_runs_status ON payroll_runs(status)'
  },

  // ═══════════════════════════════════════════════════════════════
  // STAFF TABLE - Lookups by different fields
  // ═══════════════════════════════════════════════════════════════

  // PIN - HIGH (staff login via PIN)
  {
    name: 'idx_staff_pin',
    table: 'staff',
    columns: 'pin',
    impact: 'HIGH - Staff authentication',
    sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_staff_pin ON staff(pin) WHERE active=TRUE'
  },

  // Active status - MEDIUM (filtering active staff)
  {
    name: 'idx_staff_active',
    table: 'staff',
    columns: 'active',
    impact: 'MEDIUM - Active staff lists',
    sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_staff_active ON staff(active)'
  },

  // ═══════════════════════════════════════════════════════════════
  // GIG_LOGS TABLE - Staff checklist and surveys
  // ═══════════════════════════════════════════════════════════════

  // Assignment ID - HIGH (one log per assignment)
  {
    name: 'idx_gig_logs_assignment_id',
    table: 'gig_logs',
    columns: 'assignment_id',
    impact: 'HIGH - Loading gig checklist/survey',
    sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_gig_logs_assignment_id ON gig_logs(assignment_id)'
  },

  // Booking ID - MEDIUM (all logs for a booking)
  {
    name: 'idx_gig_logs_booking_id',
    table: 'gig_logs',
    columns: 'booking_id',
    impact: 'MEDIUM - Booking-level gig summaries',
    sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_gig_logs_booking_id ON gig_logs(booking_id)'
  },

  // ═══════════════════════════════════════════════════════════════
  // BOOKING_CHANGES TABLE - Audit log
  // ═══════════════════════════════════════════════════════════════

  // Booking ID - HIGH (activity tab in booking modal)
  {
    name: 'idx_booking_changes_booking_id',
    table: 'booking_changes',
    columns: 'booking_id',
    impact: 'HIGH - Booking activity log',
    sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_booking_changes_booking_id ON booking_changes(booking_id)'
  }
];

exports.handler = async (event) => {
  const pre = preflight(event);
  if (pre) return pre;

  // Admin-only endpoint — runs DDL against production
  const auth = await requireAuth(event, ['admin']);
  if (!auth) return unauthorized();

  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      headers: CORS,
      body: JSON.stringify({ error: 'Method not allowed - use GET' })
    };
  }

  return withClient(async (client) => {
    const results = [];
    let successCount = 0;
    let skipCount = 0;
    let errorCount = 0;

    try {
      console.log(`Starting index creation for ${INDEXES.length} indexes...`);

      for (const index of INDEXES) {
        try {
          const startTime = Date.now();

          // Check if index already exists
          const checkQuery = `
            SELECT 1 FROM pg_indexes
            WHERE schemaname = 'public'
            AND indexname = $1
          `;
          const { rows } = await client.query(checkQuery, [index.name]);

          if (rows.length > 0) {
            console.log(`SKIP: ${index.name} (already exists)`);
            results.push({
              index: index.name,
              table: index.table,
              status: 'skipped',
              reason: 'Already exists',
              impact: index.impact
            });
            skipCount++;
            continue;
          }

          // Create index
          console.log(`Creating: ${index.name} on ${index.table}(${index.columns})`);
          await client.query(index.sql);

          const duration = Date.now() - startTime;
          console.log(`SUCCESS: ${index.name} (${duration}ms) - Impact: ${index.impact}`);

          results.push({
            index: index.name,
            table: index.table,
            columns: index.columns,
            status: 'created',
            duration_ms: duration,
            impact: index.impact
          });
          successCount++;

        } catch (indexError) {
          console.error(`FAILED: ${index.name} - ${indexError.message}`);
          results.push({
            index: index.name,
            table: index.table,
            status: 'error',
            impact: index.impact
          });
          errorCount++;
        }
      }

      console.log(`Summary: ${successCount} created, ${skipCount} skipped, ${errorCount} errors`);

      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({
          success: true,
          summary: {
            total: INDEXES.length,
            created: successCount,
            skipped: skipCount,
            errors: errorCount
          },
          results,
          message: errorCount === 0
            ? 'All indexes created successfully!'
            : `${errorCount} index(es) failed to create`
        }, null, 2)
      };

    } catch (error) {
      console.error('Migration failed:', error.message);
      return {
        statusCode: 500,
        headers: CORS,
        body: JSON.stringify({
          success: false,
          error: 'Migration failed',
          results
        })
      };
    }
  });
};
