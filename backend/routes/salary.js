import express from 'express';
import { authRequired, permissionsAllowed } from '../middleware/auth.js';
import {
  getMySalaryStructure,
  upsertSalaryStructure,
  listSalaryStructures,
  addSalaryComponent,
  updateSalaryComponent,
  deleteSalaryComponent
} from '../controllers/salaryController.js';

const router = express.Router();

// Self
router.get('/me', authRequired, getMySalaryStructure);

// Get employee salary structure (Admin/HR/Payroll only)
router.get('/:employee_id/structure', authRequired, permissionsAllowed('salary','view'), getMySalaryStructure);

// Admin/hr/payroll (company scoped)
router.get('/', authRequired, permissionsAllowed('salary','view'), listSalaryStructures);
router.put('/:employee_id/structure', authRequired, permissionsAllowed('salary','update'), upsertSalaryStructure);

// Components CRUD
router.post('/:employee_id/components', authRequired, permissionsAllowed('salary','create'), addSalaryComponent);
router.patch('/:employee_id/components/:component_id', authRequired, permissionsAllowed('salary','update'), updateSalaryComponent);
router.delete('/:employee_id/components/:component_id', authRequired, permissionsAllowed('salary','delete'), deleteSalaryComponent);

export default router;
