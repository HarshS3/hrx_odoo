# Payroll Integration Test Guide

## Issues Fixed

### 1. ✅ Recompute Now Updates Payrun Totals
**Problem**: When a payslip was recomputed after salary changes, the payrun's `total_employer_cost` and `employee_count` were not updated.

**Fix**: The `recomputePayslip` function now recalculates all payslips in the payrun to get accurate totals, including proper employer cost calculation (gross + employer PF contributions).

**File Modified**: `backend/controllers/payrollController.js`

### 2. ✅ Validation and Warnings for Missing Salary Structures
**Problem**: Payrun creation silently skipped employees without salary structures, which could be confusing.

**Fix**: The `createPayrun` function now:
- Checks all employees for salary structures before processing
- Returns warnings in the response listing employees that were skipped
- Frontend displays these warnings with a 10-second toast notification

**Files Modified**: 
- `backend/controllers/payrollController.js`
- `frontend/src/pages/PayrollPage.jsx`

### 3. ✅ Leave Integration Verified
**Verified**: Approved leave requests correctly create attendance records with `status='leave'` through the `upsertAttendanceLeaveForRange` function.

**File Verified**: `backend/controllers/leaveController.js`

### 4. ✅ Salary Component Calculation Verified
**Verified**: 
- Percentage-based components correctly apply to prorated base wage
- Fixed amount components are used as-is
- PF employee and employer rates are calculated correctly
- Professional tax is applied from override value

**File Verified**: `backend/controllers/payrollController.js`

---

## Integration Flow Summary

### 1. Salary Setup → Payroll
```
1. HR/Admin/Payroll sets up salary for employee in Employee Directory
   - Monthly wage (required)
   - Working days per week
   - PF rates (employee & employer)
   - Professional tax override
   - Salary components (allowances/deductions)

2. Data stored in:
   - salary_structure table (one per employee)
   - salary_components table (multiple per employee)

3. Payroll uses this data to calculate payslips
```

### 2. Leave Approval → Attendance → Payroll
```
1. Employee submits leave request
   - Stored in leave_requests table with status='pending'

2. HR/Admin approves leave
   - leave_requests.status updated to 'approved'
   - leave_allocations.used_days incremented
   - CRITICAL: attendance records created for each leave day
     * status='leave'
     * work_hours=0, break_hours=0, extra_hours=0

3. Payroll counts leave days from attendance table
   - getMonthlyAttendanceCounts() queries attendance table
   - Counts: present (status='present') and leave (status='leave')
   - payableDays = present + leave (capped at expected working days)
   - Proration: payableDays / expectedWorkingDays
```

### 3. Payroll Calculation Logic
```
For each employee:
1. Fetch salary_structure
2. Count attendance: present + leave days
3. Calculate proration factor
4. Calculate base wage: monthly_wage * prorateFactor
5. Apply salary_components:
   - Percentage components: (base * value) / 100
   - Fixed components: value
6. Add PF deductions:
   - Employee PF: (base * pf_employee_rate) / 100
   - Employer PF: (base * pf_employer_rate) / 100
7. Add Professional Tax (if override set)
8. Calculate:
   - gross = sum of all earnings
   - net = gross - totalDeductions
   - employerCost = gross + employer PF
```

---

## Test Scenarios

### Test 1: Complete Flow from Salary Setup to Payroll
**Steps**:
1. Navigate to Employee Directory
2. Select an employee
3. Click "Setup Salary" (HR/Admin/Payroll only)
4. Enter:
   - Monthly Wage: 50,000
   - Working Days Per Week: 5
   - PF Employee Rate: 12%
   - PF Employer Rate: 12%
   - Professional Tax: 200
5. Add an allowance:
   - Name: "House Rent Allowance"
   - Type: Percentage
   - Value: 40
6. Add a deduction:
   - Name: "Health Insurance"
   - Type: Fixed
   - Value: 1000
7. Save and verify in employee details

8. Go to Payroll page
9. Create new payrun for current month
10. Verify:
    - Employee appears in payrun
    - Check payslip calculations:
      * Monthly Wage: 50,000 (prorated if attendance < expected)
      * HRA: 40% of base = 20,000 (prorated)
      * Health Insurance: 1,000 (fixed)
      * PF Employee: 12% of base = 6,000 (prorated)
      * Professional Tax: 200
      * Gross = Monthly Wage + HRA
      * Net = Gross - (Health Insurance + PF Employee + PT)

