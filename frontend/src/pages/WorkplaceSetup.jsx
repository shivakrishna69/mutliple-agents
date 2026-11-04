/**
 * Workplace (HR and admins): the departments people belong to, and what makes a day a working day
 * for each employee.
 *
 *   Departments  codes, web address names, heads, active or not (DepartmentsPanel.jsx)
 *   Offices      location, time zone, shift and weekly offs (components/workplace/OfficesPanel.jsx)
 *   Holidays     company-wide and per-office holidays by year (HolidaysPanel.jsx)
 *   Employees    each employee's base office (EmployeeOfficesPanel.jsx)
 *
 * Attendance and leave both read these, so set them up before employees apply for leave.
 */

import { useState } from 'react';
import { BuildingIcon, FlagIcon, MapPinIcon, UsersIcon } from '../components/Icons.jsx';
import PageHeader from '../components/PageHeader.jsx';
import { Tabs } from '../components/ui.jsx';
import DepartmentsPanel from '../components/workplace/DepartmentsPanel.jsx';
import EmployeeOfficesPanel from '../components/workplace/EmployeeOfficesPanel.jsx';
import HolidaysPanel from '../components/workplace/HolidaysPanel.jsx';
import OfficesPanel from '../components/workplace/OfficesPanel.jsx';

const WORKPLACE_TABS = Object.freeze([
  { id: 'departments', label: 'Departments', Icon: BuildingIcon, Panel: DepartmentsPanel },
  { id: 'offices', label: 'Offices', Icon: MapPinIcon, Panel: OfficesPanel },
  { id: 'holidays', label: 'Holidays', Icon: FlagIcon, Panel: HolidaysPanel },
  { id: 'employees', label: 'Employees', Icon: UsersIcon, Panel: EmployeeOfficesPanel },
]);

export default function WorkplaceSetup() {
  const [activeTabId, setActiveTabId] = useState(WORKPLACE_TABS[0].id);
  const { Panel } = WORKPLACE_TABS.find((tab) => tab.id === activeTabId);
  return (
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-8 sm:px-8">
      <PageHeader
        title="Workplace"
        description="Departments people belong to; offices, weekly offs and holidays decide their working days."
      />
      <Tabs
        tabs={WORKPLACE_TABS.map(({ id, label, Icon }) => ({ id, label, Icon }))}
        activeTabId={activeTabId}
        onChange={setActiveTabId}
        label="Workplace sections"
      />
      <Panel />
    </div>
  );
}
