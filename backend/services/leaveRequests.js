/**
 * Leave requests: pricing a request before sending it, submitting it, and everything that happens
 * to it afterwards (models/LeaveRequest.js has the life cycle). Permission rules live here too,
 * because they depend on the request: who it belongs to and who approves it.
 *
 * Submission checks, in order, each with a stable error code:
 *   the type is offered (LEAVE_TYPE_INACTIVE) to the employee's status (NOT_ELIGIBLE); they have an
 *   office to price the days with (OFFICE_NOT_ASSIGNED); half days only where allowed
 *   (HALF_DAY_NOT_ALLOWED); the dates are in the current leave year (OUTSIDE_LEAVE_YEAR), on or
 *   after joining (BEFORE_JOINING), no further back than the type allows (TOO_FAR_BACK), with the
 *   notice it needs (NOTICE_TOO_SHORT), after the service it needs (SERVICE_TOO_SHORT); there is
 *   something to take (NOTHING_TO_TAKE), not too much at once (TOO_MANY_CONSECUTIVE_DAYS); a
 *   supporting document when the leave is long enough (ATTACHMENT_REQUIRED), from the employee's
 *   own vault (ATTACHMENT_NOT_FOUND); the days are free (OVERLAPPING_REQUEST) and the balance
 *   covers them (INSUFFICIENT_BALANCE).
 *
 * Submission without transactions: the days are claimed first (a unique index refuses overlap),
 * then the hold is posted (refused if the balance cannot cover it), then the request is saved. A
 * failure undoes the earlier steps; if the server stops in between, the repair job does
 * (services/leaveRequestSettlement.js), which also carries out every later change.
 *
 * Who decides: the employee's reporting manager when submitted (an active one; otherwise the
 * request goes to HR's queue), or any HR user or administrator, never the employee themselves.
 * Only the employee withdraws, cancels or asks for a change to their own leave.
 */

import mongoose from 'mongoose';
import { HTTP_STATUS } from '../constants/httpStatus.js';
import { DAY_PORTIONS } from '../constants/calendarDays.js';
import { LEAVE_MESSAGES } from '../constants/messages.js';
import { LEAVE_LIMITS } from '../constants/validation.js';
import DocumentVault from '../models/DocumentVault.js';
import EmployeeProfile, { EMPLOYMENT_STATUSES } from '../models/EmployeeProfile.js';
import LeaveBalance from '../models/LeaveBalance.js';
import LeaveDayClaim from '../models/LeaveDayClaim.js';
import { LEDGER_ENTRY_TYPES } from '../models/LeaveLedgerEntry.js';
import LeaveRequest, { APPROVAL_QUEUES, CHANGE_REQUEST_KINDS, LEAVE_REQUEST_STATUSES } from '../models/LeaveRequest.js';
import LeaveType from '../models/LeaveType.js';
import User from '../models/User.js';
import { calendarDateOfUtcInstant, daysBetweenCalendarDates } from '../utils/calendarDates.js';
import { centidaysToDays, daysToCentidays } from '../utils/leaveDays.js';
import { isDuplicateKeyError } from '../utils/mongoErrors.js';
import { InsufficientLeaveBalanceError, postCredit, postDebit } from './leaveLedger.js';
import { claimedHalvesOf, priceLeaveRange, priceShortenedRequest } from './leaveRequestPricing.js';
import {
  cancellationCreditPosting,
  completeOperation,
  confirmDebitPosting,
  lockRequest,
  OPERATION_OUTCOMES,
  releaseHoldPosting,
  REQUEST_OPERATIONS,
  requestMovementKey,
} from './leaveRequestSettlement.js';
import { leaveYearForDate, loadEmployeeLeaveContext } from './leaveSettings.js';
import { leaveTypeNotFound, lowestAvailableCentidays } from './leaveTypes.js';
import { ServiceError } from './serviceError.js';
import { isWorkforceAdmin } from './workforceAccess.js';

const { PENDING, APPROVED, REJECTED, CANCELLED } = LEAVE_REQUEST_STATUSES;