**Expected Results**:
- If employee has 22 working days and 22 present+leave days:
  * Base = 50,000
  * HRA = 20,000
  * Gross = 70,000
  * Deductions = 1,000 + 6,000 + 200 = 7,200
  * Net = 62,800

### Test 2: Leave Integration
**Steps**:
1. As employee, submit leave request for 2 days
2. As HR/Admin, approve the leave request
3. Verify attendance table has 2 records with status='leave'
4. Create payrun for that month
5. Verify:
   - Payslip shows correct leave days count
   - Leave days are included in payable days
   - Salary is prorated based on (present + leave) days

**Expected Results**:
- If month has 22 working days, employee has 18 present + 2 leave:
  * Payable days = 20
  * Proration = 20/22 = 0.909
  * Base = 50,000 * 0.909 = 45,454.55
  * All percentage components apply to prorated base

### Test 3: Salary Update and Recompute
**Steps**:
1. Create a payrun for current month
2. View a payslip, note the amounts
3. Go to Employee Directory
4. Update employee's salary:
   - Change Monthly Wage to 60,000
   - Add new allowance: "Travel Allowance" - 10% percentage
5. Go back to Payroll
6. Click "Compute" button on the payslip
7. Verify:
   - Payslip recalculated with new salary
   - New allowance appears in components
   - Payrun totals updated

**Expected Results**:
- Payslip shows updated calculations
- New component "Travel Allowance" = 6,000 (or prorated)
- Payrun's total_employer_cost reflects new totals
- Response shows: `payrun_totals_updated: true`

### Test 4: Missing Salary Structure Warning
**Steps**:
1. Create a new employee without setting up salary
2. Create a payrun
3. Verify warning appears:
   - Toast notification shows skipped employees
   - Warning lasts 10 seconds
   - Lists employee names that were skipped
4. Check payrun:
   - Employee count only includes employees with salary
   - Skipped employee has no payslip

**Expected Results**:
- Warning toast: "X employee(s) were skipped because they don't have salary structures defined."
- Lists: "Skipped employees: John Doe, Jane Smith"
- Payrun created but only for employees with salary

### Test 5: Component Types (Percentage vs Fixed)
**Steps**:
1. Setup salary with:
   - Monthly Wage: 40,000
   - Working Days: 5/week
2. Add components:
   - "Transport Allowance" - Percentage - 15%
   - "Food Vouchers" - Fixed - 2,000
   - "Loan Deduction" - Fixed - 5,000
   - "Late Fine" - Percentage - 2%
3. Create payrun with 15 present days (out of 22 working days)
4. Verify calculations:
   - Proration = 15/22 = 0.682
   - Base = 40,000 * 0.682 = 27,273
   - Transport Allowance = 27,273 * 15% = 4,091 (percentage on prorated base)
   - Food Vouchers = 2,000 (fixed, no proration)
   - Loan Deduction = 5,000 (fixed, no proration)
   - Late Fine = 27,273 * 2% = 545 (percentage on prorated base)

**Expected Results**:
- Percentage components scale with proration
- Fixed components remain constant regardless of days worked

### Test 6: Multiple Recomputes
**Steps**:
1. Create payrun
2. Recompute a payslip (note payrun totals)
3. Update another employee's salary
4. Recompute that employee's payslip
5. Verify payrun totals updated correctly after each recompute

**Expected Results**:
- After first recompute: totals updated
- After second recompute: totals updated again
- Total employer cost = sum of all payslips' employerCost

### Test 7: Cancelled Payslips
**Steps**:
1. Create payrun with 3 employees
2. Cancel one employee's payslip
3. Recompute another employee's payslip
4. Verify:
   - Cancelled payslip NOT included in totals
   - Employee count = 2 (not 3)
   - Total employer cost only includes non-cancelled payslips

**Expected Results**:
- Cancelled payslips excluded from `status != 'cancelled'` query
- Payrun totals accurate

---

## API Endpoints Involved

### Salary Management
- `GET /api/salary/:employee_id/structure` - Get employee salary structure
- `PUT /api/salary/:employee_id/structure` - Upsert salary structure
- `POST /api/salary/:employee_id/components` - Add salary component
- `DELETE /api/salary/components/:component_id` - Delete component

