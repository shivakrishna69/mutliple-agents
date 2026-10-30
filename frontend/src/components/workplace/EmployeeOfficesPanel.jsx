/**
 * Employees' base offices (HR and admins). An employee's office gives their working days, holidays
 * and time zone; without one, attendance cannot check them in and leave cannot be priced.
 *
 *   GET /api/employees · GET /api/offices · PUT /api/employees/:id/office ({ officeLocationId })
 */

import { useState } from 'react';
import { requestEmployeeOfficeAssignment, requestEmployees, requestOffices } from '../../api/workplaceApi.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { toDisplayError, useApiResource } from '../../hooks/useApiResource.js';
import { SearchIcon, UsersIcon } from '../Icons.jsx';
import { Badge, Card, EmptyState, LoadingBlock, Notice, Spinner } from '../ui.jsx';

const NO_OFFICE = '';

function EmployeeOfficeRow({ employee, offices, onAssigned }) {
  const { csrfToken } = useAuth();
  const [isSaving, setIsSaving] = useState(false);
  const [rowError, setRowError] = useState(null);

  async function assignOffice(officeLocationId) {
    setIsSaving(true);
    setRowError(null);
    try {
      await requestEmployeeOfficeAssignment(employee.employeeId, officeLocationId || null, csrfToken);
      onAssigned(employee.employeeId, officeLocationId || null);
    } catch (assignError) {
      setRowError(toDisplayError(assignError));
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <li className="px-5 py-3 sm:px-6">
      <div className="flex flex-wrap items-center gap-4">
        <div className="min-w-48 flex-1">
          <p className="text-sm font-semibold text-slate-900">{employee.name}</p>
          <p className="truncate text-xs text-slate-500">
            {employee.designation} · {employee.email}
          </p>
        </div>
        {!employee.officeLocationId && <Badge tone="amber">No office</Badge>}
        <div className="flex items-center gap-2">
          {isSaving && <Spinner className="h-4 w-4 text-brand-500" />}
          <select
            aria-label={`Base office for ${employee.name}`}
            value={employee.officeLocationId ?? NO_OFFICE}
            disabled={isSaving}
            onChange={(changeEvent) => assignOffice(changeEvent.target.value)}
            className="rounded-lg border-0 py-1.5 pr-8 pl-3 text-sm ring-1 ring-slate-300 ring-inset focus:ring-2 focus:ring-brand-500"
          >
            <option value={NO_OFFICE}>No office</option>
            {offices.map((office) => (
              <option key={office.id} value={office.id}>
                {office.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      {rowError && (
        <div className="mt-3">
          <Notice tone="error" title={rowError.message} onDismiss={() => setRowError(null)} />
        </div>
      )}
    </li>
  );
}

export default function EmployeeOfficesPanel() {
  const employeesResource = useApiResource((signal) => requestEmployees(signal), []);
  const officesResource = useApiResource((signal) => requestOffices(signal), []);
  const [searchText, setSearchText] = useState('');
  const employees = employeesResource.data?.employees ?? [];
  const offices = officesResource.data?.offices ?? [];
  const withoutOffice = employees.filter((employee) => !employee.officeLocationId).length;
  const query = searchText.trim().toLowerCase();
  const visibleEmployees = query
    ? employees.filter((employee) =>
        [employee.name, employee.email, employee.designation].some((value) => value?.toLowerCase().includes(query)),
      )
    : employees;

  function handleAssigned(employeeId, officeLocationId) {
    employeesResource.setData((data) => ({
      ...data,
      employees: data.employees.map((employee) =>
        employee.employeeId === employeeId ? { ...employee, officeLocationId } : employee,
      ),
    }));
  }

  const loadError = employeesResource.error ?? officesResource.error;
  return (
    <Card
      title="Employees' base offices"
      subtitle={
        withoutOffice > 0
          ? `${withoutOffice} ${withoutOffice === 1 ? 'employee has' : 'employees have'} no office yet, so they cannot apply for leave.`
          : 'Every employee has a base office.'
      }
      bodyClassName="p-0"
      actions={
        <label className="relative block">
          <span className="sr-only">Search employees</span>
          <SearchIcon className="pointer-events-none absolute top-2.5 left-3 h-4 w-4 text-slate-400" />
          <input
            type="search"
            value={searchText}
            onChange={(changeEvent) => setSearchText(changeEvent.target.value)}
            placeholder="Search by name or email"
            className="rounded-xl border-0 py-2 pr-3 pl-9 text-sm ring-1 ring-slate-300 ring-inset focus:ring-2 focus:ring-brand-500"
          />
        </label>
      }
    >
      {(employeesResource.isLoading || officesResource.isLoading) && !employeesResource.data && (
        <LoadingBlock label="Loading employees…" />
      )}
      {loadError && (
        <div className="p-6">
          <Notice tone="error" title={loadError.message} />
        </div>
      )}
      {employeesResource.data && visibleEmployees.length === 0 && (
        <div className="p-6">
          <EmptyState
            Icon={UsersIcon}
            title={query ? 'Nobody matches that search' : 'No employees yet'}
            description={query ? undefined : 'Invite people from Onboarding; they appear here once they join.'}
          />
        </div>
      )}
      {officesResource.data && (
        <ul className="divide-y divide-slate-100">
          {visibleEmployees.map((employee) => (
            <EmployeeOfficeRow
              key={employee.employeeId}
              employee={employee}
              offices={offices}
              onAssigned={handleAssigned}
            />
          ))}
        </ul>
      )}
    </Card>
  );
}