const failure = (httpStatus) => (code) => new ServiceError(httpStatus, code, LEAVE_MESSAGES[code]);
const unprocessable = failure(HTTP_STATUS.UNPROCESSABLE_CONTENT);
const conflict = failure(HTTP_STATUS.CONFLICT);
const forbidden = failure(HTTP_STATUS.FORBIDDEN);
const requestNotFound = () => failure(HTTP_STATUS.NOT_FOUND)('REQUEST_NOT_FOUND');

// =================================================================================================
// Summaries
// =================================================================================================

const decisionSummary = (decision) =>
  decision ? { byUserId: decision.byUserId.toString(), note: decision.note ?? null, at: decision.at } : null;

/** Names for the employees on a page of requests, by EmployeeProfile id. */
async function employeeNamesById(employeeIds) {
  const profiles = await EmployeeProfile.find({ _id: { $in: employeeIds } })
    .select('userId')
    .lean();
  const users = await User.find({ _id: { $in: profiles.map((profile) => profile.userId) } })
    .select('name')
    .lean();
  const nameByUserId = new Map(users.map((user) => [user._id.toString(), user.name]));
  return new Map(
    profiles.map((profile) => [profile._id.toString(), nameByUserId.get(profile.userId.toString()) ?? null]),
  );
}

async function leaveTypesById(leaveTypeIds) {
  const leaveTypes = await LeaveType.find({ _id: { $in: leaveTypeIds } })
    .select('code name isPaid')
    .lean();
  return new Map(leaveTypes.map((leaveType) => [leaveType._id.toString(), leaveType]));
}

function toLeaveRequestSummary(request, { namesById, typesById }) {
  const leaveType = typesById.get(request.leaveTypeId.toString());
  return {
    id: request._id.toString(),
    employee: { id: request.employeeId.toString(), name: namesById.get(request.employeeId.toString()) ?? null },
    leaveType: { id: request.leaveTypeId.toString(), code: leaveType?.code ?? null, name: leaveType?.name ?? null },
    leaveYear: request.leaveYear,
    startDate: request.startDate,
    startDayPortion: request.startDayPortion,
    endDate: request.endDate,
    endDayPortion: request.endDayPortion,
    days: request.days.map((day) => ({
      date: day.date,
      kind: day.kind,
      holidayName: day.holidayName ?? null,
      chargedDays: centidaysToDays(day.chargedCentidays),
    })),
    borderCharges: request.borderCharges.map((charge) => ({
      date: charge.date,
      chargedDays: centidaysToDays(charge.chargedCentidays),
      neighbourRequestId: charge.neighbourRequestId.toString(),
    })),
    totalDays: centidaysToDays(request.chargedCentidays),
    reason: request.reason,
    attachmentDocumentId: request.attachmentDocumentId?.toString() ?? null,
    status: request.status,
    approverEmployeeId: request.approverEmployeeId?.toString() ?? null,
    decision: decisionSummary(request.decision),
    cancellation: decisionSummary(request.cancellation),
    pendingChange: request.pendingChange
      ? {
          kind: request.pendingChange.kind,
          newEndDate: request.pendingChange.newEndDate ?? null,
          newEndDayPortion: request.pendingChange.newEndDayPortion ?? null,
          reason: request.pendingChange.reason,
          requestedAt: request.pendingChange.requestedAt,
        }
      : null,
    changeHistory: request.changeHistory.map((change) => ({
      kind: change.kind,
      newEndDate: change.newEndDate ?? null,
      newEndDayPortion: change.newEndDayPortion ?? null,
      reason: change.reason,
      requestedAt: change.requestedAt,
      isApproved: change.isApproved,
      decision: decisionSummary(change.decision),
      creditedDays: centidaysToDays(change.creditedCentidays ?? 0),
    })),
    isBeingUpdated: Boolean(request.processing),
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
    version: request.__v,
  };
}

