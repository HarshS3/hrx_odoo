import { pool } from '../db.js';

// Public employee fields reused for salary views
const EMPLOYEE_MIN_FIELDS = `e.id, e.first_name, e.last_name, e.email, e.company_id`;

// Self view of own salary structure OR get employee salary (admin/hr/payroll)
export async function getMySalaryStructure(req, res) {
  try {
    let empId;
    
    // Check if employee_id is provided in params (admin/hr/payroll viewing other employee)
    if (req.params.employee_id) {
      const { employee_id } = req.params;
      const companyId = req.user.company_id;
      
      // Verify employee belongs to same company
      const empQ = await pool.query(
        'SELECT id FROM employees WHERE id=$1 AND company_id=$2 LIMIT 1',
        [employee_id, companyId]
      );
      
      if (!empQ.rowCount) {
        return res.status(404).json({ error: 'Employee not found' });
      }
      
      empId = empQ.rows[0].id;
    } else {
      // Self view - get from user_id
      const userId = req.user.id;
      const empQ = await pool.query('SELECT id FROM employees WHERE user_id=$1 LIMIT 1', [userId]);
      if (!empQ.rowCount) return res.status(404).json({ error: 'Employee profile not found' });
      empId = empQ.rows[0].id;
    }
    
    const salQ = await pool.query(
      'SELECT id, monthly_wage, yearly_wage, working_days_per_week, break_hours, pf_employee_rate, pf_employer_rate, professional_tax_override, created_at, updated_at FROM salary_structure WHERE employee_id=$1',
      [empId]
    );
    const compsQ = await pool.query(
      'SELECT id, name, computation_type, value, amount, is_deduction FROM salary_components WHERE employee_id=$1 ORDER BY name ASC',
      [empId]
    );
    res.json({ structure: salQ.rowCount ? salQ.rows[0] : null, components: compsQ.rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to fetch salary structure' });
  }
}

// Admin/hr/payroll: upsert salary structure for employee
export async function upsertSalaryStructure(req, res) {
  try {
    const { employee_id } = req.params; // employee id
    const companyId = req.user.company_id;
    const role = req.user.role;
    if (!['admin','hr','payroll'].includes(role)) return res.status(403).json({ error: 'Forbidden' });
    // Ensure employee belongs to company
    const empQ = await pool.query('SELECT id FROM employees WHERE id=$1 AND company_id=$2 LIMIT 1', [employee_id, companyId]);
    if (!empQ.rowCount) return res.status(404).json({ error: 'Employee not found' });
    const empId = empQ.rows[0].id;

    const {
      monthly_wage,
      working_days_per_week,
      break_hours,
      pf_employee_rate,
      pf_employer_rate,
      professional_tax_override
    } = req.body || {};

    if (monthly_wage == null) {
      return res.status(400).json({ error: 'monthly_wage required' });
    }

    const upsertQ = await pool.query(
      `INSERT INTO salary_structure (employee_id, monthly_wage, working_days_per_week, break_hours, pf_employee_rate, pf_employer_rate, professional_tax_override)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (employee_id) DO UPDATE SET
         monthly_wage = EXCLUDED.monthly_wage,
         working_days_per_week = EXCLUDED.working_days_per_week,
         break_hours = EXCLUDED.break_hours,
         pf_employee_rate = EXCLUDED.pf_employee_rate,
         pf_employer_rate = EXCLUDED.pf_employer_rate,
         professional_tax_override = EXCLUDED.professional_tax_override,
         updated_at = NOW()
       RETURNING id, employee_id, monthly_wage, yearly_wage, working_days_per_week, break_hours, pf_employee_rate, pf_employer_rate, professional_tax_override, created_at, updated_at`,
      [empId, monthly_wage, working_days_per_week || null, break_hours || null, pf_employee_rate || null, pf_employer_rate || null, professional_tax_override || null]
    );
    res.json(upsertQ.rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to upsert salary structure' });
  }
}

// Admin/hr/payroll: list salary structures (basic pagination)
export async function listSalaryStructures(req, res) {
  try {
    const companyId = req.user.company_id;
    const role = req.user.role;
    if (!['admin','hr','payroll'].includes(role)) return res.status(403).json({ error: 'Forbidden' });
    const page = parseInt(req.query.page || '1', 10);
    const pageSize = Math.min(parseInt(req.query.pageSize || '25', 10), 100);
    const offset = (page - 1) * pageSize;
    const rowsQ = await pool.query(
      `SELECT ss.id, ss.employee_id, ss.monthly_wage, ss.yearly_wage, ss.working_days_per_week, ss.break_hours,
              ss.pf_employee_rate, ss.pf_employer_rate, ss.professional_tax_override,
              ss.created_at, ss.updated_at,
              ${EMPLOYEE_MIN_FIELDS}
         FROM salary_structure ss
         JOIN employees e ON e.id = ss.employee_id
        WHERE e.company_id = $1
        ORDER BY ss.updated_at DESC
        LIMIT $2 OFFSET $3`,
      [companyId, pageSize, offset]
    );
    res.json({ page, pageSize, count: rowsQ.rowCount, items: rowsQ.rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to list salary structures' });
  }
}

// Salary components CRUD (admin/hr/payroll)
export async function addSalaryComponent(req, res) {
  try {
    const { employee_id } = req.params;
    const role = req.user.role;
    const companyId = req.user.company_id;
    if (!['admin','hr','payroll'].includes(role)) return res.status(403).json({ error: 'Forbidden' });
    const empQ = await pool.query('SELECT id FROM employees WHERE id=$1 AND company_id=$2 LIMIT 1', [employee_id, companyId]);
    if (!empQ.rowCount) return res.status(404).json({ error: 'Employee not found' });
    const empId = empQ.rows[0].id;
    const { name, computation_type, value, is_deduction } = req.body || {};
    if (!name || !computation_type || value == null) return res.status(400).json({ error: 'name, computation_type, value required' });
    if (!['fixed','percentage'].includes(computation_type)) return res.status(400).json({ error: 'Invalid computation_type' });
    // compute amount if percentage using monthly_wage
    let amount = null;
    if (computation_type === 'percentage') {
      const salQ = await pool.query('SELECT monthly_wage FROM salary_structure WHERE employee_id=$1', [empId]);
      if (!salQ.rowCount) return res.status(400).json({ error: 'Salary structure must exist first' });
      amount = (Number(salQ.rows[0].monthly_wage) * Number(value)) / 100.0;
    } else {
      amount = Number(value);
    }
    const insQ = await pool.query(
      `INSERT INTO salary_components (employee_id, name, computation_type, value, amount, is_deduction)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id, name, computation_type, value, amount, is_deduction`,
      [empId, name, computation_type, value, amount, !!is_deduction]
    );
    res.status(201).json(insQ.rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to add salary component' });
  }
}

export async function updateSalaryComponent(req, res) {
  try {
    const { employee_id, component_id } = req.params;
    const role = req.user.role;
    const companyId = req.user.company_id;
    if (!['admin','hr','payroll'].includes(role)) return res.status(403).json({ error: 'Forbidden' });
    const empQ = await pool.query('SELECT id FROM employees WHERE id=$1 AND company_id=$2 LIMIT 1', [employee_id, companyId]);
    if (!empQ.rowCount) return res.status(404).json({ error: 'Employee not found' });
    const empId = empQ.rows[0].id;
    const existingQ = await pool.query('SELECT * FROM salary_components WHERE id=$1 AND employee_id=$2', [component_id, empId]);
    if (!existingQ.rowCount) return res.status(404).json({ error: 'Component not found' });
    const input = req.body || {};
    const allowed = ['name','computation_type','value','is_deduction'];
    const updates = [];
    const vals = [];
    let i = 1;
    for (const k of allowed) {
      if (Object.prototype.hasOwnProperty.call(input, k)) {
        if (k === 'computation_type' && !['fixed','percentage'].includes(input[k])) {
          return res.status(400).json({ error: 'Invalid computation_type' });
        }
        updates.push(`${k} = $${i++}`);
        vals.push(input[k]);
      }
    }
    if (!updates.length) return res.status(400).json({ error: 'No fields to update', allowed });
    // recompute amount if needed
    let amount = existingQ.rows[0].amount;
    const newCompType = input.computation_type || existingQ.rows[0].computation_type;
    const newValue = input.value != null ? input.value : existingQ.rows[0].value;
    if (newCompType === 'percentage') {
      const salQ = await pool.query('SELECT monthly_wage FROM salary_structure WHERE employee_id=$1', [empId]);
      if (!salQ.rowCount) return res.status(400).json({ error: 'Salary structure must exist first' });
      amount = (Number(salQ.rows[0].monthly_wage) * Number(newValue)) / 100.0;
    } else if (input.value != null || input.computation_type) {
      amount = Number(newValue);
    }
    updates.push(`amount = $${i++}`);
    vals.push(amount);
    vals.push(component_id);
    vals.push(empId);
    const { rowCount, rows } = await pool.query(
      `UPDATE salary_components SET ${updates.join(', ')} WHERE id = $${i++} AND employee_id = $${i} RETURNING id, name, computation_type, value, amount, is_deduction`,
      vals
    );
    if (!rowCount) return res.status(404).json({ error: 'Component not found' });
    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to update salary component' });
  }
}

export async function deleteSalaryComponent(req, res) {
  try {
    const { employee_id, component_id } = req.params;
    const role = req.user.role;
    const companyId = req.user.company_id;
    if (!['admin','hr','payroll'].includes(role)) return res.status(403).json({ error: 'Forbidden' });
    const empQ = await pool.query('SELECT id FROM employees WHERE id=$1 AND company_id=$2 LIMIT 1', [employee_id, companyId]);
    if (!empQ.rowCount) return res.status(404).json({ error: 'Employee not found' });
    const empId = empQ.rows[0].id;
    const delQ = await pool.query('DELETE FROM salary_components WHERE id=$1 AND employee_id=$2', [component_id, empId]);
    if (!delQ.rowCount) return res.status(404).json({ error: 'Component not found' });
    res.json({ message: 'Deleted' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to delete salary component' });
  }
}