### Payroll
- `POST /api/payroll/payruns` - Create payrun (now returns warnings)
- `GET /api/payroll/payruns` - List payruns
- `POST /api/payroll/payslips/:id/recompute` - Recompute payslip (now updates totals)
- `GET /api/payroll/payslips/:id` - Get payslip details
- `POST /api/payroll/payslips/:id/validate` - Validate payslip
- `POST /api/payroll/payslips/:id/cancel` - Cancel payslip

### Leaves
- `POST /api/leave-requests/:id/approve` - Approve leave (creates attendance records)

---

## Database Tables Involved

### Salary
- `salary_structure` - One per employee, stores monthly_wage, PF rates, PT, working days
- `salary_components` - Multiple per employee, allowances/deductions

### Attendance & Leave
- `attendance` - Daily records with status: 'present', 'leave', 'absent'
- `leave_requests` - Leave applications with status: 'pending', 'approved', 'rejected'
- `leave_allocations` - Available leave balances per employee/type

### Payroll
- `payruns` - Monthly payroll batches with totals
- `payslips` - Individual employee pay records per payrun
- `payslip_components` - Breakdown of earnings/deductions per payslip

---

## Common Issues and Solutions

### Issue 1: Payslip shows 0 days worked
**Cause**: No attendance records for the month
**Solution**: 
- Employees must mark attendance or have approved leaves
- Attendance records created via:
  * Face recognition check-in/out
  * Manual attendance entry
  * Approved leave requests

### Issue 2: Salary components not appearing
**Cause**: Components not saved properly or employee not selected
**Solution**:
- Ensure components are saved with correct employee_id
- Refresh employee details after saving
- Check database: `SELECT * FROM salary_components WHERE employee_id='...'`

### Issue 3: Recompute doesn't reflect salary changes
**Cause**: Browser cache or salary not saved
**Solution**:
- Hard refresh browser (Ctrl+F5)
- Verify salary structure updated in database
- Check network tab for API responses

### Issue 4: Leave days not counted in payroll
**Cause**: Leave not approved or attendance records not created
**Solution**:
- Verify leave request status is 'approved'
- Check attendance table for status='leave' records
- Query: `SELECT * FROM attendance WHERE employee_id='...' AND status='leave' AND date BETWEEN '...' AND '...'`

---

## Performance Considerations

### Recompute Function Optimization
The recompute function recalculates all payslips to ensure accurate totals. For large companies:

**Current**: O(n) where n = number of payslips in payrun
**Optimization (future)**: Store employer_cost in payslips table, then:
```sql
UPDATE payruns 
SET total_employer_cost = (
  SELECT SUM(employer_cost) 
  FROM payslips 
  WHERE payrun_id=$1 AND status != 'cancelled'
)
WHERE id=$1
```

---

## Testing Checklist

- [ ] Test 1: Complete salary setup → payroll flow
- [ ] Test 2: Leave approval → attendance → payroll
- [ ] Test 3: Salary update → recompute → totals updated
- [ ] Test 4: Missing salary structure warnings
- [ ] Test 5: Percentage vs Fixed component calculations
- [ ] Test 6: Multiple recomputes update totals correctly
- [ ] Test 7: Cancelled payslips excluded from totals
- [ ] Verify proration calculations
- [ ] Verify PF calculations (employee + employer)
- [ ] Verify professional tax deduction
- [ ] Verify gross/net calculations
- [ ] Check payrun totals accuracy
- [ ] Test role-based access (HR/Admin/Payroll only)

---

## Success Criteria

✅ **Salary Module**: 
- HR/Admin/Payroll can define complete salary structure
- Components (allowances/deductions) saved correctly
- Percentage and fixed types work as expected

✅ **Leave Module**:
- Approved leaves create attendance records
- Leave days counted in payroll calculations
- Proration includes leave days as payable

✅ **Payroll Integration**:
- Calculations use latest salary data
- Leave days properly integrated
- Recompute updates individual payslip AND payrun totals
- Warnings shown for employees without salary
- All calculations interconnected and accurate

✅ **Recompute Function**:
- Updates payslip with latest data
- Recalculates payrun totals
- Returns success confirmation
- Handles cancelled payslips correctly