async function summarize(requests) {
  const namesById = await employeeNamesById([...new Set(requests.map((request) => request.employeeId.toString()))]);
  const typesById = await leaveTypesById([...new Set(requests.map((request) => request.leaveTypeId.toString()))]);
  return requests.map((request) => toLeaveRequestSummary(request, { namesById, typesById }));
}

async function summarizeById(requestId) {
  const [summary] = await summarize([await LeaveRequest.findById(requestId).lean()]);
  return summary;
}

// =================================================================================================
// Evaluating a new request
// =================================================================================================

async function loadOfferedType(leaveTypeId) {
  const leaveType = await LeaveType.findById(leaveTypeId).lean();
  if (!leaveType) throw leaveTypeNotFound();
  if (!leaveType.isActive) throw unprocessable('LEAVE_TYPE_INACTIVE');
  return leaveType;
}

/** The policy checks that need no pricing. */
function assertWithinPolicy({ leaveType, employee, settings, today, currentLeaveYear, range }) {
  const { usage } = leaveType;
  const { employmentStatus, officeLocationId, dateOfJoining } = employee.organizationData;
  if (!usage.eligibleEmploymentStatuses.includes(employmentStatus)) throw unprocessable('NOT_ELIGIBLE');
  if (!officeLocationId) throw unprocessable('OFFICE_NOT_ASSIGNED');
  const isHalfDay = range.startDayPortion !== DAY_PORTIONS.FULL || range.endDayPortion !== DAY_PORTIONS.FULL;
  if (isHalfDay && !usage.allowHalfDay) throw unprocessable('HALF_DAY_NOT_ALLOWED');
  if (
    leaveYearForDate(range.startDate, settings) !== currentLeaveYear ||
    leaveYearForDate(range.endDate, settings) !== currentLeaveYear
  ) {
    throw unprocessable('OUTSIDE_LEAVE_YEAR');
  }
  const joiningDate = calendarDateOfUtcInstant(dateOfJoining);
  if (range.startDate < joiningDate) throw unprocessable('BEFORE_JOINING');
  if (range.startDate < today && daysBetweenCalendarDates(range.startDate, today) > usage.maxBackdatedDays) {
    throw unprocessable('TOO_FAR_BACK');
  }
  if (range.startDate >= today && daysBetweenCalendarDates(today, range.startDate) < usage.minNoticeDays) {
    throw unprocessable('NOTICE_TOO_SHORT');
  }
  if (daysBetweenCalendarDates(joiningDate, range.startDate) < usage.minServiceDays) {
    throw unprocessable('SERVICE_TOO_SHORT');
  }
}

/**
 * Everything submission and preview share: the policy checks and the price.
 * @param {{ employeeId: string, requestId: object, input: { leaveTypeId: string, startDate: string,
 *   startDayPortion: string, endDate: string, endDayPortion: string }, now?: Date }} details
 */
async function evaluateRequest({ employeeId, requestId, input, now }) {
  const context = await loadEmployeeLeaveContext(employeeId, { now });
  const leaveType = await loadOfferedType(input.leaveTypeId);
  const range = {
    startDate: input.startDate,
    startDayPortion: input.startDayPortion,
    endDate: input.endDate,
    endDayPortion: input.endDayPortion,
  };
  assertWithinPolicy({ ...context, leaveType, range });
  const pricing = await priceLeaveRange({
    employeeId: context.employee._id,
    requestId,
    leaveType,
    officeLocationId: context.employee.organizationData.officeLocationId,
    ...range,
  });
  if (pricing.daysCentidays === 0) throw unprocessable('NOTHING_TO_TAKE');
  const { maxConsecutiveDays, attachmentRequiredAfterDays } = leaveType.usage;
  if (maxConsecutiveDays !== null && pricing.daysCentidays > daysToCentidays(maxConsecutiveDays)) {
    throw unprocessable('TOO_MANY_CONSECUTIVE_DAYS');
  }
  const attachmentRequired =
    attachmentRequiredAfterDays !== null && pricing.daysCentidays > daysToCentidays(attachmentRequiredAfterDays);
  return { ...context, leaveType, range, pricing, attachmentRequired };
}

