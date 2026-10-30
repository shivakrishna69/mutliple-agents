/**
 * What the signed-in person can decide, oldest first: leave requests waiting for approval, and
 * changes to approved leave (cancel the rest, or end it earlier). A reporting manager sees the
 * requests routed to them; HR and administrators see everyone's except their own.
 *
 *   GET /api/leave/approvals?queue=requests|changes
 *   POST …/:id/approve { note?, step } · …/:id/reject { note, step } · …/:id/change/decision { approve, note? }
 *
 * Long leave may need two approvals, the manager's then HR's; each item shows where it stands, and
 * HR sees requests still waiting for the manager too. A decision names the step it is for, so if
 * someone decided that step a moment earlier the backend refuses and the queue reloads.
 *
 * The last approval charges the leave at today's price, so it can differ from the price when it
 * was asked for (a holiday added since, or approved leave next to it under the sandwich rule); if
 * the balance no longer covers it, the backend refuses and says so. Declining always needs a note.
 */

import { useState } from 'react';
import {
  requestApprovalQueue,
  requestLeaveApproval,
  requestLeaveChangeDecision,
  requestLeaveRejection,
} from '../../api/leaveApi.js';
import { ApiError } from '../../api/httpClient.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import {
  APPROVAL_QUEUES,
  CHANGE_KINDS,
  DAY_KIND_LABELS,
  DAY_PORTIONS,
  LEAVE_FIELD_LIMITS,
  STEP_ALREADY_DECIDED_CODE,
  describeApprovalProgress,
  describeLeaveDates,
  formatDays,
} from '../../constants/leave.js';
import { WORKFORCE_ADMIN_ROLES } from '../../constants/routes.js';
import { toDisplayError, useApiResource } from '../../hooks/useApiResource.js';
import { formatCalendarDate } from '../../utils/dates.js';
import { CheckBadgeIcon } from '../Icons.jsx';
import { Badge, Button, Card, EmptyState, LoadingBlock, Notice, Tabs, TextInput, formatDateTime } from '../ui.jsx';

const QUEUE_TABS = Object.freeze([
  { id: APPROVAL_QUEUES.REQUESTS, label: 'Leave requests' },
  { id: APPROVAL_QUEUES.CHANGES, label: 'Changes to leave' },
]);

function describeChange(change) {
  if (change.kind === CHANGE_KINDS.CANCEL) return 'Cancel the rest of this leave';
  const portion = change.newEndDayPortion === DAY_PORTIONS.FIRST_HALF ? ' (morning)' : '';
  return `End it on ${formatCalendarDate(change.newEndDate, { weekday: 'short', day: 'numeric', month: 'short' })}${portion}`;
}

