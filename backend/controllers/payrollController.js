import { pool } from '../db.js';
import PDFDocument from 'pdfkit';

function getMonthName(month) {
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 
                  'July', 'August', 'September', 'October', 'November', 'December'];
  return months[month - 1] || 'Unknown';
}

function countExpectedWorkingDaysInMonth(year, month, workingDaysPerWeek = 5) {
  // month: 1-12
  const includeSaturday = workingDaysPerWeek >= 6;
  const includeSunday = workingDaysPerWeek >= 7;
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 0)); // last day of month
  let count = 0;
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const day = d.getUTCDay(); // 0 Sun ... 6 Sat
    const isWeekday = day >= 1 && day <= 5;
    const isSat = day === 6;
    const isSun = day === 0;
    if (isWeekday) count++;
    else if (isSat && includeSaturday) count++;
    else if (isSun && includeSunday) count++;
  }
  return count;
}

async function getMonthlyAttendanceCounts(empId, year, month) {
  // Counts of present and leave within month
  const start = `${year}-${String(month).padStart(2,'0')}-01`;
  const endDate = new Date(Date.UTC(year, month, 0));
  const end = `${year}-${String(month).padStart(2,'0')}-${String(endDate.getUTCDate()).padStart(2,'0')}`;
  const q = await pool.query(
    `SELECT status, COUNT(*)::int AS c
       FROM attendance
      WHERE employee_id=$1 AND date BETWEEN $2 AND $3
      GROUP BY status`,
    [empId, start, end]
  );
  let present = 0, leave = 0;
  for (const r of q.rows) {
    if (r.status === 'present') present = Number(r.c);
    else if (r.status === 'leave') leave = Number(r.c);
  }
  return { present, leave };
}

async function computePayslipForEmployee(empId, year, month) {
  // Returns {earnings:[], deductions:[], gross, net, employerCost}
  const salQ = await pool.query('SELECT * FROM salary_structure WHERE employee_id=$1', [empId]);
  if (!salQ.rowCount) return null;
  const s = salQ.rows[0];
  // Attendance-based proration
  const { present, leave } = await getMonthlyAttendanceCounts(empId, year, month);
  const expectedWorking = countExpectedWorkingDaysInMonth(year, month, s.working_days_per_week || 5);
  const payableDays = Math.min(present + leave, expectedWorking);
  const prorateFactor = expectedWorking > 0 ? (payableDays / expectedWorking) : 1;
  const base = Number(s.monthly_wage) * prorateFactor;
  const compsQ = await pool.query('SELECT * FROM salary_components WHERE employee_id=$1', [empId]);
  const earnings = [{ name: 'Monthly Wage', amount: base, is_deduction: false }];
  const deductions = [];
  for (const c of compsQ.rows) {
    let amt = 0;
    if (c.computation_type === 'percentage') {
      amt = (base * Number(c.value)) / 100.0;
    } else {
      amt = Number(c.value);
    }
    if (c.is_deduction) deductions.push({ name: c.name, amount: amt, is_deduction: true });
    else earnings.push({ name: c.name, amount: amt, is_deduction: false });
  }
  // PF & PT
  const pfEmp = s.pf_employee_rate != null ? (base * Number(s.pf_employee_rate)) / 100.0 : 0;
  const pfEmpr = s.pf_employer_rate != null ? (base * Number(s.pf_employer_rate)) / 100.0 : 0;
  if (pfEmp) deductions.push({ name: 'PF Employee', amount: pfEmp, is_deduction: true });
  const pt = s.professional_tax_override != null ? Number(s.professional_tax_override) : 0;
  if (pt) deductions.push({ name: 'Professional Tax', amount: pt, is_deduction: true });

  const gross = earnings.reduce((sum, e) => sum + e.amount, 0);
  const totalDeductions = deductions.reduce((sum, d) => sum + d.amount, 0);
  const net = gross - totalDeductions;
  
  // Employer Cost = Monthly Wage (prorated basic salary)
  const employerCost = base;

  return { earnings, deductions, gross, net, employerCost, counts: { payableDays, present, leave, expectedWorking } };
}

