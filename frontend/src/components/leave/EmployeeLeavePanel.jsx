/**
 * One employee's leave as HR sees it: each balance with where its days came from, the full ledger,
 * and HR's movements.
 *
 *   GET /api/employees · GET /api/leave/employees/:id/balances?leaveYear= · …/ledger?leaveYear=
 *   POST /api/leave/adjustments   add or remove days (MANUAL), or grant an entitlement
 *   POST /api/leave/encashments   pay days out through payroll, for encashable types
 *
 * The backend refuses HR changes to their own balance, removals below what the policy allows,
 * and encashments that leave less than the type keeps; its messages are shown as they come.
 */

import { useState } from 'react';
import {
  requestEmployeeLeaveBalances,
  requestEmployeeLeaveLedger,
  requestLeaveAdjustment,
  requestLeaveEncashment,
  requestLeaveTypes,
} from '../../api/leaveApi.js';
import { requestEmployees } from '../../api/workplaceApi.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import {
  HR_ADJUSTMENT_REASON_OPTIONS,
  LEAVE_FIELD_LIMITS,
  describeLedgerEntry,
  formatSignedDays,
} from '../../constants/leave.js';
import { currentLocalMonth, formatCalendarDate } from '../../utils/dates.js';
import { toDisplayError, useApiResource } from '../../hooks/useApiResource.js';
import { UsersIcon } from '../Icons.jsx';
import { Button, Card, EmptyState, LoadingBlock, Notice, SelectInput, TextInput } from '../ui.jsx';
import LeaveBalanceCard from './LeaveBalanceCard.jsx';

const MOVEMENT_FORMS = Object.freeze({ ADJUST: 'adjust', ENCASH: 'encash' });
const movementDaysProps = {
  type: 'number',
  step: '0.01',
  max: String(LEAVE_FIELD_LIMITS.MAX_SINGLE_MOVEMENT_DAYS),
};
const noteProps = { minLength: LEAVE_FIELD_LIMITS.NOTE_MIN_LENGTH, maxLength: LEAVE_FIELD_LIMITS.NOTE_MAX_LENGTH };

