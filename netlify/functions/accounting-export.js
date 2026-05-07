// netlify/functions/accounting-export.js
// Generate detailed financial exports for accounting and tax purposes

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Content-Type': 'text/csv'
};

/**
 * Generate CSV from array of objects
 */
function generateCSV(data, columns) {
  if (!data || data.length === 0) return '';
  
  // Header row
  const headers = columns.map(col => col.label).join(',');
  
  // Data rows
  const rows = data.map(row => {
    return columns.map(col => {
      let value = row[col.key];
      
      // Format based on type
      if (value === null || value === undefined) {
        value = '';
      } else if (typeof value === 'number') {
        value = col.format === 'currency' ? value.toFixed(2) : value;
      } else if (typeof value === 'string') {
        // Escape quotes and wrap in quotes if contains comma or quote
        value = value.replace(/"/g, '""');
        if (value.includes(',') || value.includes('"') || value.includes('\n')) {
          value = `"${value}"`;
        }
      }
      
      return value;
    }).join(',');
  }).join('\n');
  
  return headers + '\n' + rows;
}

/**
 * Get detailed booking financials
 */
async function getBookingFinancials(client, startDate, endDate) {
  const query = `
    SELECT 
      b.id,
      b.reference,
      b.status,
      b.event_date,
      b.service_name,
      b.client_name,
      b.total_price,
      b.deposit_amount,
      b.deposit_paid,
      b.balance_due,
      b.payment_method,
      b.payment_amount,
      b.mileage_miles,
      b.mileage_cost,
      b.created_at,
      
      -- Staff costs
      COALESCE(SUM(sp.amount), 0) as total_staff_cost,
      
      -- Refunds
      COALESCE(SUM(r.amount), 0) as total_refunds,
      
      -- Calculated profit
      b.total_price - COALESCE(SUM(sp.amount), 0) - COALESCE(b.mileage_cost, 0) as gross_profit,
      b.total_price - COALESCE(SUM(sp.amount), 0) - COALESCE(b.mileage_cost, 0) - COALESCE(SUM(r.amount), 0) as net_profit
      
    FROM bookings b
    LEFT JOIN staff_payments sp ON sp.booking_id = b.id
    LEFT JOIN refunds r ON r.booking_id = b.id AND r.status IN ('succeeded', 'manual')
    WHERE b.event_date >= $1 AND b.event_date <= $2
    GROUP BY b.id
    ORDER BY b.event_date, b.id
  `;
  
  const result = await client.query(query, [startDate, endDate]);
  return result.rows;
}

/**
 * Get staff payment details
 */
async function getStaffPayments(client, startDate, endDate) {
  const query = `
    SELECT 
      sp.id,
      sp.event_date,
      s.name as staff_name,
      b.reference as booking_reference,
      b.service_name,
      sp.amount,
      sp.pay_type,
      sp.hours,
      sp.paid,
      sp.paid_at,
      pr.week_ending as payroll_week
    FROM staff_payments sp
    JOIN staff s ON s.id = sp.staff_id
    LEFT JOIN bookings b ON b.id = sp.booking_id
    LEFT JOIN payroll_runs pr ON pr.id = sp.payroll_run_id
    WHERE sp.event_date >= $1 AND sp.event_date <= $2
    ORDER BY sp.event_date, s.name
  `;
  
  const result = await client.query(query, [startDate, endDate]);
  return result.rows;
}

/**
 * Get expense summary (mileage)
 */
async function getExpenses(client, startDate, endDate) {
  const query = `
    SELECT 
      b.event_date,
      b.reference,
      b.service_name,
      b.event_location,
      b.event_zip,
      b.mileage_miles,
      b.mileage_cost
    FROM bookings b
    WHERE b.event_date >= $1 
      AND b.event_date <= $2
      AND (b.mileage_miles > 0 OR b.mileage_cost > 0)
    ORDER BY b.event_date
  `;
  
  const result = await client.query(query, [startDate, endDate]);
  return result.rows;
}

/**
 * Get revenue summary by service type
 */
async function getRevenueByService(client, startDate, endDate) {
  const query = `
    SELECT 
      b.service_name,
      COUNT(*) as booking_count,
      SUM(b.total_price) as total_revenue,
      AVG(b.total_price) as avg_price,
      SUM(COALESCE(sp.total_staff_cost, 0)) as total_staff_cost,
      SUM(b.total_price) - SUM(COALESCE(sp.total_staff_cost, 0)) as gross_profit
    FROM bookings b
    LEFT JOIN (
      SELECT booking_id, SUM(amount) as total_staff_cost
      FROM staff_payments
      GROUP BY booking_id
    ) sp ON sp.booking_id = b.id
    WHERE b.event_date >= $1 
      AND b.event_date <= $2
      AND b.status IN ('confirmed', 'completed')
    GROUP BY b.service_name
    ORDER BY total_revenue DESC
  `;
  
  const result = await client.query(query, [startDate, endDate]);
  return result.rows;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: HEADERS, body: '' };
  }

  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      headers: { ...HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  const client = await pool.connect();
  try {
    const { report_type, start_date, end_date, year } = event.queryStringParameters || {};

    // Determine date range
    let startDate, endDate;
    
    if (year) {
      // Full year export
      startDate = `${year}-01-01`;
      endDate = `${year}-12-31`;
    } else if (start_date && end_date) {
      startDate = start_date;
      endDate = end_date;
    } else {
      // Default to current year
      const currentYear = new Date().getFullYear();
      startDate = `${currentYear}-01-01`;
      endDate = `${currentYear}-12-31`;
    }

    let csvData, filename;

    switch (report_type) {
      case 'bookings':
        // Detailed booking financials
        const bookings = await getBookingFinancials(client, startDate, endDate);
        csvData = generateCSV(bookings, [
          { key: 'reference', label: 'Reference' },
          { key: 'event_date', label: 'Event Date' },
          { key: 'status', label: 'Status' },
          { key: 'service_name', label: 'Service' },
          { key: 'client_name', label: 'Client' },
          { key: 'total_price', label: 'Total Price', format: 'currency' },
          { key: 'deposit_amount', label: 'Deposit', format: 'currency' },
          { key: 'deposit_paid', label: 'Deposit Paid' },
          { key: 'balance_due', label: 'Balance Due', format: 'currency' },
          { key: 'payment_method', label: 'Payment Method' },
          { key: 'total_staff_cost', label: 'Staff Cost', format: 'currency' },
          { key: 'mileage_miles', label: 'Miles' },
          { key: 'mileage_cost', label: 'Mileage Cost', format: 'currency' },
          { key: 'total_refunds', label: 'Refunds', format: 'currency' },
          { key: 'gross_profit', label: 'Gross Profit', format: 'currency' },
          { key: 'net_profit', label: 'Net Profit', format: 'currency' }
        ]);
        filename = `bookings_${startDate}_to_${endDate}.csv`;
        break;

      case 'staff_payments':
        // Staff payment details
        const payments = await getStaffPayments(client, startDate, endDate);
        csvData = generateCSV(payments, [
          { key: 'event_date', label: 'Event Date' },
          { key: 'staff_name', label: 'Staff Member' },
          { key: 'booking_reference', label: 'Booking Ref' },
          { key: 'service_name', label: 'Service' },
          { key: 'pay_type', label: 'Pay Type' },
          { key: 'hours', label: 'Hours' },
          { key: 'amount', label: 'Amount', format: 'currency' },
          { key: 'paid', label: 'Paid' },
          { key: 'paid_at', label: 'Paid Date' },
          { key: 'payroll_week', label: 'Payroll Week' }
        ]);
        filename = `staff_payments_${startDate}_to_${endDate}.csv`;
        break;

      case 'expenses':
        // Mileage and expenses
        const expenses = await getExpenses(client, startDate, endDate);
        csvData = generateCSV(expenses, [
          { key: 'event_date', label: 'Date' },
          { key: 'reference', label: 'Booking Ref' },
          { key: 'service_name', label: 'Service' },
          { key: 'event_location', label: 'Location' },
          { key: 'event_zip', label: 'ZIP' },
          { key: 'mileage_miles', label: 'Miles' },
          { key: 'mileage_cost', label: 'Mileage Cost', format: 'currency' }
        ]);
        filename = `expenses_${startDate}_to_${endDate}.csv`;
        break;

      case 'revenue_by_service':
        // Revenue breakdown by service type
        const revenue = await getRevenueByService(client, startDate, endDate);
        csvData = generateCSV(revenue, [
          { key: 'service_name', label: 'Service' },
          { key: 'booking_count', label: 'Count' },
          { key: 'total_revenue', label: 'Total Revenue', format: 'currency' },
          { key: 'avg_price', label: 'Avg Price', format: 'currency' },
          { key: 'total_staff_cost', label: 'Staff Cost', format: 'currency' },
          { key: 'gross_profit', label: 'Gross Profit', format: 'currency' }
        ]);
        filename = `revenue_by_service_${startDate}_to_${endDate}.csv`;
        break;

      default:
        // Summary report (all data)
        const allBookings = await getBookingFinancials(client, startDate, endDate);
        csvData = generateCSV(allBookings, [
          { key: 'reference', label: 'Reference' },
          { key: 'event_date', label: 'Event Date' },
          { key: 'service_name', label: 'Service' },
          { key: 'client_name', label: 'Client' },
          { key: 'total_price', label: 'Revenue', format: 'currency' },
          { key: 'total_staff_cost', label: 'Staff Cost', format: 'currency' },
          { key: 'mileage_cost', label: 'Mileage', format: 'currency' },
          { key: 'total_refunds', label: 'Refunds', format: 'currency' },
          { key: 'net_profit', label: 'Net Profit', format: 'currency' }
        ]);
        filename = `accounting_export_${startDate}_to_${endDate}.csv`;
    }

    return {
      statusCode: 200,
      headers: {
        ...HEADERS,
        'Content-Disposition': `attachment; filename="${filename}"`
      },
      body: csvData
    };

  } catch (err) {
    console.error('Accounting export error:', err.message);
    return {
      statusCode: 500,
      headers: { ...HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message })
    };
  } finally {
    client.release();
  }
};
