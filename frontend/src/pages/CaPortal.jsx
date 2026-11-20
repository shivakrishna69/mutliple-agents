/**
 * Form 16 / CA Portal (/tax/ca-portal, MANAGE_FORM16: chartered accountants and administrators).
 *
 *   financial year   the years the backend offers (GET /api/tax/years), newest first
 *   KPI cards        eligible (annual CTC above the threshold), uploaded, pending, for the year
 *   filters          name, employee ID or email; uploaded or pending
 *   table            eligible employees only (the backend never returns anyone else), each with
 *                    their Form 16 status; opening one shows the computation and upload dialog
 *
 * Everything comes from GET /api/tax/ca/employees; messages are the backend's.
 */

import { useEffect, useState } from 'react';
import { requestCaEmployees, requestForm16Years } from '../api/taxApi.js';
import PageHeader from '../components/PageHeader.jsx';
import { CheckBadgeIcon, ClockIcon, DocumentIcon, UsersIcon } from '../components/Icons.jsx';
import Form16UploadDialog from '../components/tax/Form16UploadDialog.jsx';
import { Badge, Button, EmptyState, LoadingBlock, Notice, StatTile, formatInr } from '../components/ui.jsx';
import {
  FORM16_CTC_THRESHOLD_LABEL,
  FORM16_LIST_STATUSES,
  FORM16_PART_LABELS,
  FORM16_STATUS_DISPLAY,
} from '../constants/form16.js';
import { useApiResource } from '../hooks/useApiResource.js';

const SEARCH_DELAY_MS = 300;
const STATUS_OPTIONS = Object.freeze([
  { value: '', label: 'All statuses' },
  { value: FORM16_LIST_STATUSES.PENDING, label: FORM16_STATUS_DISPLAY.pending.label },
  { value: FORM16_LIST_STATUSES.UPLOADED, label: FORM16_STATUS_DISPLAY.uploaded.label },
]);
const CONTROL_CLASS =
  'rounded-xl border-0 bg-white px-3.5 py-2.5 text-sm text-slate-900 shadow-sm ring-1 ring-slate-300 ring-inset focus:ring-2 focus:ring-brand-500 focus:outline-none';

