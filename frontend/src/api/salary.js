import client from './client';

/**
 * Get employee's salary structure and components
 * @param {number} employeeId - Employee ID
 */
export async function getEmployeeSalary(employeeId) {
  const { data } = await client.get(`/salary/${employeeId}/structure`);
  return data;
}

/**
 * Get current user's salary structure
 */
export async function getMySalary() {
  const { data } = await client.get('/salary/me');
  return data;
}

/**
 * List all salary structures (Admin/HR/Payroll only)
 */
export async function listSalaryStructures({ page = 1, pageSize = 25 } = {}) {
  const { data } = await client.get('/salary', { params: { page, pageSize } });
  return data;
}

/**
 * Update/Create salary structure for employee (Admin/HR/Payroll only)
 */
export async function upsertSalaryStructure(employeeId, payload) {
  const { data } = await client.put(`/salary/${employeeId}/structure`, payload);
  return data;
}

/**
 * Add salary component
 */
export async function addSalaryComponent(employeeId, component) {
  const { data } = await client.post(`/salary/${employeeId}/components`, component);
  return data;
}

/**
 * Update salary component
 */
export async function updateSalaryComponent(employeeId, componentId, component) {
  const { data } = await client.patch(`/salary/${employeeId}/components/${componentId}`, component);
  return data;
}

/**
 * Delete salary component
 */
export async function deleteSalaryComponent(employeeId, componentId) {
  const { data } = await client.delete(`/salary/${employeeId}/components/${componentId}`);
  return data;
}