function MovementForm({
  kind,
  employeeId,
  balanceTypes,
  encashableTypeIds,
  leaveYear,
  currentLeaveYear,
  onPosted,
  onCancel,
}) {
  const { csrfToken } = useAuth();
  const isEncashment = kind === MOVEMENT_FORMS.ENCASH;
  const typeOptions = balanceTypes
    .filter((leaveType) => !isEncashment || encashableTypeIds.has(leaveType.id))
    .map((leaveType) => ({ value: leaveType.id, label: `${leaveType.code} · ${leaveType.name}` }));
  const [form, setForm] = useState({
    leaveTypeId: typeOptions[0]?.value ?? '',
    reasonCode: HR_ADJUSTMENT_REASON_OPTIONS[0].value,
    days: '',
    note: '',
    payrollReference: '',
    payrollMonth: currentLocalMonth(),
  });
  const [isPosting, setIsPosting] = useState(false);
  const [postError, setPostError] = useState(null);
  const fieldErrors = postError?.fieldErrors ?? {};
  const update = (fieldName) => (changeEvent) => setForm({ ...form, [fieldName]: changeEvent.target.value });

  async function handleSubmit(submitEvent) {
    submitEvent.preventDefault();
    setIsPosting(true);
    setPostError(null);
    try {
      const shared = { employeeId, leaveTypeId: form.leaveTypeId, days: Number(form.days) };
      if (isEncashment) {
        await requestLeaveEncashment(
          {
            ...shared,
            payrollReference: form.payrollReference,
            payrollMonth: form.payrollMonth,
            note: form.note || null,
          },
          csrfToken,
        );
      } else {
        await requestLeaveAdjustment({ ...shared, leaveYear, reasonCode: form.reasonCode, note: form.note }, csrfToken);
      }
      onPosted(isEncashment ? 'Encashment recorded' : 'Balance adjusted');
    } catch (movementError) {
      setPostError(toDisplayError(movementError));
    } finally {
      setIsPosting(false);
    }
  }

  if (typeOptions.length === 0) {
    return (
      <Notice tone="info" title="No leave type here can be encashed" onDismiss={onCancel}>
        Turn on encashment for a type under Policies first.
      </Notice>
    );
  }
  return (
    <Card
      title={isEncashment ? 'Encash days' : 'Adjust the balance'}
      subtitle={
        isEncashment
          ? 'From the current leave year; payroll pays the days with the reference you give.'
          : leaveYear === currentLeaveYear
            ? 'In the current leave year.'
            : `In leave year ${leaveYear}, which is open until its year end is processed.`
      }
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {postError && <Notice tone="error" title={postError.message} />}
        <div className="grid gap-4 sm:grid-cols-3">
          <SelectInput
            label="Leave type"
            value={form.leaveTypeId}
            onChange={update('leaveTypeId')}
            error={fieldErrors.leaveTypeId}
            options={typeOptions}
          />
          {!isEncashment && (
            <SelectInput
              label="Kind"
              value={form.reasonCode}
              onChange={update('reasonCode')}
              error={fieldErrors.reasonCode}
              options={HR_ADJUSTMENT_REASON_OPTIONS}
            />
          )}
          <TextInput
            label="Days"
            {...movementDaysProps}
            min={isEncashment || form.reasonCode === 'ENTITLEMENT_GRANT' ? '0.01' : undefined}
            value={form.days}
            onChange={update('days')}
            error={fieldErrors.days}
            hint={isEncashment || form.reasonCode === 'ENTITLEMENT_GRANT' ? undefined : 'Negative to remove days'}
            required
          />
          {isEncashment && (
            <>
              <TextInput
                label="Payroll reference"
                value={form.payrollReference}
                onChange={update('payrollReference')}
                error={fieldErrors.payrollReference}
                placeholder="PAY-2026-11-0042"
                required
              />
              <TextInput
                label="Payroll month"
                type="month"
                value={form.payrollMonth}
                onChange={update('payrollMonth')}
                error={fieldErrors.payrollMonth}
                required
              />
            </>
          )}
        </div>
        <TextInput
          label={isEncashment ? 'Note (optional)' : 'Note'}
          {...noteProps}
          value={form.note}
          onChange={update('note')}
          error={fieldErrors.note}
          hint="Kept in the employee's leave history"
          required={!isEncashment}
        />
        <div className="flex justify-end gap-3">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" isBusy={isPosting}>
            {isEncashment ? 'Record encashment' : 'Post adjustment'}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function LedgerTable({ entries, typeCodeById }) {
  if (entries.length === 0) {
    return <p className="px-5 py-6 text-sm text-slate-500 sm:px-6">Nothing recorded in this leave year yet.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead className="bg-slate-50 text-left text-xs font-semibold tracking-wide text-slate-500 uppercase">
          <tr>
            <th className="px-5 py-2.5 sm:px-6">Date</th>
            <th className="px-3 py-2.5">Type</th>
            <th className="px-3 py-2.5">Movement</th>
            <th className="px-3 py-2.5 text-right">Balance</th>
            <th className="px-3 py-2.5 text-right">Held</th>
            <th className="px-5 py-2.5 sm:px-6">Note</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {entries.map((entry) => (
            <tr key={entry.id}>
              <td className="px-5 py-2.5 whitespace-nowrap text-slate-600 sm:px-6">
                {formatCalendarDate(entry.effectiveDate)}
              </td>
              <td className="px-3 py-2.5 font-medium text-slate-800">{typeCodeById.get(entry.leaveTypeId) ?? '—'}</td>
              <td className="px-3 py-2.5 text-slate-700">
                {describeLedgerEntry(entry)}
                {entry.payrollReference && <span className="text-slate-400"> · {entry.payrollReference}</span>}
              </td>
              <td className="px-3 py-2.5 text-right font-medium tabular-nums">{formatSignedDays(entry.days)}</td>
              <td className="px-3 py-2.5 text-right text-slate-500 tabular-nums">{formatSignedDays(entry.heldDays)}</td>
              <td className="max-w-xs truncate px-5 py-2.5 text-slate-500 sm:px-6" title={entry.note ?? ''}>
                {entry.note ?? (entry.postedBySystem ? 'Automatic' : '')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EmployeeLeave({ employeeId }) {
  const [leaveYear, setLeaveYear] = useState(null);
  const [openForm, setOpenForm] = useState(null);
  const [lastPosted, setLastPosted] = useState(null);
  const balancesResource = useApiResource(
    (signal) => requestEmployeeLeaveBalances({ employeeId, leaveYear }, signal),
    [employeeId, leaveYear],
  );
  const ledgerResource = useApiResource(
    (signal) => requestEmployeeLeaveLedger({ employeeId, leaveYear }, signal),
    [employeeId, leaveYear],
  );
  const typesResource = useApiResource((signal) => requestLeaveTypes({ includeInactive: true }, signal), []);
  const balances = balancesResource.data;
  const allTypes = typesResource.data?.leaveTypes ?? [];
  const typeCodeById = new Map(allTypes.map((leaveType) => [leaveType.id, leaveType.code]));
  const encashableTypeIds = new Set(
    allTypes.filter((leaveType) => leaveType.encashment.isEncashable).map((leaveType) => leaveType.id),
  );

  function handlePosted(message) {
    setOpenForm(null);
    setLastPosted(message);
    balancesResource.reload();
    ledgerResource.reload();
  }

  if (balancesResource.error) return <Notice tone="error" title={balancesResource.error.message} />;
  if (!balances) return <LoadingBlock label="Loading balances…" />;
  const shownYear = balances.leaveYear;
  const yearOptions = [balances.currentLeaveYear, balances.currentLeaveYear - 1].map((year) => ({
    value: String(year),
    // Named by the year it starts in; the hint below gives the exact dates.
    label: `${year}${year === balances.currentLeaveYear ? ' (current)' : ''}`,
  }));
  const balanceTypes = balances.balances.map((balance) => balance.leaveType);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <SelectInput
          label="Leave year"
          value={String(shownYear)}
          onChange={(changeEvent) => setLeaveYear(Number(changeEvent.target.value))}
          options={yearOptions}
          hint={`${formatCalendarDate(balances.leaveYearRange.firstDate)} to ${formatCalendarDate(balances.leaveYearRange.lastDate)}`}
        />
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => setOpenForm(MOVEMENT_FORMS.ADJUST)} disabled={Boolean(openForm)}>
            Adjust balance
          </Button>
          {shownYear === balances.currentLeaveYear && (
            <Button variant="secondary" onClick={() => setOpenForm(MOVEMENT_FORMS.ENCASH)} disabled={Boolean(openForm)}>
              Encash days
            </Button>
          )}
        </div>
      </div>
      {lastPosted && <Notice tone="success" title={lastPosted} onDismiss={() => setLastPosted(null)} />}
      {openForm && (
        <MovementForm
          key={openForm}
          kind={openForm}
          employeeId={employeeId}
          balanceTypes={balanceTypes}
          encashableTypeIds={encashableTypeIds}
          leaveYear={shownYear}
          currentLeaveYear={balances.currentLeaveYear}
          onPosted={handlePosted}
          onCancel={() => setOpenForm(null)}
        />
      )}
      {balances.balances.length === 0 ? (
        <EmptyState title="No leave type keeps a balance" />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {balances.balances.map((balance) => (
            <LeaveBalanceCard key={balance.leaveType.id} balance={balance} />
          ))}
        </div>
      )}
      <Card
        title="Leave history"
        subtitle="Every movement, oldest first. Nothing here is ever edited."
        bodyClassName="p-0"
      >
        {ledgerResource.error && (
          <div className="p-6">
            <Notice tone="error" title={ledgerResource.error.message} />
          </div>
        )}
        {ledgerResource.data ? (
          <LedgerTable entries={ledgerResource.data.entries} typeCodeById={typeCodeById} />
        ) : (
          !ledgerResource.error && <LoadingBlock label="Loading history…" />
        )}
      </Card>
    </div>
  );
}

export default function EmployeeLeavePanel() {
  const employeesResource = useApiResource((signal) => requestEmployees(signal), []);
  const [employeeId, setEmployeeId] = useState('');
  const employees = employeesResource.data?.employees ?? [];

  return (
    <div className="space-y-6">
      <Card title="Employee" subtitle="Choose whose leave to look at.">
        {employeesResource.error && <Notice tone="error" title={employeesResource.error.message} />}
        {employeesResource.isLoading && !employeesResource.data && <LoadingBlock label="Loading employees…" />}
        {employeesResource.data && (
          <SelectInput
            label="Employee"
            value={employeeId}
            onChange={(changeEvent) => setEmployeeId(changeEvent.target.value)}
            options={[
              { value: '', label: 'Choose an employee' },
              ...employees.map((employee) => ({
                value: employee.employeeId,
                label: `${employee.name} · ${employee.designation}`,
              })),
            ]}
          />
        )}
      </Card>
      {employeeId ? (
        <EmployeeLeave key={employeeId} employeeId={employeeId} />
      ) : (
        <EmptyState Icon={UsersIcon} title="No employee chosen" description="Their balances and history appear here." />
      )}
    </div>
  );
}