export async function createPayrun(req, res) {
  const client = await pool.connect();
  try {
    const { period_month, period_year } = req.body || {};
    const companyId = req.user.company_id;
    const role = req.user.role;
    if (!['admin','payroll'].includes(role)) return res.status(403).json({ error: 'Forbidden' });
    if (!period_month || !period_year) return res.status(400).json({ error: 'period_month and period_year required' });

    // Check if payrun already exists for this period
    const existingPayrun = await client.query(
      'SELECT id, status FROM payruns WHERE company_id=$1 AND period_month=$2 AND period_year=$3 LIMIT 1',
      [companyId, period_month, period_year]
    );
    
    if (existingPayrun.rowCount > 0) {
      return res.status(409).json({ 
        error: 'Payrun already exists',
        message: `A payrun for ${getMonthName(period_month)} ${period_year} already exists.`,
        existingPayrunId: existingPayrun.rows[0].id,
        status: existingPayrun.rows[0].status
      });
    }

    await client.query('BEGIN');
    const employeesQ = await client.query('SELECT id FROM employees WHERE company_id=$1', [companyId]);
    
    // Validation: Check which employees don't have salary structures
    const employeesWithoutSalary = [];
    for (const row of employeesQ.rows) {
      const salQ = await client.query('SELECT id FROM salary_structure WHERE employee_id=$1', [row.id]);
      if (!salQ.rowCount) {
        const empInfoQ = await client.query('SELECT first_name, last_name, email FROM employees WHERE id=$1', [row.id]);
        if (empInfoQ.rowCount) {
          const emp = empInfoQ.rows[0];
          employeesWithoutSalary.push({
            id: row.id,
            name: `${emp.first_name} ${emp.last_name}`,
            email: emp.email
          });
        }
      }
    }

    let employeeCount = 0;
    let totalEmployerCost = 0;

    const payrunQ = await client.query(
      `INSERT INTO payruns (company_id, period_month, period_year, employee_count, total_employer_cost, created_by, status)
       VALUES ($1,$2,$3,0,0,$4,'completed')
       RETURNING id`,
      [companyId, period_month, period_year, req.user.id]
    );
    const payrunId = payrunQ.rows[0].id;

    for (const row of employeesQ.rows) {
      const empId = row.id;
      const result = await computePayslipForEmployee(empId, period_year, period_month);
      if (!result) continue; // no salary structure; skip
      const { earnings, deductions, gross, net, employerCost, counts } = result;

      // Insert payslip
      const slipQ = await client.query(
        `INSERT INTO payslips (payrun_id, employee_id, payable_days, total_worked_days, total_leaves, basic_wage, gross_wage, net_wage, employer_cost, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'generated') RETURNING id`,
        [payrunId, empId, counts.payableDays, counts.present, counts.leave, earnings.find(e=>e.name==='Monthly Wage')?.amount || 0, gross, net, employerCost]
      );
      const payslipId = slipQ.rows[0].id;
      // Components
      for (const e of earnings) {
        await client.query(
          `INSERT INTO payslip_components (payslip_id, component_name, amount, is_deduction) VALUES ($1,$2,$3,$4)`,
          [payslipId, e.name, e.amount, false]
        );
      }
      for (const d of deductions) {
        await client.query(
          `INSERT INTO payslip_components (payslip_id, component_name, amount, is_deduction) VALUES ($1,$2,$3,$4)`,
          [payslipId, d.name, d.amount, true]
        );
      }
      employeeCount += 1;
      totalEmployerCost += employerCost;
    }

    await client.query('UPDATE payruns SET employee_count=$1, total_employer_cost=$2 WHERE id=$3', [employeeCount, totalEmployerCost, payrunId]);
    await client.query('COMMIT');
    
    // Return response with warnings if some employees were skipped
    const response = { 
      id: payrunId, 
      employee_count: employeeCount, 
      total_employer_cost: totalEmployerCost, 
      period_month, 
      period_year 
    };
    
    if (employeesWithoutSalary.length > 0) {
      response.warnings = {
        employees_without_salary: employeesWithoutSalary,
        message: `${employeesWithoutSalary.length} employee(s) were skipped because they don't have salary structures defined.`
      };
    }
    
    res.status(201).json(response);
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch(_) {}
    console.error(e);
    res.status(500).json({ error: 'Failed to create payrun' });
  } finally {
    client.release();
  }
}

