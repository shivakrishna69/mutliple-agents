/**
 * Workplace (HR and admins): what makes a day a working day for each employee.
 *
 *   Offices      location, time zone, shift and weekly offs (components/workplace/OfficesPanel.jsx)
 *   Holidays     company-wide and per-office holidays by year (HolidaysPanel.jsx)
 *   Employees    each employee's base office (EmployeeOfficesPanel.jsx)
 *
 * Attendance and leave both read these, so set them up before employees apply for leave.
 */

import { useState } from 'react';
import { FlagIcon, MapPinIcon, UsersIcon } from '../components/Icons.jsx';
import PageHeader from '../components/PageHeader.jsx';
import { Tabs } from '../components/ui.jsx';
import EmployeeOfficesPanel from '../components/workplace/EmployeeOfficesPanel.jsx';
import HolidaysPanel from '../components/workplace/HolidaysPanel.jsx';
import OfficesPanel from '../components/workplace/OfficesPanel.jsx';

const WORKPLACE_TABS = Object.freeze([
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
        description="Offices, weekly offs and holidays decide each employee's working days, for attendance and leave."
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
