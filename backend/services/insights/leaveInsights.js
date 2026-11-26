/**
 * Leave approval cards for the daily briefing: one per pending request the viewer may decide (the
 * same queue as the Leave page's approvals: their direct reports at the manager's step, everyone's
 * for HR and administrators; services/leaveRequests.js listApprovalQueue), each with what the decision
 * needs:
 *
 *   the request      dates, days charged, leave type
 *   the balance      days still available in that type after this request (its days are already held)
 *                    and days taken this leave year; types without a balance (Loss of Pay) say so
 *   team overlap     teammates' approved or pending leave over the same dates, as "Naren: 25 Dec –
 *                    30 Dec"; teammates are the people with the same reporting manager as the
 *                    applicant, or the applicant's department when they have no manager
 *   waiting          a request waiting longer than INSIGHT_SETTINGS.LEAVE_URGENT_AFTER_HOURS is urgent
 *
 * Actions: Approve and Decline (the step the request waits on travels with them), and Ask NSK.
 * Every figure is read from the database; nothing is estimated. The LEAVE_DECISIONS queue counts every
 * request and leave change waiting for the viewer, beyond the cards shown.
 */

import { INSIGHT_MESSAGES } from '../../constants/messages.js';
import { INSIGHT_SETTINGS } from '../../constants/validation.js';
import EmployeeProfile, { EMPLOYMENT_STATUSES } from '../../models/EmployeeProfile.js';
import LeaveRequest, { APPROVAL_QUEUES, LEAVE_REQUEST_STATUSES } from '../../models/LeaveRequest.js';
import User from '../../models/User.js';
import { getEmployeeBalances } from '../leaveBalances.js';
import { listApprovalQueue } from '../leaveRequests.js';
import { findOwnEmployeeProfileId, isWorkforceAdmin } from '../workforceAccess.js';
import { INSIGHT_ACTIONS, INSIGHT_KINDS, INSIGHT_QUEUES, INSIGHT_SEVERITIES, dateRange } from './insightFormat.js';

const HOUR_MS = 60 * 60 * 1000;
const OVERLAPPING_STATUSES = Object.freeze([LEAVE_REQUEST_STATUSES.APPROVED, LEAVE_REQUEST_STATUSES.PENDING]);

/** The employee records of the applicant's teammates (same manager, else same department), not the applicant. */
async function teammateIdsOf(applicantId) {
  const applicant = await EmployeeProfile.findById(applicantId)
    .select('organizationData.reportingManagerId organizationData.departmentId')
    .lean();
  if (!applicant) return [];
  const { reportingManagerId, departmentId } = applicant.organizationData ?? {};
  const teamFilter = reportingManagerId
    ? { 'organizationData.reportingManagerId': reportingManagerId }
    : departmentId
      ? { 'organizationData.departmentId': departmentId }
      : null;
  if (!teamFilter) return [];
  const teammates = await EmployeeProfile.find({
    ...teamFilter,
    _id: { $ne: applicant._id },
    'organizationData.employmentStatus': { $ne: EMPLOYMENT_STATUSES.TERMINATED },
  })
    .select('_id')
    .lean();
  return teammates.map((teammate) => teammate._id);
}

/** "Naren: 25 Dec – 30 Dec, Asha: 26 Dec (pending)" and how many more there were. */
async function overlapsOf(request) {
  const teammateIds = await teammateIdsOf(request.employee.id);
  if (teammateIds.length === 0) return { entries: [], more: 0 };
  const overlapping = await LeaveRequest.find({
    employeeId: { $in: teammateIds },
    status: { $in: OVERLAPPING_STATUSES },
    startDate: { $lte: request.endDate },
    endDate: { $gte: request.startDate },
  })
    .select('employeeId startDate endDate status')
    .sort({ startDate: 1 })
    .limit(INSIGHT_SETTINGS.OVERLAPS_MAX + 1)
    .lean();
  const shown = overlapping.slice(0, INSIGHT_SETTINGS.OVERLAPS_MAX);
  const profiles = await EmployeeProfile.find({ _id: { $in: shown.map((entry) => entry.employeeId) } })
    .select('userId')
    .lean();
  const accounts = await User.find({ _id: { $in: profiles.map((profile) => profile.userId) } })
    .select('name')
    .lean();
  const userIdByProfileId = new Map(profiles.map((profile) => [profile._id.toString(), profile.userId.toString()]));
  const nameByUserId = new Map(accounts.map((account) => [account._id.toString(), account.name]));
  const entries = shown.map((entry) =>
    INSIGHT_MESSAGES.overlapEntry(
      nameByUserId.get(userIdByProfileId.get(entry.employeeId.toString())) ?? '—',
      dateRange(entry.startDate, entry.endDate),
      entry.status === LEAVE_REQUEST_STATUSES.PENDING,
    ),
  );
  return { entries, more: Math.max(0, overlapping.length - shown.length) };
}

