import 'dotenv/config';
import pkg from 'pg';
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

async function verifyFormulas() {
  try {
    console.log('Verifying payslip calculation formulas...\n');
    
    const payslips = await pool.query(`
      SELECT 
        p.id,
        e.first_name || ' ' || e.last_name as employee_name,
        p.basic_wage,
        p.gross_wage,
        p.net_wage,
        p.employer_cost,
        p.total_worked_days,
        p.total_leaves,
        p.payable_days
      FROM payslips p
      JOIN employees e ON e.id = p.employee_id
      LIMIT 3
    `);
    
    console.log('Sample Payslips:');
    console.log('================\n');
    
    for (const slip of payslips.rows) {
      console.log(`Employee: ${slip.employee_name}`);
      console.log(`  Payable Days: ${slip.payable_days} (Worked: ${slip.total_worked_days}, Leave: ${slip.total_leaves})`);
      console.log(`  Basic Wage:    ₹${Number(slip.basic_wage).toLocaleString()}`);
      console.log(`  Gross Wage:    ₹${Number(slip.gross_wage).toLocaleString()}`);
      console.log(`  Net Wage:      ₹${Number(slip.net_wage).toLocaleString()}`);
      console.log(`  Employer Cost: ₹${Number(slip.employer_cost).toLocaleString()}`);
      
      // Verify: Employer Cost should equal Basic Wage
      const isCorrect = Number(slip.employer_cost).toFixed(2) === Number(slip.basic_wage).toFixed(2);
      console.log(`  ✓ Employer Cost = Basic Wage? ${isCorrect ? '✅ YES' : '❌ NO'}\n`);
      
      // Get components to verify gross calculation
      const components = await pool.query(`
        SELECT component_name, amount, is_deduction
        FROM payslip_components
        WHERE payslip_id = $1
      `, [slip.id]);
      
      console.log('  Components:');
      let totalEarnings = 0;
      let totalDeductions = 0;
      
      components.rows.forEach(comp => {
        const symbol = comp.is_deduction ? '-' : '+';
        console.log(`    ${symbol} ${comp.component_name}: ₹${Number(comp.amount).toLocaleString()}`);
        if (comp.is_deduction) {
          totalDeductions += Number(comp.amount);
        } else {
          totalEarnings += Number(comp.amount);
        }
      });
      
      console.log(`\n  Verification:`);
      console.log(`    Total Earnings: ₹${totalEarnings.toLocaleString()}`);
      console.log(`    Gross Wage (stored): ₹${Number(slip.gross_wage).toLocaleString()}`);
      console.log(`    ✓ Match? ${Math.abs(totalEarnings - Number(slip.gross_wage)) < 0.01 ? '✅ YES' : '❌ NO'}`);
      
      console.log(`\n    Total Deductions: ₹${totalDeductions.toLocaleString()}`);
      console.log(`    Net Wage (stored): ₹${Number(slip.net_wage).toLocaleString()}`);
      console.log(`    Expected Net: ₹${(totalEarnings - totalDeductions).toLocaleString()}`);
      console.log(`    ✓ Match? ${Math.abs((totalEarnings - totalDeductions) - Number(slip.net_wage)) < 0.01 ? '✅ YES' : '❌ NO'}`);
      
      console.log('\n' + '='.repeat(60) + '\n');
    }
    
    console.log('\n📋 Formula Summary:');
    console.log('==================');
    console.log('✓ Basic Wage = Monthly Wage × (Payable Days / Expected Working Days)');
    console.log('✓ Gross Wage = Basic Wage + All Allowances');
    console.log('✓ Net Wage = Gross Wage - All Deductions');
    console.log('✓ Employer Cost = Basic Wage (Monthly Wage after proration)\n');
    
  } catch (error) {
    console.error('❌ Verification failed:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

verifyFormulas();