async function availableCentidaysOf({ employeeId, leaveTypeId, leaveYear }) {
  const balance = await LeaveBalance.findOne({ employeeId, leaveTypeId, leaveYear }).lean();
  return balance ? balance.balanceCentidays - balance.heldCentidays : 0;
}

/**
 * What a request would cost, without sending it.
 * @returns {Promise<object>} days, border charges, totals in days, the balance it would draw on
 */
export async function previewLeaveRequest({ employeeId, input, now }) {
  const evaluation = await evaluateRequest({ employeeId, requestId: new mongoose.Types.ObjectId(), input, now });
  const { leaveType, pricing, currentLeaveYear } = evaluation;
  const availableCentidays = leaveType.tracksBalance
    ? await availableCentidaysOf({ employeeId, leaveTypeId: leaveType._id, leaveYear: currentLeaveYear })
    : null;
  return {
    leaveYear: currentLeaveYear,
    days: pricing.days.map((day) => ({ ...day, chargedDays: centidaysToDays(day.chargedCentidays) })),
    borderCharges: pricing.borderCharges.map((charge) => ({
      date: charge.date,
      chargedDays: centidaysToDays(charge.chargedCentidays),
      neighbourRequestId: charge.neighbourRequestId.toString(),
    })),
    totalDays: centidaysToDays(pricing.chargedCentidays),
    tracksBalance: leaveType.tracksBalance,
    availableDays: availableCentidays === null ? null : centidaysToDays(availableCentidays),
    isCoveredByBalance:
      availableCentidays === null ||
      availableCentidays - pricing.chargedCentidays >= lowestAvailableCentidays(leaveType),
    attachmentRequired: evaluation.attachmentRequired,
  };
}

/** The reporting manager while they are still employed; otherwise null (HR's queue). */
async function approverOf(employee) {
  const managerId = employee.organizationData.reportingManagerId;
  if (!managerId) return null;
  const manager = await EmployeeProfile.findById(managerId).select('organizationData.employmentStatus').lean();
  return manager && manager.organizationData.employmentStatus !== EMPLOYMENT_STATUSES.TERMINATED ? manager._id : null;
}

async function assertOwnAttachment({ attachmentDocumentId, employeeId, attachmentRequired }) {
  if (!attachmentDocumentId) {
    if (attachmentRequired) throw unprocessable('ATTACHMENT_REQUIRED');
    return;
  }
  if (!(await DocumentVault.exists({ _id: attachmentDocumentId, employeeId })))
    throw unprocessable('ATTACHMENT_NOT_FOUND');
}

/** Claims the request's half days; refused when another request already has any of them. */
async function claimDays({ employeeId, requestId, range }) {
  const claims = claimedHalvesOf(range).map(({ date, half }) => ({
    employeeId,
    date,
    half,
    leaveRequestId: requestId,
  }));
  try {
    await LeaveDayClaim.insertMany(claims, { ordered: true });
  } catch (claimError) {
    await LeaveDayClaim.deleteMany({ leaveRequestId: requestId });
    if (isDuplicateKeyError(claimError)) throw conflict('OVERLAPPING_REQUEST');
    throw claimError;
  }
}

/**
 * @param {{ employeeId: string, actorUserId: string, input: object, now?: Date }} details
 * @returns {Promise<object>} the saved request's summary
 */
