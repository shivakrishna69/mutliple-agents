/**
 * The employee's own leave: balances for the current leave year, asking for leave (with its price
 * shown as they choose), and their requests with what they can still do with each.
 *
 *   GET /api/leave/balances · GET /api/leave/types · GET /api/leave/requests
 *
 * Accounts without an employee profile (customers, staff not on the payroll) have no leave; the
 * backend says so and the panel explains it instead of showing an error.
 */

import { useState } from 'react';
import { requestLeaveTypes, requestOwnLeaveBalances, requestOwnLeaveRequests } from '../../api/leaveApi.js';
import { useApiResource } from '../../hooks/useApiResource.js';
import { formatCalendarDate } from '../../utils/dates.js';
import { CalendarIcon, PlusIcon } from '../Icons.jsx';
import { Button, Card, EmptyState, LoadingBlock, Notice } from '../ui.jsx';
import LeaveBalanceCard from './LeaveBalanceCard.jsx';
import LeaveRequestForm from './LeaveRequestForm.jsx';
import MyLeaveRequests from './MyLeaveRequests.jsx';

const HTTP_FORBIDDEN = 403;

export default function MyLeavePanel() {
  const [isAsking, setIsAsking] = useState(false);
  const [lastSent, setLastSent] = useState(null);
  const balancesResource = useApiResource((signal) => requestOwnLeaveBalances(undefined, signal), []);
  const typesResource = useApiResource((signal) => requestLeaveTypes({}, signal), []);
  const requestsResource = useApiResource((signal) => requestOwnLeaveRequests({}, signal), []);
  const balances = balancesResource.data;

  function refresh() {
    balancesResource.reload();
    requestsResource.reload();
  }

  if (balancesResource.error?.status === HTTP_FORBIDDEN) {
    return (
      <EmptyState
        Icon={CalendarIcon}
        title="Leave is for employees"
        description="Your account has no employee record, so there is no leave to show. HR can add you as an employee."
      />
    );
  }
  if (balancesResource.error) return <Notice tone="error" title={balancesResource.error.message} />;
  if (!balances || !typesResource.data) return <LoadingBlock label="Loading your leave…" />;

  const leaveTypes = typesResource.data.leaveTypes;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <p className="text-sm text-slate-500">
          Leave year {formatCalendarDate(balances.leaveYearRange.firstDate)} to{' '}
          {formatCalendarDate(balances.leaveYearRange.lastDate)}
        </p>
        {!isAsking && (
          <Button
            onClick={() => {
              setIsAsking(true);
              setLastSent(null);
            }}
          >
            <PlusIcon className="h-4 w-4" /> Ask for leave
          </Button>
        )}
      </div>

      {lastSent && (
        <Notice tone="success" title="Request sent" onDismiss={() => setLastSent(null)}>
          {lastSent.approverEmployeeId
            ? 'Your manager has been told and will decide it.'
            : 'HR will decide it, because you have no reporting manager.'}
        </Notice>
      )}
      {isAsking && (
        <LeaveRequestForm
          leaveTypes={leaveTypes}
          employeeId={balances.employeeId}
          today={balances.today}
          onSubmitted={(request) => {
            setIsAsking(false);
            setLastSent(request);
            refresh();
          }}
          onCancel={() => setIsAsking(false)}
        />
      )}

      {balances.balances.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {balances.balances.map((balance) => (
            <LeaveBalanceCard key={balance.leaveType.id} balance={balance} />
          ))}
        </div>
      )}

      <Card title="My requests" subtitle="Newest first." bodyClassName="p-0">
        {requestsResource.error && (
          <div className="p-6">
            <Notice tone="error" title={requestsResource.error.message} />
          </div>
        )}
        {requestsResource.data ? (
          <MyLeaveRequests requests={requestsResource.data.requests} today={balances.today} onChanged={refresh} />
        ) : (
          !requestsResource.error && <LoadingBlock label="Loading your requests…" />
        )}
      </Card>
    </div>
  );
}
