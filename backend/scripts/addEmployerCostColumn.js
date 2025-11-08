import 'dotenv/config';
import pkg from 'pg';
const { Pool } = pkg;
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

async function runMigration() {
  try {
    console.log('Running migration: Add employer_cost column to payslips...');
    
    const migrationPath = path.join(__dirname, '../migrations/2025-11-09_add_employer_cost.sql');
    const sql = fs.readFileSync(migrationPath, 'utf8');
    
    await pool.query(sql);
    console.log('✅ Migration completed successfully!');
    
    // Update existing payslips with calculated employer_cost
    console.log('Updating existing payslips with calculated employer_cost...');
    
    const payslipsQ = await pool.query(`
      SELECT p.id, p.employee_id, pr.period_year, pr.period_month
      FROM payslips p
      JOIN payruns pr ON pr.id = p.payrun_id
      WHERE p.employer_cost IS NULL
    `);
    
    console.log(`Found ${payslipsQ.rows.length} payslips to update`);
    
    for (const slip of payslipsQ.rows) {
      // Employer Cost = Basic Wage (monthly wage prorated)
      // Simply use the basic_wage already stored in the payslip
      const slipQ = await pool.query('SELECT basic_wage FROM payslips WHERE id=$1', [slip.id]);
      const basicWage = Number(slipQ.rows[0].basic_wage || 0);
      
      // Employer Cost = Basic Wage (employee's monthly wage after proration)
      const employerCost = basicWage;
      
      await pool.query('UPDATE payslips SET employer_cost=$1 WHERE id=$2', [employerCost, slip.id]);
    }
    
    console.log('✅ Existing payslips updated!');
    
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

runMigration();