export async function submitLeaveRequest({ employeeId, actorUserId, input, now }) {
  const requestId = new mongoose.Types.ObjectId();
  const evaluation = await evaluateRequest({ employeeId, requestId, input, now });
  const { employee, leaveType, range, pricing, today, currentLeaveYear } = evaluation;
  await assertOwnAttachment({
    attachmentDocumentId: input.attachmentDocumentId,
    employeeId: employee._id,
    attachmentRequired: evaluation.attachmentRequired,
  });
  const approverEmployeeId = await approverOf(employee);
  const holdCentidays = leaveType.tracksBalance ? pricing.chargedCentidays : 0;
  const ledgerFields = {
    employeeId: employee._id,
    leaveTypeId: leaveType._id,
    leaveYear: currentLeaveYear,
    leaveRequestId: requestId,
    effectiveDate: today,
    createdByUserId: actorUserId,
  };

  await claimDays({ employeeId: employee._id, requestId, range });
  if (holdCentidays > 0) {
    try {
      await postDebit(
        {
          ...ledgerFields,
          entryType: LEDGER_ENTRY_TYPES.HOLD,
          balanceDeltaCentidays: 0,
          heldDeltaCentidays: holdCentidays,
          idempotencyKey: requestMovementKey(requestId, 'HOLD'),
        },
        { minimumAvailableCentidays: lowestAvailableCentidays(leaveType) },
      );
    } catch (holdError) {
      await LeaveDayClaim.deleteMany({ leaveRequestId: requestId });
      if (holdError instanceof InsufficientLeaveBalanceError) throw unprocessable('INSUFFICIENT_BALANCE');
      throw holdError;
    }
  }
  try {
    await LeaveRequest.create({
      _id: requestId,
      employeeId: employee._id,
      leaveTypeId: leaveType._id,
      leaveYear: currentLeaveYear,
      officeLocationId: employee.organizationData.officeLocationId,
      ...range,
      days: pricing.days,
      borderCharges: pricing.borderCharges,
      chargedCentidays: pricing.chargedCentidays,
      tracksBalance: leaveType.tracksBalance,
      holdCentidays,
      reason: input.reason,
      attachmentDocumentId: input.attachmentDocumentId ?? null,
      approverEmployeeId,
      submittedByUserId: actorUserId,
    });
  } catch (createError) {
    if (holdCentidays > 0) {
      await postCredit({
        ...ledgerFields,
        entryType: LEDGER_ENTRY_TYPES.RELEASE_HOLD,
        balanceDeltaCentidays: 0,
        heldDeltaCentidays: -holdCentidays,
        idempotencyKey: requestMovementKey(requestId, 'RELEASE'),
      });
    }
    await LeaveDayClaim.deleteMany({ leaveRequestId: requestId });
    throw createError;
  }
  return summarizeById(requestId);
}

// =================================================================================================
// Reading
// =================================================================================================

/**
 * @typedef {{ userId: string, role: string, employeeId: string|null }} LeaveActor
 *   the signed-in user, with their own EmployeeProfile id when they have one
 */

const isOwnRequest = (actor, request) =>
  Boolean(actor.employeeId) && request.employeeId.toString() === actor.employeeId;
const isApproverOf = (actor, request) =>
  Boolean(actor.employeeId) && request.approverEmployeeId?.toString() === actor.employeeId;

/** An employee's requests, newest first. */
export async function listEmployeeLeaveRequests({ employeeId, leaveYear = null, status = null }) {
  const filter = { employeeId };
  if (leaveYear !== null) filter.leaveYear = leaveYear;
  if (status !== null) filter.status = status;
  const requests = await LeaveRequest.find(filter).sort({ startDate: -1 }).limit(LEAVE_LIMITS.MAX_LIST_ROWS).lean();
  return summarize(requests);
}

/**
 * What the actor can decide, oldest first: pending requests, or approved leave with a change
 * waiting. HR and administrators see everyone's (except their own); managers see those routed to them.
 * @param {{ actor: LeaveActor, queue: string }} details
 */
export async function listApprovalQueue({ actor, queue }) {
  const filter =
    queue === APPROVAL_QUEUES.CHANGES ? { status: APPROVED, pendingChange: { $ne: null } } : { status: PENDING };
  if (isWorkforceAdmin(actor.role)) {
    if (actor.employeeId) filter.employeeId = { $ne: new mongoose.Types.ObjectId(actor.employeeId) };
  } else if (actor.employeeId) {
    filter.approverEmployeeId = actor.employeeId;
  } else {
    return [];
  }
  const requests = await LeaveRequest.find(filter).sort({ createdAt: 1 }).limit(LEAVE_LIMITS.MAX_LIST_ROWS).lean();
  return summarize(requests);
}

