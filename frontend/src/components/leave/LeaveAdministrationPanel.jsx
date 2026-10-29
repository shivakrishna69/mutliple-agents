/**
 * Leave administration (HR and admins): the Administration tab of the Leave page, at /leave/admin.
 *
 *   Policies       the leave year and every leave type's policy (components/leave/LeavePoliciesPanel.jsx)
 *   Balances       an employee's balances and history; adjustments and encashments (EmployeeLeavePanel.jsx)
 *   Payroll        unpaid and encashed days for a payroll month, as CSV (PayrollExportPanel.jsx)
 *   Maintenance    run the leave job or the balance check now (LeaveJobsPanel.jsx)
 *
 * Employees' own leave, requests and approvals are the other tabs (pages/LeaveCenter.jsx).
 */

import { useState } from 'react';
import { CalendarIcon, CurrencyIcon, ShieldIcon, UsersIcon } from '../Icons.jsx';
import { Tabs } from '../ui.jsx';
import EmployeeLeavePanel from './EmployeeLeavePanel.jsx';
import LeaveJobsPanel from './LeaveJobsPanel.jsx';
import LeavePoliciesPanel from './LeavePoliciesPanel.jsx';
import PayrollExportPanel from './PayrollExportPanel.jsx';

const ADMINISTRATION_TABS = Object.freeze([
  { id: 'policies', label: 'Policies', Icon: CalendarIcon, Panel: LeavePoliciesPanel },
  { id: 'balances', label: 'Balances', Icon: UsersIcon, Panel: EmployeeLeavePanel },
  { id: 'payroll', label: 'Payroll', Icon: CurrencyIcon, Panel: PayrollExportPanel },
  { id: 'maintenance', label: 'Maintenance', Icon: ShieldIcon, Panel: LeaveJobsPanel },
]);

export default function LeaveAdministrationPanel() {
  const [activeTabId, setActiveTabId] = useState(ADMINISTRATION_TABS[0].id);
  const { Panel } = ADMINISTRATION_TABS.find((tab) => tab.id === activeTabId);
  return (
    <div className="space-y-6">
      <Tabs
        tabs={ADMINISTRATION_TABS.map(({ id, label, Icon }) => ({ id, label, Icon }))}
        activeTabId={activeTabId}
        onChange={setActiveTabId}
        label="Leave administration sections"
      />
      <Panel />
    </div>
  );
}