function DayBreakdown({ request }) {
  return (
    <ul className="mt-3 grid gap-1 text-xs text-slate-600 sm:grid-cols-2">
      {request.days.map((day) => (
        <li key={day.date} className="flex justify-between gap-3 rounded-lg bg-slate-50 px-3 py-1.5">
          <span>
            {formatCalendarDate(day.date, { weekday: 'short', day: 'numeric', month: 'short' })} ·{' '}
            {day.holidayName ?? DAY_KIND_LABELS[day.kind]}
          </span>
          <span className="font-medium tabular-nums">
            {day.chargedDays === 0 ? 'free' : formatDays(day.chargedDays)}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The outcome to report: an approval before the last step leaves the request pending. */
function outcomeOf(isApproved, decidedRequest) {
  if (!isApproved) return 'declined';
  return decidedRequest?.status === 'PENDING' ? 'approved; it now needs HR’s approval' : 'approved';
}

function ApprovalItem({ request, queue, onDecided, onOvertaken }) {
  const { csrfToken } = useAuth();
  const [note, setNote] = useState('');
  const [busyDecision, setBusyDecision] = useState(null);
  const [decisionError, setDecisionError] = useState(null);
  const [showsDays, setShowsDays] = useState(false);
  const isChange = queue === APPROVAL_QUEUES.CHANGES;
  const approvalProgress = isChange ? null : describeApprovalProgress(request);

  async function decide(isApproved) {
    setBusyDecision(isApproved ? 'approve' : 'decline');
    setDecisionError(null);
    try {
      const trimmedNote = note.trim() || null;
      const step = request.awaitingLevel;
      let decided = null;
      if (isChange) await requestLeaveChangeDecision(request.id, { isApproved, note: trimmedNote }, csrfToken);
      else if (isApproved) decided = await requestLeaveApproval(request.id, { note: trimmedNote, step }, csrfToken);
      else decided = await requestLeaveRejection(request.id, { note: trimmedNote ?? '', step }, csrfToken);
      onDecided(outcomeOf(isApproved, decided?.request), request);
    } catch (decideError) {
      setBusyDecision(null);
      // The item stays (with its new step) once the queue reloads, so it is left ready to decide.
      if (decideError instanceof ApiError && decideError.code === STEP_ALREADY_DECIDED_CODE) {
        onOvertaken(decideError.message);
        return;
      }
      setDecisionError(toDisplayError(decideError));
    }
  }

  return (
    <li className="px-5 py-4 sm:px-6">
      <div className="flex flex-wrap items-start gap-4">
        <div className="min-w-48 flex-1">
          <p className="text-sm font-semibold text-slate-900">
            {request.employee.name ?? 'Employee'} · {request.leaveType.name}
          </p>
          <p className="mt-0.5 text-sm text-slate-700">
            {describeLeaveDates(request)} · {formatDays(request.totalDays)}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {isChange
              ? `${describeChange(request.pendingChange)} · “${request.pendingChange.reason}” · asked ${formatDateTime(request.pendingChange.requestedAt)}`
              : `“${request.reason}” · asked ${formatDateTime(request.createdAt)}`}
          </p>
          {approvalProgress && <p className="mt-1 text-xs font-medium text-brand-700">{approvalProgress}</p>}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {isChange && <Badge tone="violet">Change</Badge>}
          {request.attachmentDocumentId && <Badge tone="sky">Document attached</Badge>}
          {request.borderCharges.length > 0 && <Badge tone="amber">Sandwich days</Badge>}
        </div>
      </div>
      <button
        type="button"
        onClick={() => setShowsDays(!showsDays)}
        className="mt-2 text-xs font-semibold text-brand-600 hover:text-brand-500"
        aria-expanded={showsDays}
      >
        {showsDays ? 'Hide days' : 'Show each day'}
      </button>
      {showsDays && <DayBreakdown request={request} />}
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <TextInput
          label="Note (needed to decline)"
          value={note}
          onChange={(changeEvent) => setNote(changeEvent.target.value)}
          maxLength={LEAVE_FIELD_LIMITS.NOTE_MAX_LENGTH}
          className="min-w-48 flex-1"
          error={decisionError?.fieldErrors.note}
        />
        <Button
          variant="success"
          size="sm"
          isBusy={busyDecision === 'approve'}
          disabled={busyDecision !== null}
          onClick={() => decide(true)}
        >
          Approve
        </Button>
        <Button
          variant="danger"
          size="sm"
          isBusy={busyDecision === 'decline'}
          disabled={busyDecision !== null || note.trim().length < LEAVE_FIELD_LIMITS.NOTE_MIN_LENGTH}
          onClick={() => decide(false)}
        >
          Decline
        </Button>
      </div>
      {decisionError && (
        <div className="mt-3">
          <Notice tone="error" title={decisionError.message} onDismiss={() => setDecisionError(null)} />
        </div>
      )}
    </li>
  );
}

export default function ApprovalsPanel() {
  const { currentUser } = useAuth();
  const isWorkforceAdmin = WORKFORCE_ADMIN_ROLES.includes(currentUser?.role);
  const [queue, setQueue] = useState(APPROVAL_QUEUES.REQUESTS);
  const [lastDecision, setLastDecision] = useState(null);
  const [overtakenMessage, setOvertakenMessage] = useState(null);
  const queueResource = useApiResource((signal) => requestApprovalQueue(queue, signal), [queue]);
  const requests = queueResource.data?.requests ?? [];

  function handleDecided(outcome, request) {
    const whose = request.employee.name ? `${request.employee.name}’s` : 'The';
    setOvertakenMessage(null);
    setLastDecision(`${whose} ${queue === APPROVAL_QUEUES.CHANGES ? 'change' : 'request'} was ${outcome}`);
    queueResource.setData((data) => ({ ...data, requests: data.requests.filter((item) => item.id !== request.id) }));
  }

  // Someone decided the step first: show where the queue stands now.
  function handleOvertaken(message) {
    setLastDecision(null);
    setOvertakenMessage(message);
    queueResource.reload();
  }

  return (
    <Card
      title="Waiting for your decision"
      subtitle="The last approval charges the leave at today’s price; the employee is emailed when it is decided."
      bodyClassName="p-0"
      actions={<Tabs tabs={QUEUE_TABS} activeTabId={queue} onChange={setQueue} label="Approval queue" />}
    >
      {lastDecision && (
        <div className="px-5 pt-4 sm:px-6">
          <Notice tone="success" title={lastDecision} onDismiss={() => setLastDecision(null)} />
        </div>
      )}
      {overtakenMessage && (
        <div className="px-5 pt-4 sm:px-6">
          <Notice tone="info" title={overtakenMessage} onDismiss={() => setOvertakenMessage(null)} />
        </div>
      )}
      {queueResource.isLoading && !queueResource.data && <LoadingBlock label="Loading…" />}
      {queueResource.error && (
        <div className="p-6">
          <Notice tone="error" title={queueResource.error.message} />
        </div>
      )}
      {queueResource.data && requests.length === 0 && (
        <div className="p-6">
          <EmptyState
            Icon={CheckBadgeIcon}
            title="Nothing waiting"
            description={
              queue === APPROVAL_QUEUES.CHANGES
                ? 'No one has asked to change approved leave.'
                : isWorkforceAdmin
                  ? 'Every employee’s requests appear here, except your own.'
                  : 'Requests from people who report to you appear here.'
            }
          />
        </div>
      )}
      <ul className="divide-y divide-slate-100">
        {requests.map((request) => (
          <ApprovalItem
            key={request.id}
            request={request}
            queue={queue}
            onDecided={handleDecided}
            onOvertaken={handleOvertaken}
          />
        ))}
      </ul>
    </Card>
  );
}
