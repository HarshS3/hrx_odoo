import 'dotenv/config';
import pkg from 'pg';
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

async function fixEmployerCost() {
  try {
    console.log('Fixing employer_cost values in existing payslips...');
    
    // Update all payslips: employer_cost = basic_wage
    const result = await pool.query(`
      UPDATE payslips 
      SET employer_cost = basic_wage
      WHERE employer_cost IS NOT NULL OR employer_cost IS NULL
    `);
    
    console.log(`✅ Updated ${result.rowCount} payslips`);
    console.log('Employer Cost now equals Basic Wage (monthly wage after proration)');
    
  } catch (error) {
    console.error('❌ Fix failed:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

fixEmployerCost();