/**
 * The balance line for the request's type, from the applicant's balances that leave year; null when
 * their leave context cannot be read (the card then leaves the line out rather than guess).
 */
async function balanceLineOf(request, now) {
  let balances;
  try {
    ({ balances } = await getEmployeeBalances({ employeeId: request.employee.id, leaveYear: request.leaveYear, now }));
  } catch {
    return null;
  }
  const balance = balances.find((entry) => entry.leaveType.id === request.leaveType.id);
  if (!balance) return INSIGHT_MESSAGES.LEAVE_NO_BALANCE;
  return INSIGHT_MESSAGES.leaveBalance(balance.availableDays, Math.abs(balance.movements.used ?? 0));
}

function overlapLine({ entries, more }) {
  if (entries.length === 0) return INSIGHT_MESSAGES.LEAVE_NO_OVERLAP;
  const listed = entries.join(', ');
  return INSIGHT_MESSAGES.leaveOverlaps(more > 0 ? `${listed} ${INSIGHT_MESSAGES.leaveMoreOverlaps(more)}` : listed);
}

/**
 * @param {{ id: string, role: string }} viewer
 * @param {{ now: Date }} options
 * @returns {Promise<{ cards: object[], queues: object }>}
 */
export async function buildLeaveInsights(viewer, { now }) {
  const employeeId = await findOwnEmployeeProfileId(viewer.id);
  if (!employeeId && !isWorkforceAdmin(viewer.role)) {
    return { cards: [], queues: { [INSIGHT_QUEUES.LEAVE_DECISIONS]: 0 } };
  }
  const actor = { role: viewer.role, employeeId };
  const [queue, changes] = await Promise.all([
    listApprovalQueue({ actor, queue: APPROVAL_QUEUES.REQUESTS }),
    listApprovalQueue({ actor, queue: APPROVAL_QUEUES.CHANGES }),
  ]);
  const requests = queue.slice(0, INSIGHT_SETTINGS.LEAVE_CARDS_MAX);
  const cards = await Promise.all(
    requests.map(async (request) => {
      const [balanceLine, overlaps] = await Promise.all([balanceLineOf(request, now), overlapsOf(request)]);
      const range = dateRange(request.startDate, request.endDate);
      const typeName = request.leaveType.name ?? request.leaveType.code ?? '';
      const employeeName = request.employee.name ?? '—';
      const waitingHours = Math.floor((now.getTime() - new Date(request.createdAt).getTime()) / HOUR_MS);
      const isUrgent = waitingHours >= INSIGHT_SETTINGS.LEAVE_URGENT_AFTER_HOURS;
      const step = request.awaitingLevel;
      return {
        id: `${INSIGHT_KINDS.LEAVE_APPROVAL}:${request.id}`,
        kind: INSIGHT_KINDS.LEAVE_APPROVAL,
        severity: isUrgent ? INSIGHT_SEVERITIES.URGENT : INSIGHT_SEVERITIES.HIGH,
        label: INSIGHT_MESSAGES.LABELS.LEAVE_APPROVAL,
        title: INSIGHT_MESSAGES.leaveTitle(employeeName),
        body: INSIGHT_MESSAGES.leaveWhat(range, request.totalDays, typeName),
        facts: [
          ...(balanceLine ? [balanceLine] : []),
          overlapLine(overlaps),
          ...(isUrgent ? [INSIGHT_MESSAGES.leaveWaiting(waitingHours)] : []),
        ],
        actions: [
          // step: the approval step it waits on (null for requests from before steps existed).
          { kind: INSIGHT_ACTIONS.APPROVE_LEAVE, label: INSIGHT_MESSAGES.ACTIONS.APPROVE, requestId: request.id, step },
          { kind: INSIGHT_ACTIONS.DECLINE_LEAVE, label: INSIGHT_MESSAGES.ACTIONS.DECLINE, requestId: request.id, step },
          {
            kind: INSIGHT_ACTIONS.ASK_NSK,
            label: INSIGHT_MESSAGES.ACTIONS.ASK_NSK,
            prompt: INSIGHT_MESSAGES.leaveAskNsk(employeeName, typeName, range),
          },
        ],
        at: request.createdAt,
      };
    }),
  );
  return { cards, queues: { [INSIGHT_QUEUES.LEAVE_DECISIONS]: queue.length + changes.length } };
}
