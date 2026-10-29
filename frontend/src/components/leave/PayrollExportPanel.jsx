/**
 * Leave figures for payroll (HR and admins): each employee's unpaid days in a month and the days
 * encashed with that payroll month, on screen and as a CSV download.
 *
 *   GET /api/leave/payroll-export?month=YYYY-MM[&changedSince=<ISO date-time>]
 *
 * "Changed since" lists only employees whose figures may have changed after a moment (an export
 * already sent to payroll), each with their full figures for the month, so payroll replaces rows
 * rather than adding to them.
 */

import { useState } from 'react';
import { requestLeavePayrollExport } from '../../api/leaveApi.js';
import { formatDays } from '../../constants/leave.js';
import { currentLocalMonth } from '../../utils/dates.js';
import { toDisplayError } from '../../hooks/useApiResource.js';
import { downloadCsv, toCsv } from '../../utils/csv.js';
import { CurrencyIcon, DownloadIcon } from '../Icons.jsx';
import { Button, Card, EmptyState, Notice, TextInput, formatDateTime } from '../ui.jsx';

const CSV_HEADER = Object.freeze(['Employee', 'Email', 'Unpaid days', 'Encashed days', 'Encashment details']);

const describeEncashments = (encashments) =>
  encashments
    .map((encashment) => `${encashment.leaveTypeCode} ${encashment.days} (${encashment.payrollReference})`)
    .join('; ');

export default function PayrollExportPanel() {
  const [month, setMonth] = useState(currentLocalMonth());
  const [changedSince, setChangedSince] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [report, setReport] = useState(null);

  async function loadReport(submitEvent) {
    submitEvent.preventDefault();
    setIsLoading(true);
    setLoadError(null);
    try {
      const changedSinceIso = changedSince ? new Date(changedSince).toISOString() : undefined;
      setReport(await requestLeavePayrollExport({ month, changedSince: changedSinceIso }));
    } catch (exportError) {
      setLoadError(toDisplayError(exportError));
      setReport(null);
    } finally {
      setIsLoading(false);
    }
  }

  function downloadReport() {
    const rows = report.employees.map((employee) => [
      employee.name,
      employee.email,
      employee.unpaidDays,
      employee.encashedDays,
      describeEncashments(employee.encashments),
    ]);
    const suffix = report.changedSince ? '-changes' : '';
    downloadCsv(`leave-payroll-${report.month}${suffix}.csv`, toCsv(CSV_HEADER, rows));
  }

  return (
    <div className="space-y-6">
      <Card title="Payroll export" subtitle="Unpaid leave and encashments for one payroll month.">
        <form onSubmit={loadReport} className="flex flex-wrap items-end gap-4">
          <TextInput
            label="Payroll month"
            type="month"
            value={month}
            onChange={(changeEvent) => setMonth(changeEvent.target.value)}
            error={loadError?.fieldErrors.month}
            required
          />
          <TextInput
            label="Only changes since (optional)"
            type="datetime-local"
            value={changedSince}
            onChange={(changeEvent) => setChangedSince(changeEvent.target.value)}
            error={loadError?.fieldErrors.changedSince}
          />
          <Button type="submit" isBusy={isLoading}>
            Show figures
          </Button>
        </form>
        {loadError && (
          <div className="mt-4">
            <Notice tone="error" title={loadError.message} />
          </div>
        )}
      </Card>

      {report && (
        <Card
          title={`Leave for payroll, ${report.month}`}
          subtitle={
            report.changedSince ? `Changed since ${formatDateTime(report.changedSince)}` : 'Everyone with figures'
          }
          bodyClassName="p-0"
          actions={
            <Button variant="secondary" size="sm" onClick={downloadReport} disabled={report.employees.length === 0}>
              <DownloadIcon className="h-4 w-4" /> Download CSV
            </Button>
          }
        >
          {report.employees.length === 0 ? (
            <div className="p-6">
              <EmptyState Icon={CurrencyIcon} title="Nothing for payroll this month" />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs font-semibold tracking-wide text-slate-500 uppercase">
                  <tr>
                    <th className="px-5 py-2.5 sm:px-6">Employee</th>
                    <th className="px-3 py-2.5 text-right">Unpaid</th>
                    <th className="px-3 py-2.5 text-right">Encashed</th>
                    <th className="px-5 py-2.5 sm:px-6">Encashments</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {report.employees.map((employee) => (
                    <tr key={employee.employeeId}>
                      <td className="px-5 py-2.5 sm:px-6">
                        <p className="font-medium text-slate-900">{employee.name ?? 'Unknown'}</p>
                        <p className="text-xs text-slate-500">{employee.email}</p>
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{formatDays(employee.unpaidDays)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{formatDays(employee.encashedDays)}</td>
                      <td className="px-5 py-2.5 text-slate-600 sm:px-6">
                        {describeEncashments(employee.encashments) || '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
