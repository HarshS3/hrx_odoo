import { useState, useEffect } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Plus, Trash2, DollarSign } from 'lucide-react'
import toast from 'react-hot-toast'
import {
  upsertSalaryStructure,
  addSalaryComponent,
  updateSalaryComponent,
  deleteSalaryComponent
} from '@/api/salary'

export default function SalarySetupModal({ 
  isOpen, 
  onClose, 
  employee, 
  salaryData,
  onSalaryUpdated 
}) {
  const [loading, setLoading] = useState(false)
  const [structure, setStructure] = useState({
    monthly_wage: '',
    working_days_per_week: 5,
    break_hours: 1,
    pf_employee_rate: 12,
    pf_employer_rate: 12,
    professional_tax_override: null
  })
  const [components, setComponents] = useState([])
  const [newComponent, setNewComponent] = useState({
    name: '',
    computation_type: 'fixed',
    value: '',
    is_deduction: false
  })
  const [editingComponentId, setEditingComponentId] = useState(null)

  useEffect(() => {
    if (salaryData?.structure) {
      setStructure({
        monthly_wage: salaryData.structure.monthly_wage || '',
        working_days_per_week: salaryData.structure.working_days_per_week || 5,
        break_hours: salaryData.structure.break_hours || 1,
        pf_employee_rate: salaryData.structure.pf_employee_rate || 12,
        pf_employer_rate: salaryData.structure.pf_employer_rate || 12,
        professional_tax_override: salaryData.structure.professional_tax_override || null
      })
    }
    if (salaryData?.components) {
      setComponents(salaryData.components)
    }
  }, [salaryData])

  const handleSaveStructure = async () => {
    if (!structure.monthly_wage) {
      toast.error('Monthly wage is required')
      return
    }

    setLoading(true)
    try {
      await upsertSalaryStructure(employee.id, {
        monthly_wage: parseFloat(structure.monthly_wage),
        working_days_per_week: parseInt(structure.working_days_per_week),
        break_hours: parseFloat(structure.break_hours),
        pf_employee_rate: parseFloat(structure.pf_employee_rate),
        pf_employer_rate: parseFloat(structure.pf_employer_rate),
        professional_tax_override: structure.professional_tax_override ? parseFloat(structure.professional_tax_override) : null
      })
      
      toast.success('Salary structure saved successfully')
      onSalaryUpdated()
    } catch (error) {
      toast.error(error.response?.data?.error || 'Failed to save salary structure')
    } finally {
      setLoading(false)
    }
  }

  const handleAddComponent = async () => {
    if (!newComponent.name || !newComponent.value) {
      toast.error('Component name and value are required')
      return
    }

    setLoading(true)
    try {
      await addSalaryComponent(employee.id, {
        name: newComponent.name,
        computation_type: newComponent.computation_type,
        value: parseFloat(newComponent.value),
        is_deduction: newComponent.is_deduction
      })
      
      toast.success('Component added successfully')
      setNewComponent({
        name: '',
        computation_type: 'fixed',
        value: '',
        is_deduction: false
      })
      onSalaryUpdated()
    } catch (error) {
      toast.error(error.response?.data?.error || 'Failed to add component')
    } finally {
      setLoading(false)
    }
  }

  const handleDeleteComponent = async (componentId) => {
    if (!confirm('Are you sure you want to delete this component?')) return

    setLoading(true)
    try {
      await deleteSalaryComponent(employee.id, componentId)
      toast.success('Component deleted successfully')
      onSalaryUpdated()
    } catch (error) {
      toast.error(error.response?.data?.error || 'Failed to delete component')
    } finally {
      setLoading(false)
    }
  }

  if (!isOpen) return null

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"
        onClick={onClose}
      >
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.95 }}
          className="w-full max-w-4xl max-h-[90vh] overflow-y-auto"
          onClick={(e) => e.stopPropagation()}
        >
          <Card>
            <CardContent className="p-6">
              {/* Header */}
              <div className="flex items-center justify-between mb-6">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-gradient-to-br from-green-500 to-emerald-600 flex items-center justify-center">
                    <DollarSign className="w-6 h-6 text-white" />
                  </div>
                  <div>
                    <h2 className="text-xl font-bold">Salary Setup</h2>
                    <p className="text-sm text-muted-foreground">
                      {employee.first_name} {employee.last_name} - {employee.position}
                    </p>
                  </div>
                </div>
                <button
                  onClick={onClose}
                  className="text-muted-foreground hover:text-foreground transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Salary Structure */}
              <div className="space-y-6">
                <div>
                  <h3 className="font-semibold text-lg mb-4 border-b pb-2">Basic Salary Structure</h3>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="text-sm font-medium mb-1 block">Monthly Wage *</label>
                      <Input
                        type="number"
                        value={structure.monthly_wage}
                        onChange={(e) => setStructure({ ...structure, monthly_wage: e.target.value })}
                        placeholder="Enter monthly wage"
                      />
                    </div>

                    <div>
                      <label className="text-sm font-medium mb-1 block">Working Days per Week</label>
                      <Input
                        type="number"
                        min="1"
                        max="7"
                        value={structure.working_days_per_week}
                        onChange={(e) => setStructure({ ...structure, working_days_per_week: e.target.value })}
                      />
                    </div>

                    <div>
                      <label className="text-sm font-medium mb-1 block">Break Hours per Day</label>
                      <Input
                        type="number"
                        step="0.5"
                        value={structure.break_hours}
                        onChange={(e) => setStructure({ ...structure, break_hours: e.target.value })}
                      />
                    </div>

                    <div>
                      <label className="text-sm font-medium mb-1 block">PF Employee Rate (%)</label>
                      <Input
                        type="number"
                        step="0.1"
                        value={structure.pf_employee_rate}
                        onChange={(e) => setStructure({ ...structure, pf_employee_rate: e.target.value })}
                      />
                    </div>

                    <div>
                      <label className="text-sm font-medium mb-1 block">PF Employer Rate (%)</label>
                      <Input
                        type="number"
                        step="0.1"
                        value={structure.pf_employer_rate}
                        onChange={(e) => setStructure({ ...structure, pf_employer_rate: e.target.value })}
                      />
                    </div>

                    <div>
                      <label className="text-sm font-medium mb-1 block">Professional Tax Override</label>
                      <Input
                        type="number"
                        value={structure.professional_tax_override || ''}
                        onChange={(e) => setStructure({ ...structure, professional_tax_override: e.target.value })}
                        placeholder="Leave empty for auto calculation"
                      />
                    </div>
                  </div>

                  <div className="mt-4 flex justify-end">
                    <Button onClick={handleSaveStructure} disabled={loading}>
                      {loading ? 'Saving...' : 'Save Structure'}
                    </Button>
                  </div>
                </div>

                {/* Salary Components */}
                <div>
                  <h3 className="font-semibold text-lg mb-4 border-b pb-2">Salary Components</h3>
                  
                  {/* Existing Components */}
                  {components.length > 0 && (
                    <div className="space-y-2 mb-4">
                      {components.map((component) => (
                        <div
                          key={component.id}
                          className="flex items-center justify-between p-3 bg-muted/30 rounded-lg"
                        >
                          <div className="flex-1">
                            <p className="text-sm font-medium">{component.name}</p>
                            <p className="text-xs text-muted-foreground">
                              {component.computation_type === 'percentage'
                                ? `${component.value}% of base`
                                : `Fixed: ₹${component.value}`}
                            </p>
                          </div>
                          <div className="flex items-center gap-3">
                            <span
                              className={`text-sm font-semibold ${
                                component.is_deduction ? 'text-red-600' : 'text-green-600'
                              }`}
                            >
                              {component.is_deduction ? '-' : '+'}₹{component.amount?.toLocaleString('en-IN') || '0'}
                            </span>
                            <span className="text-xs text-muted-foreground">
                              {component.is_deduction ? 'Deduction' : 'Allowance'}
                            </span>
                            <button
                              onClick={() => handleDeleteComponent(component.id)}
                              className="text-red-500 hover:text-red-700 p-1"
                              disabled={loading}
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Add New Component */}
                  <div className="p-4 border-2 border-dashed rounded-lg">
                    <p className="text-sm font-medium mb-3">Add New Component</p>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="text-xs mb-1 block">Component Name</label>
                        <Input
                          value={newComponent.name}
                          onChange={(e) => setNewComponent({ ...newComponent, name: e.target.value })}
                          placeholder="e.g., HRA, Travel Allowance"
                        />
                      </div>

                      <div>
                        <label className="text-xs mb-1 block">Type</label>
                        <select
                          className="w-full h-10 px-3 rounded-md border border-input bg-background"
                          value={newComponent.computation_type}
                          onChange={(e) => setNewComponent({ ...newComponent, computation_type: e.target.value })}
                        >
                          <option value="fixed">Fixed Amount</option>
                          <option value="percentage">Percentage of Base</option>
                        </select>
                      </div>

                      <div>
                        <label className="text-xs mb-1 block">
                          {newComponent.computation_type === 'percentage' ? 'Percentage (%)' : 'Amount (₹)'}
                        </label>
                        <Input
                          type="number"
                          step="0.01"
                          value={newComponent.value}
                          onChange={(e) => setNewComponent({ ...newComponent, value: e.target.value })}
                          placeholder="Enter value"
                        />
                      </div>

                      <div>
                        <label className="text-xs mb-1 block">Category</label>
                        <select
                          className="w-full h-10 px-3 rounded-md border border-input bg-background"
                          value={newComponent.is_deduction}
                          onChange={(e) => setNewComponent({ ...newComponent, is_deduction: e.target.value === 'true' })}
                        >
                          <option value="false">Allowance (+)</option>
                          <option value="true">Deduction (-)</option>
                        </select>
                      </div>
                    </div>

                    <div className="mt-3 flex justify-end">
                      <Button onClick={handleAddComponent} disabled={loading} size="sm">
                        <Plus className="w-4 h-4 mr-1" />
                        Add Component
                      </Button>
                    </div>
                  </div>
                </div>
              </div>

              {/* Footer */}
              <div className="flex gap-2 justify-end pt-6 border-t mt-6">
                <Button variant="outline" onClick={onClose}>
                  Close
                </Button>
              </div>
            </CardContent>
          </Card>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  )
}