/** The search text, applied once typing pauses. */
function useSettledValue(value, delayMs) {
  const [settledValue, setSettledValue] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettledValue(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return settledValue;
}

function EmployeeTable({ employees, onOpen }) {
  return (
    <div className="overflow-x-auto rounded-2xl bg-white shadow-sm ring-1 ring-slate-200 scroll-thin">
      <table className="w-full min-w-[46rem] text-sm" data-testid="ca-employee-table">
        <thead className="bg-slate-50 text-left text-xs font-semibold tracking-wide text-slate-500 uppercase">
          <tr>
            <th className="px-5 py-3">Employee</th>
            <th className="px-5 py-3">Department</th>
            <th className="px-5 py-3 text-right">Annual CTC</th>
            <th className="px-5 py-3">Form 16</th>
            <th className="px-5 py-3">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {employees.map((employee) => {
            const status = FORM16_STATUS_DISPLAY[employee.form16Status];
            return (
              <tr key={employee.employeeId} data-testid="ca-employee-row">
                <td className="px-5 py-3">
                  <p className="font-semibold text-slate-900">{employee.name}</p>
                  <p className="text-xs text-slate-500">
                    {[employee.employeeCode, employee.email].filter(Boolean).join(' · ')}
                  </p>
                </td>
                <td className="px-5 py-3 text-slate-700">
                  {employee.departmentName ?? '—'}
                  {employee.designation && <p className="text-xs text-slate-500">{employee.designation}</p>}
                </td>
                <td className="px-5 py-3 text-right font-medium text-slate-900 tabular-nums">
                  {formatInr(employee.annualCtc)}
                </td>
                <td className="px-5 py-3">
                  <Badge tone={status.tone}>{status.label}</Badge>
                  {employee.documents.map((document) => (
                    <p key={document.id} className="mt-1 text-xs text-slate-500">
                      v{document.version} · {FORM16_PART_LABELS[document.partType]}
                    </p>
                  ))}
                </td>
                <td className="px-5 py-3 text-right">
                  <Button variant="secondary" size="sm" onClick={() => onOpen(employee)}>
                    {employee.form16Status === FORM16_LIST_STATUSES.UPLOADED ? 'Review' : 'Upload'}
                  </Button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function CaPortal() {
  const yearsResource = useApiResource((signal) => requestForm16Years(signal), []);
  const financialYears = yearsResource.data?.financialYears ?? [];
  const [chosenYear, setChosenYear] = useState(null);
  const financialYear = chosenYear ?? financialYears[0] ?? null;
  const [searchText, setSearchText] = useState('');
  const search = useSettledValue(searchText.trim(), SEARCH_DELAY_MS);
  const [status, setStatus] = useState('');
  const [openEmployee, setOpenEmployee] = useState(null);

  const listResource = useApiResource(
    (signal) => requestCaEmployees({ financialYear, search, status }, signal),
    [financialYear, search, status],
    { enabled: Boolean(financialYear) },
  );
  const list = listResource.data;

  return (
    <div className="mx-auto max-w-7xl space-y-6 px-4 py-8 sm:px-8">
      <PageHeader
        title="Form 16 / CA Portal"
        description={`Employees with an annual CTC above ${FORM16_CTC_THRESHOLD_LABEL}: their salary, the tax deducted, and their Form 16.`}
        actions={
          financialYears.length > 0 && (
            <label className="flex items-center gap-2 text-sm font-medium text-slate-600">
              Financial year
              <select
                className={CONTROL_CLASS}
                value={financialYear ?? ''}
                onChange={(changeEvent) => setChosenYear(changeEvent.target.value)}
                data-testid="form16-year"
              >
                {financialYears.map((year) => (
                  <option key={year} value={year}>
                    FY {year}
                  </option>
                ))}
              </select>
            </label>
          )
        }
      />
      {yearsResource.error && <Notice tone="error" title={yearsResource.error.message} />}

      {list && (
        <div className="grid gap-4 sm:grid-cols-3">
          <StatTile
            label={`Eligible > ${FORM16_CTC_THRESHOLD_LABEL}`}
            value={list.summary.eligible}
            hint={`FY ${list.financialYear} · AY ${list.assessmentYear}`}
            Icon={UsersIcon}
            accent="brand"
          />
          <StatTile
            label="Uploaded"
            value={list.summary.uploaded}
            hint="With an active Form 16"
            Icon={CheckBadgeIcon}
            accent="emerald"
          />
          <StatTile
            label="Pending"
            value={list.summary.pending}
            hint="Waiting for their Form 16"
            Icon={ClockIcon}
            accent="amber"
          />
        </div>
      )}

      <div className="flex flex-col gap-3 sm:flex-row">
        <input
          type="search"
          value={searchText}
          onChange={(changeEvent) => setSearchText(changeEvent.target.value)}
          placeholder="Search name, employee ID or email"
          aria-label="Search employees"
          maxLength={100}
          className={`${CONTROL_CLASS} sm:flex-1`}
        />
        <select
          value={status}
          onChange={(changeEvent) => setStatus(changeEvent.target.value)}
          aria-label="Form 16 status"
          className={CONTROL_CLASS}
        >
          {STATUS_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      {listResource.error && <Notice tone="error" title={listResource.error.message} />}
      {listResource.isLoading && !list && <LoadingBlock label="Loading employees…" />}
      {list &&
        (list.employees.length === 0 ? (
          <EmptyState
            title="No employees to show"
            description={`Only employees with an annual CTC above ${FORM16_CTC_THRESHOLD_LABEL} appear here.`}
            Icon={DocumentIcon}
          />
        ) : (
          <>
            <EmployeeTable employees={list.employees} onOpen={setOpenEmployee} />
            {list.truncated && (
              <p className="text-xs text-slate-500">
                Showing {list.employees.length} of {list.matchingCount}. Search to narrow the list.
              </p>
            )}
          </>
        ))}

      {openEmployee && financialYear && (
        <Form16UploadDialog
          employeeId={openEmployee.employeeId}
          employeeName={openEmployee.name}
          financialYear={financialYear}
          onUploaded={listResource.reload}
          onClose={() => setOpenEmployee(null)}
        />
      )}
    </div>
  );
}
