// CLEAN REBUILD OF COMPONENT TO FIX PRIOR CORRUPTION
import { useState, useEffect, useCallback } from 'react'
import { useSelector } from 'react-redux'
import { AlertTriangle, X, Plus } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import PageHeader from '@/components/layout/PageHeader'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts'
import { AnimatePresence, motion } from 'framer-motion'
import { 
  createPayrun, listPayruns, listPayslipsForPayrun, getPayslip,
  listMyPayslips, validatePayslip, cancelPayslip, recomputePayslip,
  downloadPayslipPdf, employerCostReport, employeeCountReport
} from '@/api/payroll'
import toast from 'react-hot-toast'

export default function PayrollPage() {
  const { currentUser } = useSelector(s => s.user)
  const isPayrollOrAdmin = ['payroll','admin'].includes(currentUser?.role?.toLowerCase())
  const isEmployee = currentUser?.role?.toLowerCase() === 'employee'

  const [activeTab, setActiveTab] = useState('dashboard')
  const [activePayrunSubTab, setActivePayrunSubTab] = useState('payrun') // payrun | validate
  const [activePayslipTab, setActivePayslipTab] = useState('worked-days')
  const [searchTerm, setSearchTerm] = useState('')
  const [employerCostView, setEmployerCostView] = useState('monthly')
  const [employeeCountView, setEmployeeCountView] = useState('monthly')
  const [payruns, setPayruns] = useState([]) // [{... , employees:[slips]}]
  const [selectedPayrun, setSelectedPayrun] = useState(null)
  const [selectedEmployee, setSelectedEmployee] = useState(null)
  const [employerCostData, setEmployerCostData] = useState([])
  const [employeeCountData, setEmployeeCountData] = useState([])
  const [loading, setLoading] = useState(false)
  const [showCreatePayrunModal, setShowCreatePayrunModal] = useState(false)
  const [newPayrun, setNewPayrun] = useState({ period_month: new Date().getMonth()+1, period_year: new Date().getFullYear() })

  const getMonthName = (m) => ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m-1] || ''

  async function loadData() {
    setLoading(true)
    try {
      if (isPayrollOrAdmin) {
        const prData = await listPayruns({ page:1, pageSize:100 })
        const withSlips = await Promise.all(prData.items.map(async pr => {
          const slips = await listPayslipsForPayrun(pr.id, { page:1, pageSize:500 })
          return { ...pr, employees: slips.items }
        }))
        setPayruns(withSlips)
        const year = new Date().getFullYear()
        const cost = await employerCostReport(year)
        const count = await employeeCountReport(year)
        const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
        setEmployerCostData(cost.months.map(m => ({ month: monthNames[m.month-1], monthly: m.employer_cost || 0, annual: (m.employer_cost||0)*12 })))
        setEmployeeCountData(count.months.map(m => ({ month: monthNames[m.month-1], monthly: m.employee_count||0, annual: m.employee_count||0 })))
      } else if (isEmployee) {
        const my = await listMyPayslips({ page:1, pageSize:200 })
        const grouped = {}
        my.items.forEach(slip => {
          const key = `${slip.period_year}-${slip.period_month}`
          grouped[key] = grouped[key] || { id:key, period_month: slip.period_month, period_year: slip.period_year, employees: [] }
          grouped[key].employees.push(slip)
        })
        setPayruns(Object.values(grouped))
      }
    } catch (e) {
      toast.error(e.message || 'Failed to load payroll data')
    } finally { setLoading(false) }
  }
  useEffect(()=>{ loadData() }, [currentUser])

  const openPayslipDetail = useCallback(async (slip, payrun) => {
    try {
      const full = await getPayslip(slip.id)
      const earnings = full.summary.earnings.map(c => ({ name: c.component_name || c.name, rate: '-', amount: Number(c.amount)||0 }))
      const deductions = full.summary.deductions.map(c => ({ name: c.component_name || c.name, rate: '-', amount: Number(c.amount)||0 }))
      setSelectedPayrun(payrun)
      setSelectedEmployee({
        ...full.payslip,
        employee_name: full.payslip.employee_name,
        attendance: { days: full.payslip.total_worked_days||0, detail: `(${full.payslip.total_worked_days||0} working days)` },
        paidTimeOffDetails: { days: full.payslip.total_leaves||0, detail: `(${full.payslip.total_leaves||0} approved leaves)` },
        salaryComponents: { earnings, deductions, gross: Number(full.payslip.gross_wage)||0, netAmount: Number(full.payslip.net_wage)||0 }
      })
    } catch (e) { toast.error(e.message || 'Failed to open payslip') }
  }, [])

  async function handleCreatePayrun() {
    try { 
      const result = await createPayrun(newPayrun); 
      toast.success('Payrun created'); 
      
      // Show warnings if employees were skipped
      if (result.warnings && result.warnings.employees_without_salary) {
        const skipped = result.warnings.employees_without_salary;
        toast.warning(
          `${result.warnings.message}\n\nSkipped employees: ${skipped.map(e => e.name).join(', ')}`,
          { duration: 10000 }
        );
      }
      
      setShowCreatePayrunModal(false); 
      loadData() 
    } catch(e){ 
      toast.error(e.message||'Create failed') 
    }
  }
  async function handleValidatePayslip(id) { try { await validatePayslip(id); toast.success('Validated'); setSelectedEmployee(null); loadData() } catch(e){ toast.error(e.message||'Validate failed') } }
  async function handleCancelPayslip(id) { try { await cancelPayslip(id); toast.success('Cancelled'); setSelectedEmployee(null); loadData() } catch(e){ toast.error(e.message||'Cancel failed') } }
  async function handleRecomputePayslip(id) { try { await recomputePayslip(id); toast.success('Recomputed'); setSelectedEmployee(null); loadData() } catch(e){ toast.error(e.message||'Recompute failed') } }
  async function handleDownloadPayslip(id, name){ try { const blob = await downloadPayslipPdf(id); const url = URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download=`payslip_${name}_${id}.pdf`; a.click(); URL.revokeObjectURL(url); toast.success('Downloaded') } catch(e){ toast.error(e.message||'Download failed') } }

  // Warnings for dashboard
  const warnings = []
  const currentMonth = new Date().getMonth()+1
  const currentYear = new Date().getFullYear()
  if (isPayrollOrAdmin && !payruns.find(p=>p.period_month===currentMonth && p.period_year===currentYear)) {
    warnings.push({ id:'no-payrun', text:`⚠️ No payrun generated for ${getMonthName(currentMonth)} ${currentYear}. Click "New Payrun".` })
  }
  const unvalidated = payruns.reduce((acc,pr)=> acc + (pr.employees||[]).filter(e=> e.status!=='validated' && e.status!=='cancelled').length ,0)
  if (isPayrollOrAdmin && unvalidated) warnings.push({ id:'unvalidated', text:`⚠️ ${unvalidated} payslip${unvalidated!==1?'s':''} pending validation.` })
  warnings.push({ id:'info', text:'ℹ️ Payroll menu is accessible only to Admin / Payroll roles.' })

  if (!isPayrollOrAdmin && !isEmployee) {
    return (
      <div className="p-8">
        <Card><CardContent className="p-8 text-center"><p className="text-muted-foreground">You don't have permission to view payroll</p></CardContent></Card>
      </div>
    )
  }

  return (
    <>
      <PageHeader searchTerm={searchTerm} onSearchChange={setSearchTerm} showNewButton={false} />
      <div className="p-8">
        {/* Top-level tabs */}
        <div className="flex gap-4 mb-6 border-b border-gray-200 dark:border-gray-700">
          {['dashboard','payrun'].map(tab => (
            <button key={tab} onClick={()=>setActiveTab(tab)} className={`pb-3 px-4 font-medium text-sm transition-colors ${activeTab===tab ? 'text-purple-600 border-b-2 border-purple-600':'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300'}`}>{tab==='dashboard'?'Dashboard':'Payrun'}</button>
          ))}
        </div>

        {activeTab==='dashboard' && (
          <div className="grid grid-cols-2 gap-6">
            {/* Left column: warnings + payruns list */}
            <div className="space-y-6">
              <Card className="border-orange-200 bg-orange-50/50 dark:bg-orange-950/20 dark:border-orange-800">
                <CardHeader className="pb-4"><CardTitle className="text-lg font-semibold flex items-center gap-2"><AlertTriangle size={20} className="text-orange-500"/>Warning</CardTitle></CardHeader>
                <CardContent className="space-y-3">
                  {warnings.map(w => <div key={w.id} className="text-blue-600 dark:text-blue-400 text-sm">{w.text}</div>)}
                </CardContent>
              </Card>
              <Card className="border-blue-200 dark:border-blue-800">
                <CardHeader className="pb-4 flex flex-row items-center justify-between"><CardTitle className="text-lg font-semibold">Payrun</CardTitle>{isPayrollOrAdmin && <Button size="sm" onClick={()=>setShowCreatePayrunModal(true)}><Plus size={16} className="mr-1"/>New Payrun</Button>}</CardHeader>
                <CardContent className="space-y-3">
                  {loading ? <p className="text-sm text-muted-foreground">Loading...</p> : payruns.length===0 ? <p className="text-sm text-muted-foreground">No payruns found</p> : payruns.map(pr => (
                    <div key={pr.id} className="text-blue-600 dark:text-blue-400 cursor-pointer text-sm" onClick={()=> setSelectedPayrun(pr)}>
                      Payrun for {getMonthName(pr.period_month)} {pr.period_year} ({pr.employee_count || pr.employees?.length || 0} payslips)
                    </div>
                  ))}
                </CardContent>
              </Card>
            </div>
            {/* Right column: charts */}
            <div className="space-y-6">
              {/* Employer Cost */}
              <Card>
                <CardHeader className="pb-2"><div className="flex items-center justify-between"><CardTitle className="text-base font-semibold">Employer cost</CardTitle><div className="flex items-center gap-2">
                  <button onClick={()=>setEmployerCostView('annually')} className={`px-3 py-1 text-xs rounded ${employerCostView==='annually'?'bg-gray-200 dark:bg-gray-700 text-gray-900 dark:text-gray-100':'text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'}`}>Annually</button>
                  <div className="relative inline-block w-10 h-5"><button onClick={()=> setEmployerCostView(employerCostView==='monthly'?'annually':'monthly')} className={`w-10 h-5 rounded-full transition-colors ${employerCostView==='monthly'?'bg-blue-600':'bg-gray-300 dark:bg-gray-600'}`}><span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform ${employerCostView==='monthly'?'translate-x-5':'translate-x-0'}`} /></button></div>
                  <button onClick={()=>setEmployerCostView('monthly')} className={`px-3 py-1 text-xs rounded ${employerCostView==='monthly'?'bg-gray-200 dark:bg-gray-700 text-gray-900 dark:text-gray-100':'text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'}`}>Monthly</button>
                </div></div></CardHeader>
                <CardContent><ResponsiveContainer width="100%" height={200}><BarChart data={employerCostData}><CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb"/><XAxis dataKey="month" tick={{fontSize:12}} axisLine={{stroke:'#9ca3af'}}/><YAxis tick={{fontSize:12}} axisLine={{stroke:'#9ca3af'}} tickFormatter={v=>`${v/1000}k`}/><Tooltip formatter={v=>`₹${v.toLocaleString()}`} contentStyle={{background:'#fff',border:'1px solid #e5e7eb'}}/><Bar dataKey={employerCostView==='monthly'?'monthly':'annual'} fill="#3b82f6" radius={[4,4,0,0]}>{employerCostData.map((e,i)=><Cell key={i} fill={i===employerCostData.length-1?'#3b82f6':'#93c5fd'} />)}</Bar></BarChart></ResponsiveContainer></CardContent>
              </Card>
              {/* Employee Count */}
              <Card>
                <CardHeader className="pb-2"><div className="flex items-center justify-between"><CardTitle className="text-base font-semibold">Employee count</CardTitle><div className="flex items-center gap-2">
                  <button onClick={()=>setEmployeeCountView('annually')} className={`px-3 py-1 text-xs rounded ${employeeCountView==='annually'?'bg-gray-200 dark:bg-gray-700 text-gray-900 dark:text-gray-100':'text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'}`}>Annually</button>
                  <div className="relative inline-block w-10 h-5"><button onClick={()=> setEmployeeCountView(employeeCountView==='monthly'?'annually':'monthly')} className={`w-10 h-5 rounded-full transition-colors ${employeeCountView==='monthly'?'bg-blue-600':'bg-gray-300 dark:bg-gray-600'}`}><span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform ${employeeCountView==='monthly'?'translate-x-5':'translate-x-0'}`} /></button></div>
                  <button onClick={()=>setEmployeeCountView('monthly')} className={`px-3 py-1 text-xs rounded ${employeeCountView==='monthly'?'bg-gray-200 dark:bg-gray-700 text-gray-900 dark:text-gray-100':'text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'}`}>Monthly</button>
                </div></div></CardHeader>
                <CardContent><ResponsiveContainer width="100%" height={200}><BarChart data={employeeCountData}><CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb"/><XAxis dataKey="month" tick={{fontSize:12}} axisLine={{stroke:'#9ca3af'}}/><YAxis tick={{fontSize:12}} axisLine={{stroke:'#9ca3af'}} domain={[0,40]}/><Tooltip formatter={v=>`${v} employees`} contentStyle={{background:'#fff',border:'1px solid #e5e7eb'}}/><Bar dataKey={employeeCountView==='monthly'?'monthly':'annual'} fill="#3b82f6" radius={[4,4,0,0]}>{employeeCountData.map((e,i)=><Cell key={i} fill={i===employeeCountData.length-1?'#3b82f6':'#93c5fd'} />)}</Bar></BarChart></ResponsiveContainer></CardContent>
              </Card>
              <Card className="border-purple-200 dark:border-purple-800 bg-purple-50/30 dark:bg-purple-950/10"><CardHeader className="pb-3"><CardTitle className="text-sm font-semibold">Understanding Wage Types</CardTitle></CardHeader><CardContent className="space-y-2 text-xs"><div><span className="font-semibold text-purple-700 dark:text-purple-400">Employer Cost:</span> <span className="text-gray-600 dark:text-gray-400">Monthly wage incl. employer contributions</span></div><div><span className="font-semibold text-purple-700 dark:text-purple-400">Basic Wage:</span> <span className="text-gray-600 dark:text-gray-400">Prorated basic salary</span></div><div><span className="font-semibold text-purple-700 dark:text-purple-400">Gross Wage:</span> <span className="text-gray-600 dark:text-gray-400">Basic + allowances</span></div><div><span className="font-semibold text-purple-700 dark:text-purple-400">Net Wage:</span> <span className="text-gray-600 dark:text-gray-400">Gross - deductions</span></div></CardContent></Card>
            </div>
          </div>
        )}

        {activeTab==='payrun' && (
          <div>
            <div className="mb-6 p-4 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg text-sm text-blue-800 dark:text-blue-300">ℹ️ Payslips are generated from attendance; validate or recompute as needed. "Done" shows once a payslip is validated.</div>
            <div className="flex gap-4 mb-6">
              {['payrun','validate'].map(sub => (
                <button key={sub} onClick={()=>setActivePayrunSubTab(sub)} className={`pb-2 px-4 font-medium text-sm transition-colors ${activePayrunSubTab===sub? 'text-purple-600 bg-purple-100 dark:bg-purple-900/30 rounded-md':'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300'}`}>{sub==='payrun'?'Payrun':'Validate'}</button>
              ))}
            </div>
            {!selectedPayrun ? (
              <Card>
                <CardHeader className="flex flex-row items-center justify-between pb-4"><CardTitle>Payruns</CardTitle>{isPayrollOrAdmin && <Button className="bg-green-500 hover:bg-green-600 text-white" onClick={()=>setShowCreatePayrunModal(true)}>New Payrun</Button>}</CardHeader>
                <CardContent>
                  <div className="overflow-x-auto">
                    <table className="w-full border-collapse">
                      <thead><tr className="bg-gray-100 dark:bg-gray-800 border-b dark:border-gray-700"><th className="text-left py-3 px-4 text-sm">Period</th><th className="text-left py-3 px-4 text-sm">Payslips</th><th className="text-left py-3 px-4 text-sm">Employer Cost</th><th className="text-left py-3 px-4 text-sm">Pending</th></tr></thead>
                      <tbody>
                        {loading ? <tr><td colSpan={4} className="py-8 text-center text-gray-500">Loading...</td></tr> : payruns.length===0 ? <tr><td colSpan={4} className="py-8 text-center text-gray-500">No payruns yet.</td></tr> : payruns.map(pr => {
                          const pending = (pr.employees||[]).filter(e=>e.status!=='validated' && e.status!=='cancelled').length
                          return (
                            <tr key={pr.id} className="border-b dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer" onClick={()=> setSelectedPayrun(pr)}>
                              <td className="py-3 px-4 text-sm">{getMonthName(pr.period_month)} {pr.period_year}</td>
                              <td className="py-3 px-4 text-sm">{pr.employee_count ?? pr.employees?.length ?? 0}</td>
                              <td className="py-3 px-4 text-sm">₹ {(pr.total_employer_cost||0).toLocaleString()}</td>
                              <td className="py-3 px-4 text-sm">{pending}</td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-6">
                <Card><CardContent className="p-6"><div className="flex items-center justify-between mb-4"><h2 className="text-xl font-semibold">Payrun {getMonthName(selectedPayrun.period_month)} {selectedPayrun.period_year}</h2><Button variant="outline" size="sm" onClick={()=>{setSelectedPayrun(null); setSelectedEmployee(null)}}>Back</Button></div><div className="grid grid-cols-3 gap-6"><div><p className="text-sm text-gray-500 dark:text-gray-400">Employer Cost</p><p className="text-lg font-semibold">₹ {(selectedPayrun.total_employer_cost||0).toLocaleString()}</p></div><div><p className="text-sm text-gray-500 dark:text-gray-400">Gross Wage</p><p className="text-lg font-semibold">₹ {(selectedPayrun.employees?.reduce((s,e)=> s+(e.gross_wage||0),0)||0).toLocaleString()}</p></div><div><p className="text-sm text-gray-500 dark:text-gray-400">Net Wage</p><p className="text-lg font-semibold">₹ {(selectedPayrun.employees?.reduce((s,e)=> s+(e.net_wage||0),0)||0).toLocaleString()}</p></div></div></CardContent></Card>
                <Card><CardHeader><CardTitle>Employee Payslips</CardTitle></CardHeader><CardContent><div className="overflow-x-auto"><table className="w-full"><thead><tr className="border-b dark:border-gray-700"><th className="text-left py-3 px-4 text-sm">Pay Period</th><th className="text-left py-3 px-4 text-sm">Employee</th><th className="text-left py-3 px-4 text-sm">Basic Wage</th><th className="text-left py-3 px-4 text-sm">Gross</th><th className="text-left py-3 px-4 text-sm">Net</th><th className="text-left py-3 px-4 text-sm">Employer Cost</th><th className="text-left py-3 px-4 text-sm">Status</th><th className="text-left py-3 px-4 text-sm">Actions</th></tr></thead><tbody>{selectedPayrun.employees?.map(emp => (
                  <tr key={emp.id} className="border-b dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800"><td className="py-3 px-4 text-sm">{getMonthName(selectedPayrun.period_month)} {selectedPayrun.period_year}</td><td className="py-3 px-4 text-sm text-blue-600 dark:text-blue-400 cursor-pointer" onClick={()=> openPayslipDetail(emp, selectedPayrun)}>{emp.employee_name || 'Employee'}</td><td className="py-3 px-4 text-sm">₹ {(emp.basic_wage||0).toLocaleString()}</td><td className="py-3 px-4 text-sm">₹ {(emp.gross_wage||0).toLocaleString()}</td><td className="py-3 px-4 text-sm">₹ {(emp.net_wage||0).toLocaleString()}</td><td className="py-3 px-4 text-sm font-semibold text-purple-600 dark:text-purple-400">₹ {(emp.employer_cost||0).toLocaleString()}</td><td className="py-3 px-4"><span className={`px-3 py-1 text-xs rounded-full ${emp.status==='validated'?'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400': emp.status==='cancelled'? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400':'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400'}`}>{emp.status==='validated'?'Done':emp.status||'Generated'}</span></td><td className="py-3 px-4 text-sm"><div className="flex gap-2"><Button size="sm" variant="outline" onClick={()=> handleRecomputePayslip(emp.id)}>Compute</Button><Button size="sm" onClick={()=> handleValidatePayslip(emp.id)} disabled={emp.status==='validated'||emp.status==='cancelled'}>Validate</Button><Button size="sm" className="bg-red-600 hover:bg-red-700 text-white" disabled={emp.status==='cancelled'} onClick={()=> handleCancelPayslip(emp.id)}>Cancel</Button></div></td></tr>
                ))}</tbody></table></div></CardContent></Card>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Payslip Detail Modal */}
      <AnimatePresence>{selectedEmployee && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"><motion.div initial={{opacity:0,scale:0.95}} animate={{opacity:1,scale:1}} exit={{opacity:0,scale:0.95}} className="bg-white dark:bg-gray-900 rounded-lg shadow-xl max-w-4xl w-full max-h-[90vh] overflow-y-auto"><div className="sticky top-0 bg-white dark:bg-gray-900 border-b dark:border-gray-700 p-6 flex items-center justify-between"><div><h2 className="text-2xl font-bold mb-2">{selectedEmployee.employee_name || 'Employee'}</h2><div className="flex gap-4 text-sm"><div><span className="text-gray-500 dark:text-gray-400">Payrun</span><span className="ml-2 text-blue-600 dark:text-blue-400">{getMonthName(selectedPayrun?.period_month)} {selectedPayrun?.period_year}</span></div><div><span className="text-gray-500 dark:text-gray-400">Status:</span><span className={`ml-2 px-2 py-1 text-xs rounded-full ${selectedEmployee.status==='validated'?'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400': selectedEmployee.status==='cancelled'?'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400':'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400'}`}>{selectedEmployee.status==='validated'?'Done':selectedEmployee.status||'Generated'}</span></div></div></div><div className="flex gap-2"><Button size="sm" variant="outline" onClick={()=> handleRecomputePayslip(selectedEmployee.id)} disabled={selectedEmployee.status==='cancelled'}>Compute</Button><Button size="sm" onClick={()=> handleValidatePayslip(selectedEmployee.id)} disabled={selectedEmployee.status==='validated'||selectedEmployee.status==='cancelled'} className="bg-green-600 hover:bg-green-700 text-white disabled:bg-gray-400">Validate</Button><Button size="sm" onClick={()=> handleCancelPayslip(selectedEmployee.id)} disabled={selectedEmployee.status==='cancelled'} className="bg-red-600 hover:bg-red-700 text-white disabled:bg-gray-400">Cancel</Button><Button size="sm" onClick={()=> handleDownloadPayslip(selectedEmployee.id, selectedEmployee.employee_name||'employee')} className="bg-purple-600 hover:bg-purple-700 text-white">Export PDF</Button><button onClick={()=> setSelectedEmployee(null)} className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg"><X size={20}/></button></div></div>
        <div className="p-6 space-y-6">
          <div className="grid grid-cols-2 gap-6"><div><p className="text-sm text-gray-500 dark:text-gray-400 mb-1">Period</p><p className="font-medium">01 {getMonthName(selectedPayrun?.period_month)} - 31 {getMonthName(selectedPayrun?.period_month)}</p></div><div><p className="text-sm text-gray-500 dark:text-gray-400 mb-1">Salary Structure</p><p className="font-semibold text-blue-600 dark:text-blue-400">Regular Pay</p></div></div>
          <div className="flex gap-4 border-b dark:border-gray-700 mb-4"><button onClick={()=> setActivePayslipTab('worked-days')} className={`pb-3 px-6 text-sm font-medium border-b-2 ${activePayslipTab==='worked-days'?'border-pink-500 text-pink-600 dark:text-pink-400':'border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300'}`}>Worked Days</button><button onClick={()=> setActivePayslipTab('salary-computation')} className={`pb-3 px-6 text-sm font-medium border-b-2 ${activePayslipTab==='salary-computation'?'border-pink-500 text-pink-600 dark:text-pink-400':'border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300'}`}>Salary Computation</button></div>
          {activePayslipTab==='worked-days' && (
            <table className="w-full border dark:border-gray-700 text-sm">
              <thead>
                <tr className="bg-gray-50 dark:bg-gray-800">
                  <th className="text-left py-2 px-4 border-r dark:border-gray-700">Type</th>
                  <th className="text-left py-2 px-4 border-r dark:border-gray-700">Days</th>
                  <th className="text-left py-2 px-4">Amount</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-t dark:border-gray-700">
                  <td className="py-2 px-4 border-r dark:border-gray-700">Attendance</td>
                  <td className="py-2 px-4 border-r dark:border-gray-700">
                    <span className="text-blue-600 dark:text-blue-400">{(selectedEmployee.attendance?.days||selectedEmployee.total_worked_days||0).toFixed(2)}</span>
                    <span className="text-gray-500 ml-1">{selectedEmployee.attendance?.detail}</span>
                  </td>
                  <td className="py-2 px-4">
                    ₹ {(
                      (Number(selectedEmployee.basic_wage||0) / (Number(selectedEmployee.payable_days)||22)) *
                      (selectedEmployee.attendance?.days||selectedEmployee.total_worked_days||0)
                    ).toFixed(2)}
                  </td>
                </tr>
                <tr className="border-t dark:border-gray-700">
                  <td className="py-2 px-4 border-r dark:border-gray-700">Paid Time Off</td>
                  <td className="py-2 px-4 border-r dark:border-gray-700">
                    <span className="text-blue-600 dark:text-blue-400">{(selectedEmployee.paidTimeOffDetails?.days||selectedEmployee.total_leaves||0).toFixed(2)}</span>
                    <span className="text-gray-500 ml-1">{selectedEmployee.paidTimeOffDetails?.detail}</span>
                  </td>
                  <td className="py-2 px-4">
                    ₹ {(
                      (Number(selectedEmployee.basic_wage||0) / (Number(selectedEmployee.payable_days)||22)) *
                      (selectedEmployee.paidTimeOffDetails?.days||selectedEmployee.total_leaves||0)
                    ).toFixed(2)}
                  </td>
                </tr>
                <tr className="border-t dark:border-gray-700 bg-gray-50 dark:bg-gray-800 font-semibold">
                  <td className="py-2 px-4 border-r dark:border-gray-700"></td>
                  <td className="py-2 px-4 border-r dark:border-gray-700">{((selectedEmployee.attendance?.days||selectedEmployee.total_worked_days||0)+(selectedEmployee.paidTimeOffDetails?.days||selectedEmployee.total_leaves||0)).toFixed(2)}</td>
                  <td className="py-2 px-4">₹ {Number(selectedEmployee.basic_wage||0).toFixed(2)}</td>
                </tr>
              </tbody>
            </table>
          )}
          {activePayslipTab==='salary-computation' && (<table className="w-full border dark:border-gray-700 text-sm"><thead><tr className="bg-gray-50 dark:bg-gray-800"><th className="text-left py-2 px-4 border-r dark:border-gray-700">Rule Name</th><th className="text-left py-2 px-4 border-r dark:border-gray-700">Rate %</th><th className="text-left py-2 px-4">Amount</th></tr></thead><tbody>{selectedEmployee.salaryComponents?.earnings.map((e,i)=>(<tr key={i} className="border-t dark:border-gray-700"><td className="py-2 px-4 border-r dark:border-gray-700">{e.name}</td><td className="py-2 px-4 border-r dark:border-gray-700">{e.rate}</td><td className="py-2 px-4">₹ {e.amount.toFixed(2)}</td></tr>))}<tr className="border-t-2 dark:border-gray-600 bg-gray-100 dark:bg-gray-800 font-semibold"><td className="py-2 px-4 border-r dark:border-gray-700">Gross</td><td className="py-2 px-4 border-r dark:border-gray-700">100</td><td className="py-2 px-4">₹ {(selectedEmployee.salaryComponents?.gross||0).toFixed(2)}</td></tr>{selectedEmployee.salaryComponents?.deductions.map((d,i)=>(<tr key={i} className="border-t dark:border-gray-700"><td className="py-2 px-4 border-r dark:border-gray-700">{d.name}</td><td className="py-2 px-4 border-r dark:border-gray-700">{d.rate}</td><td className="py-2 px-4">- ₹ {d.amount.toFixed(2)}</td></tr>))}<tr className="border-t-2 dark:border-gray-600 bg-gray-100 dark:bg-gray-800 font-semibold"><td className="py-2 px-4 border-r dark:border-gray-700">Net Amount</td><td className="py-2 px-4 border-r dark:border-gray-700">100</td><td className="py-2 px-4">₹ {(selectedEmployee.salaryComponents?.netAmount||0).toFixed(2)}</td></tr></tbody></table>)}
          <div className="bg-gray-50 dark:bg-gray-800 p-4 rounded-lg text-xs text-gray-600 dark:text-gray-400">Salary is calculated from monthly attendance. Paid leaves count towards payable days.</div>
        </div></motion.div></div>
      )}</AnimatePresence>

      {showCreatePayrunModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"><Card className="w-full max-w-md"><CardHeader><CardTitle className="flex items-center justify-between">Create New Payrun <button onClick={()=> setShowCreatePayrunModal(false)} className="p-2" aria-label="Close"><X size={20}/></button></CardTitle></CardHeader><CardContent className="space-y-4"><div><label className="block text-sm font-medium mb-2">Period Month</label><select className="w-full px-3 py-2 bg-background text-foreground border border-input rounded-md" value={newPayrun.period_month} onChange={e=> setNewPayrun(p=> ({...p, period_month: parseInt(e.target.value)}))}>{[1,2,3,4,5,6,7,8,9,10,11,12].map(m=> <option key={m} value={m}>{getMonthName(m)}</option>)}</select></div><div><label className="block text-sm font-medium mb-2">Period Year</label><Input type="number" value={newPayrun.period_year} onChange={e=> setNewPayrun(p=> ({...p, period_year: parseInt(e.target.value)}))} min={2020} max={2100}/></div><div className="flex justify-end gap-2"><Button variant="outline" onClick={()=> setShowCreatePayrunModal(false)}>Cancel</Button><Button onClick={handleCreatePayrun}>Create Payrun</Button></div></CardContent></Card></div>
      )}
    </>
  )
}