export async function listPayruns(req, res) {
  try {
    const companyId = req.user.company_id;
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize || '20', 10)));
    const offset = (page - 1) * pageSize;
    const countQ = await pool.query('SELECT COUNT(*)::int AS c FROM payruns WHERE company_id=$1', [companyId]);
    const total = countQ.rows[0].c;
    const q = await pool.query('SELECT * FROM payruns WHERE company_id=$1 ORDER BY created_at DESC LIMIT $2 OFFSET $3', [companyId, pageSize, offset]);
    res.json({ items: q.rows, page, pageSize, total });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to fetch payruns' });
  }
}

export async function getPayrun(req, res) {
  try {
    const { id } = req.params;
    const companyId = req.user.company_id;
    const { rows } = await pool.query('SELECT * FROM payruns WHERE id=$1 AND company_id=$2', [id, companyId]);
    if (!rows.length) return res.status(404).json({ error: 'Payrun not found' });
    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to fetch payrun' });
  }
}

export async function listPayslipsForPayrun(req, res) {
  try {
    const { id } = req.params; // payrun id
    const companyId = req.user.company_id;
    // Verify payrun belongs to company
    const pr = await pool.query('SELECT id, period_month, period_year FROM payruns WHERE id=$1 AND company_id=$2', [id, companyId]);
    if (!pr.rowCount) return res.status(404).json({ error: 'Payrun not found' });
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize || '20', 10)));
    const offset = (page - 1) * pageSize;
    const countQ = await pool.query('SELECT COUNT(*)::int AS c FROM payslips WHERE payrun_id=$1', [id]);
    const total = countQ.rows[0].c;
    
    // Join with employees to get names
    const slipsQ = await pool.query(
      `SELECT p.*, e.first_name, e.last_name 
       FROM payslips p
       JOIN employees e ON e.id = p.employee_id
       WHERE p.payrun_id=$1 
       ORDER BY p.id ASC 
       LIMIT $2 OFFSET $3`, 
      [id, pageSize, offset]
    );
    
    // Compute absent days per slip
    const year = pr.rows[0].period_year;
    const month = pr.rows[0].period_month;
    const empIds = slipsQ.rows.map(r => r.employee_id);
    const wsQ = await pool.query('SELECT employee_id, working_days_per_week FROM salary_structure WHERE employee_id = ANY($1)', [empIds]);
    const wdwMap = new Map(wsQ.rows.map(r => [r.employee_id, r.working_days_per_week || 5]));
    const items = slipsQ.rows.map(slip => {
      const wdw = wdwMap.get(slip.employee_id) || 5;
      const expected = countExpectedWorkingDaysInMonth(year, month, wdw);
      const present = Number(slip.total_worked_days || 0);
      const leave = Number(slip.total_leaves || 0);
      const absent_days = Math.max(0, expected - (present + leave));
      const employee_name = `${slip.first_name || ''} ${slip.last_name || ''}`.trim();
      return { ...slip, absent_days, expected_working_days: expected, employee_name };
    });
    res.json({ items, page, pageSize, total });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to fetch payslips' });
  }
}

