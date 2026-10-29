/**
 * The employee's own leave requests, newest first, and what they can do with each:
 *
 *   waiting for approval        withdraw it (long leave shows its steps: the manager, then HR)
 *   approved, not started yet   cancel it (the days go straight back)
 *   approved, started           ask to cancel the rest or end it earlier; the approver decides
 *
 *   GET /api/leave/requests · POST …/:id/cancel · POST …/:id/change
 *
 * "Started" is judged by the employee's own today (from their balances), the same day the backend
 * uses; the backend checks again and its message is shown if they disagree.
 */

import { useState } from 'react';
import { requestLeaveCancellation, requestLeaveChange } from '../../api/leaveApi.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import {
  CHANGE_KINDS,
  DAY_PORTIONS,
  END_PORTION_OPTIONS,
  LEAVE_FIELD_LIMITS,
  REQUEST_STATUS_DISPLAY,
  describeApprovalProgress,
  describeLeaveDates,
  formatDays,
} from '../../constants/leave.js';
import { toDisplayError } from '../../hooks/useApiResource.js';
import { formatCalendarDate } from '../../utils/dates.js';
import { CalendarIcon } from '../Icons.jsx';
import { Badge, Button, EmptyState, Notice, SelectInput, TextInput, formatDateTime } from '../ui.jsx';

const ACTIONS = Object.freeze({ CHANGE: 'change' });

