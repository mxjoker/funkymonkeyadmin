/**
 * Payroll System Migration
 * Run this once to create the payroll tables
 */

const { Client } = require('pg');

async function migrate() {
  const connectionString = process.env.DATABASE_URL;
  
  // Try SSL first, fallback to no SSL if that fails
  let client = new Client({
    connectionString,
    ssl: { rejectUnauthorized: false }
  });

  try {
    await client.connect();
    console.log('Connected to database (SSL)');
  } catch (sslError) {
    if (sslError.message.includes('does not support SSL')) {
      console.log('SSL not supported, retrying without SSL...');
      await client.end();
      client = new Client({ connectionString, ssl: false });
      await client.connect();
      console.log('Connected to database (no SSL)');
    } else {
      throw sslError;
    }
  }

  try {
    // Create payroll_runs table
    await client.query(`
      CREATE TABLE IF NOT EXISTS payroll_runs (
        id SERIAL PRIMARY KEY,
        week_ending DATE NOT NULL,
        status VARCHAR(32) DEFAULT 'draft',
        total_amount NUMERIC(10,2) DEFAULT 0,
        notes TEXT DEFAULT '',
        payment_method VARCHAR(64) DEFAULT '',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        approved_at TIMESTAMPTZ,
        paid_at TIMESTAMPTZ,
        created_by VARCHAR(255) DEFAULT 'Admin'
      )
    `);
    console.log('✅ Created payroll_runs table');

    // Create payroll_line_items table
    await client.query(`
      CREATE TABLE IF NOT EXISTS payroll_line_items (
        id SERIAL PRIMARY KEY,
        payroll_run_id INTEGER NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
        staff_payment_id INTEGER NOT NULL REFERENCES staff_payments(id) ON DELETE CASCADE,
        staff_id INTEGER NOT NULL,
        amount NUMERIC(10,2) NOT NULL,
        adjustment_amount NUMERIC(10,2) DEFAULT 0,
        adjustment_note TEXT DEFAULT '',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log('✅ Created payroll_line_items table');

    // Add payroll_run_id to staff_payments (if not exists)
    await client.query(`
      ALTER TABLE staff_payments 
      ADD COLUMN IF NOT EXISTS payroll_run_id INTEGER REFERENCES payroll_runs(id)
    `);
    console.log('✅ Added payroll_run_id to staff_payments');

    // Create indexes
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_payroll_runs_week_ending 
      ON payroll_runs(week_ending)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_payroll_runs_status 
      ON payroll_runs(status)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_payroll_line_items_run_id 
      ON payroll_line_items(payroll_run_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_payroll_line_items_staff_id 
      ON payroll_line_items(staff_id)
    `);
    console.log('✅ Created indexes');

    console.log('\n🎉 Migration complete!');
  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    throw error;
  } finally {
    await client.end();
  }
}

// Run if called directly
if (require.main === module) {
  migrate().catch(console.error);
}

module.exports = { migrate };