/** One request, for its employee, its approver, or HR. */
export async function getLeaveRequest({ requestId, actor }) {
  const request = await LeaveRequest.findById(requestId).lean();
  if (!request) throw requestNotFound();
  if (!isOwnRequest(actor, request) && !isApproverOf(actor, request) && !isWorkforceAdmin(actor.role)) {
    // Not found rather than forbidden: other people's requests are not confirmed to exist.
    throw requestNotFound();
  }
  return (await summarize([request]))[0];
}

// =================================================================================================
// Decisions and changes
// =================================================================================================

async function loadRequest(requestId) {
  const request = await LeaveRequest.findById(requestId).lean();
  if (!request) throw requestNotFound();
  return request;
}

function assertCanDecide(actor, request) {
  if (isOwnRequest(actor, request)) throw forbidden('SELF_DECISION');
  if (!isWorkforceAdmin(actor.role) && !isApproverOf(actor, request)) throw forbidden('NOT_APPROVER');
}

function assertOwnRequest(actor, request) {
  if (!isOwnRequest(actor, request)) throw forbidden('NOT_REQUESTER');
}

function assertNotBusy(request) {
  if (request.processing) throw conflict('REQUEST_BUSY');
}

/** Locks, posts and commits; refuses if the request changed since it was read. */
async function runOperation(request, operation) {
  const lockedRequest = await lockRequest(
    { requestId: request._id, status: request.status, version: request.__v },
    operation,
  );
  if (!lockedRequest) throw conflict('REQUEST_BUSY');
  if ((await completeOperation(lockedRequest)) === OPERATION_OUTCOMES.INSUFFICIENT) {
    throw unprocessable('INSUFFICIENT_BALANCE');
  }
  return summarizeById(request._id);
}

const decisionBy = (actor, note, now) => ({ byUserId: actor.userId, note: note ?? null, at: now });

/**
 * Approves a pending request at its price today (holidays may have changed, and approved leave
 * next to it may add border charges), if the balance covers that price.
 */
export async function approveLeaveRequest({ requestId, actor, note = null, now = new Date() }) {
  const request = await loadRequest(requestId);
  assertCanDecide(actor, request);
  assertNotBusy(request);
  if (request.status !== PENDING) throw conflict('REQUEST_NOT_PENDING');
  const leaveType = await LeaveType.findById(request.leaveTypeId).lean();
  const pricing = await priceLeaveRange({
    employeeId: request.employeeId,
    requestId: request._id,
    leaveType,
    officeLocationId: request.officeLocationId,
    startDate: request.startDate,
    startDayPortion: request.startDayPortion,
    endDate: request.endDate,
    endDayPortion: request.endDayPortion,
  });
  const { today } = await loadEmployeeLeaveContext(request.employeeId, { now });
  let posting = null;
  if (request.tracksBalance) {
    posting =
      pricing.chargedCentidays > 0
        ? confirmDebitPosting(request, {
            chargedCentidays: pricing.chargedCentidays,
            minimumAvailableCentidays: lowestAvailableCentidays(leaveType),
            createdByUserId: actor.userId,
          })
        : releaseHoldPosting(request, { effectiveDate: today, createdByUserId: actor.userId });
  }
  return runOperation(request, {
    operation: REQUEST_OPERATIONS.APPROVE,
    posting,
    result: {
      set: {
        status: APPROVED,
        decision: decisionBy(actor, note, now),
        days: pricing.days,
        borderCharges: pricing.borderCharges,
        chargedCentidays: pricing.chargedCentidays,
      },
    },
  });
}