function ChangeRequestForm({ request, onSent, onCancel }) {
  const { csrfToken } = useAuth();
  const [form, setForm] = useState({
    kind: CHANGE_KINDS.SHORTEN,
    newEndDate: request.startDate,
    newEndDayPortion: DAY_PORTIONS.FULL,
    reason: '',
  });
  const [isSending, setIsSending] = useState(false);
  const [sendError, setSendError] = useState(null);
  const fieldErrors = sendError?.fieldErrors ?? {};
  const update = (fieldName) => (changeEvent) => setForm({ ...form, [fieldName]: changeEvent.target.value });

  async function handleSubmit(submitEvent) {
    submitEvent.preventDefault();
    setIsSending(true);
    setSendError(null);
    try {
      const changeInput = form.kind === CHANGE_KINDS.CANCEL ? { kind: form.kind, reason: form.reason } : form;
      const { request: changed } = await requestLeaveChange(request.id, changeInput, csrfToken);
      onSent(changed);
    } catch (changeError) {
      setSendError(toDisplayError(changeError));
    } finally {
      setIsSending(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="mt-4 space-y-4 rounded-xl bg-slate-50 p-4 ring-1 ring-slate-200">
      {sendError && <Notice tone="error" title={sendError.message} />}
      <div className="grid gap-4 sm:grid-cols-3">
        <SelectInput
          label="Change"
          value={form.kind}
          onChange={update('kind')}
          options={[
            { value: CHANGE_KINDS.SHORTEN, label: 'End it earlier' },
            { value: CHANGE_KINDS.CANCEL, label: 'Cancel the rest of it' },
          ]}
        />
        {form.kind === CHANGE_KINDS.SHORTEN && (
          <>
            <TextInput
              label="New last day"
              type="date"
              min={request.startDate}
              max={request.endDate}
              value={form.newEndDate}
              onChange={update('newEndDate')}
              error={fieldErrors.newEndDate}
              required
            />
            <SelectInput
              label="On that day"
              value={form.newEndDayPortion}
              onChange={update('newEndDayPortion')}
              options={END_PORTION_OPTIONS}
            />
          </>
        )}
      </div>
      <TextInput
        label="Why"
        value={form.reason}
        onChange={update('reason')}
        error={fieldErrors.reason}
        minLength={LEAVE_FIELD_LIMITS.NOTE_MIN_LENGTH}
        maxLength={LEAVE_FIELD_LIMITS.NOTE_MAX_LENGTH}
        hint="Your approver sees this; days given back return to your balance once approved"
        required
      />
      <div className="flex justify-end gap-3">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Never mind
        </Button>
        <Button type="submit" size="sm" isBusy={isSending}>
          Send for approval
        </Button>
      </div>
    </form>
  );
}

function LeaveRequestRow({ request, today, onChanged }) {
  const { csrfToken } = useAuth();
  const [openAction, setOpenAction] = useState(null);
  const [isCancelling, setIsCancelling] = useState(false);
  const [rowError, setRowError] = useState(null);
  const status = REQUEST_STATUS_DISPLAY[request.status];
  const isPending = request.status === 'PENDING';
  const isApproved = request.status === 'APPROVED';
  const hasStarted = request.startDate <= today;
  const approvalProgress = describeApprovalProgress(request);

  async function cancelRequest() {
    const question = isPending ? 'Withdraw this request?' : 'Cancel this leave? The days go back to your balance.';
    if (!window.confirm(question)) return;
    setIsCancelling(true);
    setRowError(null);
    try {
      const { request: cancelled } = await requestLeaveCancellation(request.id, csrfToken);
      onChanged(cancelled);
    } catch (cancelError) {
      setRowError(toDisplayError(cancelError));
    } finally {
      setIsCancelling(false);
    }
  }

  return (
    <li className="px-5 py-4 sm:px-6">
      <div className="flex flex-wrap items-start gap-4">
        <div className="min-w-48 flex-1">
          <p className="text-sm font-semibold text-slate-900">
            {request.leaveType.name} · {describeLeaveDates(request)}
          </p>
          <p className="mt-0.5 text-xs text-slate-500">
            {formatDays(request.totalDays)} · asked {formatDateTime(request.createdAt)} · “{request.reason}”
          </p>
          {approvalProgress && <p className="mt-1 text-xs font-medium text-indigo-700">{approvalProgress}</p>}
          {request.decision?.note && (
            <p className="mt-1 text-xs text-slate-600">Approver’s note: “{request.decision.note}”</p>
          )}
          {request.pendingChange && (
            <p className="mt-1 text-xs font-medium text-amber-700">
              {request.pendingChange.kind === CHANGE_KINDS.CANCEL
                ? 'You asked to cancel the rest of this leave'
                : `You asked to end it on ${formatCalendarDate(request.pendingChange.newEndDate)}`}
              ; waiting for a decision.
            </p>
          )}
        </div>
        <Badge tone={status.tone}>{status.label}</Badge>
        <div className="flex gap-2">
          {(isPending || (isApproved && !hasStarted)) && (
            <Button variant="secondary" size="sm" isBusy={isCancelling} onClick={cancelRequest}>
              {isPending ? 'Withdraw' : 'Cancel leave'}
            </Button>
          )}
          {isApproved && hasStarted && !request.pendingChange && !openAction && (
            <Button variant="secondary" size="sm" onClick={() => setOpenAction(ACTIONS.CHANGE)}>
              End early or cancel
            </Button>
          )}
        </div>
      </div>
      {openAction === ACTIONS.CHANGE && (
        <ChangeRequestForm
          request={request}
          onSent={(changed) => {
            setOpenAction(null);
            onChanged(changed);
          }}
          onCancel={() => setOpenAction(null)}
        />
      )}
      {rowError && (
        <div className="mt-3">
          <Notice tone="error" title={rowError.message} onDismiss={() => setRowError(null)} />
        </div>
      )}
    </li>
  );
}

/**
 * @param {{ requests: object[], today: string, onChanged: (request: object) => void }} props
 */
export default function MyLeaveRequests({ requests, today, onChanged }) {
  if (requests.length === 0) {
    return (
      <div className="p-6">
        <EmptyState
          Icon={CalendarIcon}
          title="No leave requests yet"
          description="Ask for leave with the button above."
        />
      </div>
    );
  }
  return (
    <ul className="divide-y divide-slate-100">
      {requests.map((request) => (
        <LeaveRequestRow key={request.id} request={request} today={today} onChanged={onChanged} />
      ))}
    </ul>
  );
}
