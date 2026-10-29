/**
 * Leave administration (HR and admins), at /leave/admin.
 *
 *   Policies       the leave year and every leave type's policy (components/leave/LeavePoliciesPanel.jsx)
 *   Balances       an employee's balances and history; adjustments and encashments (EmployeeLeavePanel.jsx)
 *   Payroll        unpaid and encashed days for a payroll month, as CSV (PayrollExportPanel.jsx)
 *   Maintenance    run the leave job or the balance check now (LeaveJobsPanel.jsx)
 *
 * Employees' own leave, requests and approvals live on the leave pages for everyone.
 */

import { useState } from 'react';
import { CalendarIcon, CurrencyIcon, ShieldIcon, UsersIcon } from '../components/Icons.jsx';
import EmployeeLeavePanel from '../components/leave/EmployeeLeavePanel.jsx';
import LeaveJobsPanel from '../components/leave/LeaveJobsPanel.jsx';
import LeavePoliciesPanel from '../components/leave/LeavePoliciesPanel.jsx';
import PayrollExportPanel from '../components/leave/PayrollExportPanel.jsx';
import PageHeader from '../components/PageHeader.jsx';
import { Tabs } from '../components/ui.jsx';

const ADMINISTRATION_TABS = Object.freeze([
  { id: 'policies', label: 'Policies', Icon: CalendarIcon, Panel: LeavePoliciesPanel },
  { id: 'balances', label: 'Balances', Icon: UsersIcon, Panel: EmployeeLeavePanel },
  { id: 'payroll', label: 'Payroll', Icon: CurrencyIcon, Panel: PayrollExportPanel },
  { id: 'maintenance', label: 'Maintenance', Icon: ShieldIcon, Panel: LeaveJobsPanel },
]);

export default function LeaveAdministration() {
  const [activeTabId, setActiveTabId] = useState(ADMINISTRATION_TABS[0].id);
  const { Panel } = ADMINISTRATION_TABS.find((tab) => tab.id === activeTabId);
  return (
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-8 sm:px-8">
      <PageHeader
        title="Leave administration"
        description="Your company's leave policies, every employee's balances, and the figures payroll needs."
      />
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