/** Rejects a pending request and frees its days and hold. */
export async function rejectLeaveRequest({ requestId, actor, note, now = new Date() }) {
  const request = await loadRequest(requestId);
  assertCanDecide(actor, request);
  assertNotBusy(request);
  if (request.status !== PENDING) throw conflict('REQUEST_NOT_PENDING');
  const { today } = await loadEmployeeLeaveContext(request.employeeId, { now });
  return runOperation(request, {
    operation: REQUEST_OPERATIONS.REJECT,
    posting: releaseHoldPosting(request, { effectiveDate: today, createdByUserId: actor.userId }),
    result: {
      set: { status: REJECTED, decision: decisionBy(actor, note, now), hasClaimsToRelease: true },
      releasesClaims: true,
    },
  });
}

/**
 * The employee takes back their own request: a pending one is withdrawn; approved leave that has
 * not started is cancelled and its days given back. Once it has started, a change request is needed.
 * @returns {Promise<{ request: object, wasWithdrawn: boolean }>}
 */
export async function cancelLeaveRequest({ requestId, actor, now = new Date() }) {
  const request = await loadRequest(requestId);
  assertOwnRequest(actor, request);
  assertNotBusy(request);
  const { today } = await loadEmployeeLeaveContext(request.employeeId, { now });
  const cancellation = decisionBy(actor, null, now);
  if (request.status === PENDING) {
    const summary = await runOperation(request, {
      operation: REQUEST_OPERATIONS.WITHDRAW,
      posting: releaseHoldPosting(request, { effectiveDate: today, createdByUserId: actor.userId }),
      result: { set: { status: CANCELLED, cancellation, hasClaimsToRelease: true }, releasesClaims: true },
    });
    return { request: summary, wasWithdrawn: true };
  }
  if (request.status !== APPROVED) throw conflict('REQUEST_NOT_APPROVED');
  if (request.pendingChange) throw conflict('CHANGE_ALREADY_OPEN');
  if (today >= request.startDate) throw unprocessable('ALREADY_STARTED');
  const summary = await runOperation(request, {
    operation: REQUEST_OPERATIONS.CANCEL,
    posting: cancellationCreditPosting(request, {
      creditCentidays: request.chargedCentidays,
      movement: ['CANCEL'],
      effectiveDate: today,
      createdByUserId: actor.userId,
    }),
    result: {
      set: { status: CANCELLED, cancellation, hasClaimsToRelease: true },
      releasesClaims: true,
      affectsNeighbours: true,
    },
  });
  return { request: summary, wasWithdrawn: false };
}

/**
 * Once approved leave has started, the employee asks to cancel the rest of it or end it earlier;
 * the approver or HR decides. One change may wait at a time.
 * @param {{ requestId: string, actor: LeaveActor, kind: string, newEndDate: string|null,
 *   newEndDayPortion: string|null, reason: string, now?: Date }} details
 */
export async function requestLeaveChange({
  requestId,
  actor,
  kind,
  newEndDate = null,
  newEndDayPortion = null,
  reason,
  now = new Date(),
}) {
  const request = await loadRequest(requestId);
  assertOwnRequest(actor, request);
  assertNotBusy(request);
  if (request.status !== APPROVED) throw conflict('REQUEST_NOT_APPROVED');
  if (request.pendingChange) throw conflict('CHANGE_ALREADY_OPEN');
  const { today } = await loadEmployeeLeaveContext(request.employeeId, { now });
  if (today < request.startDate) throw unprocessable('NOT_STARTED');
  const pendingChange = { kind, reason, requestedByUserId: actor.userId, requestedAt: now };
  if (kind === CHANGE_REQUEST_KINDS.SHORTEN) {
    const endPortion = newEndDayPortion ?? DAY_PORTIONS.FULL;
    const leaveType = await LeaveType.findById(request.leaveTypeId).select('usage.allowHalfDay').lean();
    const givesDaysBack =
      newEndDate < request.endDate ||
      (newEndDate === request.endDate &&
        request.endDayPortion === DAY_PORTIONS.FULL &&
        endPortion === DAY_PORTIONS.FIRST_HALF);
    if (newEndDate < request.startDate || newEndDate > request.endDate || !givesDaysBack) {
      throw unprocessable('INVALID_SHORTEN');
    }
    if (endPortion !== DAY_PORTIONS.FULL && !leaveType.usage.allowHalfDay) throw unprocessable('HALF_DAY_NOT_ALLOWED');
    // Refuses an end the calculator cannot price (e.g. both halves of a one-day leave).
    await priceShortenedRequest(request, { newEndDate, newEndDayPortion: endPortion, sandwich: false });
    Object.assign(pendingChange, { newEndDate, newEndDayPortion: endPortion });
  }
  const { modifiedCount } = await LeaveRequest.updateOne(
    { _id: request._id, status: APPROVED, __v: request.__v, pendingChange: null, processing: null },
    { $set: { pendingChange }, $inc: { __v: 1 } },
  );
  if (modifiedCount === 0) throw conflict('REQUEST_BUSY');
  return summarizeById(request._id);
}