export async function getPayslip(req, res) {
  try {
    const { id } = req.params; // payslip id
    // Fetch payslip and ensure same company
    const ps = await pool.query(
      `SELECT p.*, e.company_id, e.first_name, e.last_name, pr.period_month, pr.period_year
         FROM payslips p
         JOIN employees e ON e.id = p.employee_id
         JOIN payruns pr ON pr.id = p.payrun_id
        WHERE p.id=$1`,
      [id]
    );
    if (!ps.rowCount) return res.status(404).json({ error: 'Payslip not found' });
    if (ps.rows[0].company_id !== req.user.company_id) return res.status(403).json({ error: 'Forbidden' });
    // Only admins/payroll can view any payslip; employees can only view their own
    if (req.user.role === 'employee') {
      const me = await pool.query('SELECT id FROM employees WHERE user_id=$1', [req.user.id]);
      if (!me.rowCount || me.rows[0].id !== ps.rows[0].employee_id) {
        return res.status(403).json({ error: 'Forbidden' });
      }
    }
    const comps = await pool.query('SELECT component_name, amount, is_deduction FROM payslip_components WHERE payslip_id=$1', [id]);
    const slip = ps.rows[0];
    // Provide a simple computation summary for frontend printing if needed
    const earnings = comps.rows.filter(c => !c.is_deduction);
    const deductions = comps.rows.filter(c => c.is_deduction);
    // Compute absent days (not stored): expectedWorking - (present + leave)
    const wdwQ = await pool.query('SELECT working_days_per_week FROM salary_structure WHERE employee_id=$1', [slip.employee_id]);
    const wdw = wdwQ.rowCount ? (wdwQ.rows[0].working_days_per_week || 5) : 5;
    const expected = countExpectedWorkingDaysInMonth(slip.period_year, slip.period_month, wdw);
    const present = Number(slip.total_worked_days || 0);
    const leave = Number(slip.total_leaves || 0);
    const absent_days = Math.max(0, expected - (present + leave));
    
    // Add employee name to response
    const employee_name = `${slip.first_name || ''} ${slip.last_name || ''}`.trim();
    
    res.json({ 
      payslip: { ...slip, absent_days, expected_working_days: expected, employee_name }, 
      components: comps.rows, 
      summary: { earnings, deductions } 
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to fetch payslip' });
  }
}

export async function validatePayrun(req, res) {
  try {
    const { id } = req.params;
    // Ensure payrun belongs to company
    const pr = await pool.query('UPDATE payruns SET status=$1 WHERE id=$2 AND company_id=$3 RETURNING id, status', ['validated', id, req.user.company_id]);
    if (!pr.rowCount) return res.status(404).json({ error: 'Payrun not found' });
    res.json(pr.rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to validate payrun' });
  }
}

export async function validatePayslip(req, res) {
  try {
    const { id } = req.params;
    const ps = await pool.query(
      `UPDATE payslips p SET status='validated'
         FROM employees e
        WHERE p.id=$1 AND e.id = p.employee_id AND e.company_id=$2
        RETURNING p.id, p.status`,
      [id, req.user.company_id]
    );
    if (!ps.rowCount) return res.status(404).json({ error: 'Payslip not found' });
    res.json(ps.rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to validate payslip' });
  }
}

export async function cancelPayslip(req, res) {
  try {
    const { id } = req.params;
    const ps = await pool.query(
      `UPDATE payslips p SET status='cancelled'
         FROM employees e
        WHERE p.id=$1 AND e.id = p.employee_id AND e.company_id=$2
        RETURNING p.id, p.status`,
      [id, req.user.company_id]
    );
    if (!ps.rowCount) return res.status(404).json({ error: 'Payslip not found' });
    res.json(ps.rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to cancel payslip' });
  }
}

export async function recomputePayslip(req, res) {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    // Load payslip and payrun
    const psQ = await client.query(
      `SELECT p.*, e.company_id, pr.period_month, pr.period_year, p.payrun_id
         FROM payslips p
         JOIN employees e ON e.id = p.employee_id
         JOIN payruns pr ON pr.id = p.payrun_id
        WHERE p.id=$1`,
      [id]
    );
    if (!psQ.rowCount) return res.status(404).json({ error: 'Payslip not found' });
    const ps = psQ.rows[0];
    if (ps.company_id !== req.user.company_id) return res.status(403).json({ error: 'Forbidden' });

    await client.query('BEGIN');
    const result = await computePayslipForEmployee(ps.employee_id, ps.period_year, ps.period_month);
    if (!result) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Salary structure missing' });
    }
    const { earnings, deductions, gross, net, employerCost, counts } = result;

    // Update payslip core fields
    await client.query(
      `UPDATE payslips SET payable_days=$1, total_worked_days=$2, total_leaves=$3, basic_wage=$4, gross_wage=$5, net_wage=$6, employer_cost=$7, status='generated' WHERE id=$8`,
      [counts.payableDays, counts.present, counts.leave, earnings.find(e=>e.name==='Monthly Wage')?.amount || 0, gross, net, employerCost, id]
    );
    // Replace components
    await client.query('DELETE FROM payslip_components WHERE payslip_id=$1', [id]);
    for (const e of earnings) {
      await client.query(
        `INSERT INTO payslip_components (payslip_id, component_name, amount, is_deduction) VALUES ($1,$2,$3,$4)`,
        [id, e.name, e.amount, false]
      );
    }
    for (const d of deductions) {
      await client.query(
        `INSERT INTO payslip_components (payslip_id, component_name, amount, is_deduction) VALUES ($1,$2,$3,$4)`,
        [id, d.name, d.amount, true]
      );
    }

    // CRITICAL FIX: Recalculate payrun totals after recomputing payslip
    const payrunId = ps.payrun_id;
    
    // Recalculate all payslips in this payrun to get accurate totals
    const allPayslipsQ = await client.query(
      `SELECT id, employee_id FROM payslips WHERE payrun_id=$1 AND status != 'cancelled'`,
      [payrunId]
    );
    
    let totalEmployerCost = 0;
    for (const slip of allPayslipsQ.rows) {
      const slipResult = await computePayslipForEmployee(slip.employee_id, ps.period_year, ps.period_month);
      if (slipResult) {
        totalEmployerCost += slipResult.employerCost;
      }
    }
    
    const employeeCount = allPayslipsQ.rowCount;
    await client.query(
      'UPDATE payruns SET employee_count=$1, total_employer_cost=$2 WHERE id=$3',
      [employeeCount, totalEmployerCost, payrunId]
    );

    await client.query('COMMIT');
    res.json({ id, status: 'generated', payrun_totals_updated: true });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch(_) {}
    console.error(e);
    res.status(500).json({ error: 'Failed to recompute payslip' });
  } finally {
    client.release();
  }
}

// Generate a PDF for a single payslip
export async function getPayslipPdf(req, res) {
  try {
    const { id } = req.params;
    const ps = await pool.query(
      `SELECT p.*, e.company_id, e.first_name, e.last_name, e.email, pr.period_month, pr.period_year
         FROM payslips p
         JOIN employees e ON e.id = p.employee_id
         JOIN payruns pr ON pr.id = p.payrun_id
        WHERE p.id=$1`,
      [id]
    );
    if (!ps.rowCount) return res.status(404).json({ error: 'Payslip not found' });
    const slip = ps.rows[0];
    if (slip.company_id !== req.user.company_id) return res.status(403).json({ error: 'Forbidden' });
    if (req.user.role === 'employee') {
      const me = await pool.query('SELECT id FROM employees WHERE user_id=$1', [req.user.id]);
      if (!me.rowCount || me.rows[0].id !== slip.employee_id) return res.status(403).json({ error: 'Forbidden' });
    }
    const comps = await pool.query('SELECT component_name, amount, is_deduction FROM payslip_components WHERE payslip_id=$1', [id]);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=payslip_${id}.pdf`);
    const doc = new PDFDocument({ margin: 50 });
    doc.pipe(res);
    doc.fontSize(18).text('Payslip', { align: 'center' });
    doc.moveDown();
    doc.fontSize(12).text(`Employee: ${slip.first_name || ''} ${slip.last_name || ''}`);
    doc.text(`Email: ${slip.email || ''}`);
  doc.text(`Period: ${String(slip.period_month).padStart(2,'0')}/${slip.period_year} (Generated: ${new Date(slip.created_at).toISOString().slice(0,10)})`);
    doc.text(`Status: ${slip.status}`);
    doc.moveDown();
    doc.text(`Payable Days: ${slip.payable_days || 0}`);
    doc.text(`Worked Days: ${slip.total_worked_days || 0}`);
    doc.text(`Leave Days: ${slip.total_leaves || 0}`);
    doc.moveDown();
    doc.fontSize(14).text('Earnings');
    comps.rows.filter(c=>!c.is_deduction).forEach(c=>{
      doc.fontSize(12).text(`${c.component_name}: ${Number(c.amount).toFixed(2)}`);
    });
    doc.moveDown();
    doc.fontSize(14).text('Deductions');
    comps.rows.filter(c=>c.is_deduction).forEach(c=>{
      doc.fontSize(12).text(`${c.component_name}: ${Number(c.amount).toFixed(2)}`);
    });
    doc.moveDown();
    doc.fontSize(12).text(`Gross Wage: ${Number(slip.gross_wage).toFixed(2)}`);
    doc.text(`Net Wage: ${Number(slip.net_wage).toFixed(2)}`);
    doc.end();
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to generate payslip PDF' });
  }
}

// Yearly salary PDF for an employee (gross/net monthly breakdown)
export async function getEmployeeYearSalaryPdf(req, res) {
  try {
    const { employee_id } = req.params;
    const year = parseInt(req.query.year, 10);
    if (!year) return res.status(400).json({ error: 'year query param required' });
    // Employee access restriction
    if (req.user.role === 'employee') {
      const me = await pool.query('SELECT id FROM employees WHERE user_id=$1', [req.user.id]);
      if (!me.rowCount || me.rows[0].id !== employee_id) return res.status(403).json({ error: 'Forbidden' });
    }
    // Verify employee belongs to company
    const emp = await pool.query('SELECT id, first_name, last_name, email, company_id FROM employees WHERE id=$1', [employee_id]);
    if (!emp.rowCount) return res.status(404).json({ error: 'Employee not found' });
    if (emp.rows[0].company_id !== req.user.company_id) return res.status(403).json({ error: 'Forbidden' });

    const payslips = await pool.query(
      `SELECT period_month, gross_wage, net_wage, payable_days, total_worked_days, total_leaves
         FROM payslips p
         JOIN payruns pr ON pr.id = p.payrun_id
        WHERE p.employee_id=$1 AND pr.period_year=$2
        ORDER BY pr.period_month ASC`,
      [employee_id, year]
    );
    const totalGross = payslips.rows.reduce((s,r)=>s+Number(r.gross_wage),0);
    const totalNet = payslips.rows.reduce((s,r)=>s+Number(r.net_wage),0);

    res.setHeader('Content-Type','application/pdf');
    res.setHeader('Content-Disposition',`attachment; filename=salary_${employee_id}_${year}.pdf`);
    const doc = new PDFDocument({ margin:50 });
    doc.pipe(res);
    doc.fontSize(18).text(`Yearly Salary Report - ${year}`, { align:'center' });
    doc.moveDown();
    doc.fontSize(12).text(`Employee: ${emp.rows[0].first_name || ''} ${emp.rows[0].last_name || ''}`);
    doc.text(`Email: ${emp.rows[0].email || ''}`);
    doc.text(`Company: ${req.user.company_id}`);
    doc.moveDown();
    doc.text(`Total Gross: ${totalGross.toFixed(2)}`);
    doc.text(`Total Net: ${totalNet.toFixed(2)}`);
    doc.moveDown();
    doc.fontSize(14).text('Monthly Breakdown');
    payslips.rows.forEach(r=>{
      doc.fontSize(12).text(`Month ${r.period_month}: Gross=${Number(r.gross_wage).toFixed(2)} Net=${Number(r.net_wage).toFixed(2)} PayableDays=${r.payable_days||0} Worked=${r.total_worked_days||0} Leave=${r.total_leaves||0}`);
    });
    doc.end();
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to generate yearly salary PDF' });
  }
}

export async function monthlyEmployerCost(req, res) {
  try {
    const year = parseInt(req.query.year, 10);
    if (!year) return res.status(400).json({ error: 'year query param required' });
    const { rows } = await pool.query(
      `SELECT period_month, total_employer_cost
         FROM payruns
        WHERE company_id=$1 AND period_year=$2
        ORDER BY period_month`,
      [req.user.company_id, year]
    );
    // Normalize to 12 months
    const data = Array.from({length:12}, (_,i)=>({ month: i+1, employer_cost: 0 }));
    rows.forEach(r=>{ data[r.period_month-1].employer_cost = Number(r.total_employer_cost); });
    res.json({ year, months: data });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to fetch employer cost' });
  }
}

export async function monthlyEmployeeCount(req, res) {
  try {
    const year = parseInt(req.query.year, 10);
    if (!year) return res.status(400).json({ error: 'year query param required' });
    const months = [];
    for (let m=1; m<=12; m++) {
      const lastDay = new Date(Date.UTC(year, m, 0)).toISOString().slice(0,10);
      const q = await pool.query(
        `SELECT COUNT(*)::int AS c FROM employees WHERE company_id=$1 AND date_of_joining <= $2`,
        [req.user.company_id, lastDay]
      );
      months.push({ month: m, employee_count: q.rows[0].c });
    }
    res.json({ year, months });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to fetch employee counts' });
  }
}

export async function listMyPayslips(req, res) {
  try {
    const userId = req.user.id;
    const empQ = await pool.query('SELECT id FROM employees WHERE user_id=$1', [userId]);
    if (!empQ.rowCount) return res.status(404).json({ error: 'Employee profile not found' });
    const employeeId = empQ.rows[0].id;
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize || '20', 10)));
    const offset = (page - 1) * pageSize;
    const countQ = await pool.query('SELECT COUNT(*)::int AS c FROM payslips WHERE employee_id=$1', [employeeId]);
    const total = countQ.rows[0].c;
    // join payruns to get period for absent computation
    const q = await pool.query(
      `SELECT p.*, pr.period_month, pr.period_year
         FROM payslips p
         JOIN payruns pr ON pr.id = p.payrun_id
        WHERE p.employee_id=$1
        ORDER BY p.created_at DESC
        LIMIT $2 OFFSET $3`,
      [employeeId, pageSize, offset]
    );
    // compute expected/absent per slip
    const wdwQ = await pool.query('SELECT working_days_per_week FROM salary_structure WHERE employee_id=$1', [employeeId]);
    const wdw = wdwQ.rowCount ? (wdwQ.rows[0].working_days_per_week || 5) : 5;
    const items = q.rows.map(slip => {
      const expected = countExpectedWorkingDaysInMonth(slip.period_year, slip.period_month, wdw);
      const present = Number(slip.total_worked_days || 0);
      const leave = Number(slip.total_leaves || 0);
      const absent_days = Math.max(0, expected - (present + leave));
      return { ...slip, absent_days, expected_working_days: expected };
    });
    res.json({ items, page, pageSize, total });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to fetch my payslips' });
  }
}