/**
 * Decides the waiting change. Approving a cancellation gives back what the leave cost; approving a
 * shortening reprices it from its approved days and gives back the difference.
 */
export async function decideLeaveChange({ requestId, actor, isApproved, note = null, now = new Date() }) {
  const request = await loadRequest(requestId);
  assertCanDecide(actor, request);
  assertNotBusy(request);
  if (request.status !== APPROVED || !request.pendingChange) throw conflict('NO_CHANGE_OPEN');
  const change = request.pendingChange;
  const decision = decisionBy(actor, note, now);
  const decidedChange = (creditedCentidays) => ({
    kind: change.kind,
    newEndDate: change.newEndDate ?? null,
    newEndDayPortion: change.newEndDayPortion ?? null,
    reason: change.reason,
    requestedByUserId: change.requestedByUserId,
    requestedAt: change.requestedAt,
    isApproved,
    decision,
    creditedCentidays,
  });
  if (!isApproved) {
    return runOperation(request, {
      operation: REQUEST_OPERATIONS.DECIDE_CHANGE,
      posting: null,
      result: { set: { pendingChange: null }, push: { changeHistory: decidedChange(0) } },
    });
  }
  const { today } = await loadEmployeeLeaveContext(request.employeeId, { now });
  const creditMovement = ['CHANGE', String(request.changeHistory.length)];
  if (change.kind === CHANGE_REQUEST_KINDS.CANCEL) {
    return runOperation(request, {
      operation: REQUEST_OPERATIONS.DECIDE_CHANGE,
      posting: cancellationCreditPosting(request, {
        creditCentidays: request.chargedCentidays,
        movement: creditMovement,
        effectiveDate: today,
        createdByUserId: actor.userId,
      }),
      result: {
        set: { status: CANCELLED, cancellation: decision, pendingChange: null, hasClaimsToRelease: true },
        push: { changeHistory: decidedChange(request.chargedCentidays) },
        releasesClaims: true,
        affectsNeighbours: true,
      },
    });
  }
  const leaveType = await LeaveType.findById(request.leaveTypeId).select('usage.sandwichRule').lean();
  const pricing = await priceShortenedRequest(request, {
    newEndDate: change.newEndDate,
    newEndDayPortion: change.newEndDayPortion,
    sandwich: leaveType.usage.sandwichRule,
  });
  const creditCentidays = Math.max(request.chargedCentidays - pricing.chargedCentidays, 0);
  return runOperation(request, {
    operation: REQUEST_OPERATIONS.DECIDE_CHANGE,
    posting: cancellationCreditPosting(request, {
      creditCentidays,
      movement: creditMovement,
      effectiveDate: today,
      createdByUserId: actor.userId,
    }),
    result: {
      set: {
        endDate: change.newEndDate,
        endDayPortion: change.newEndDayPortion,
        days: pricing.days,
        borderCharges: pricing.borderCharges,
        chargedCentidays: request.chargedCentidays - creditCentidays,
        pendingChange: null,
        hasClaimsToRelease: true,
      },
      push: { changeHistory: decidedChange(creditCentidays) },
      releasesClaims: true,
      affectsNeighbours: true,
    },
  });
}
