/**
 * Request validation for leave requests, decisions, change requests and the payroll export. Shapes
 * and formats are checked here; policy (dates allowed, balance, who may act) is applied by
 * services/leaveRequests.js.
 */

import { DAY_PORTIONS } from '../constants/calendarDays.js';
import { CALENDAR_MONTH_PATTERN } from '../constants/validation.js';
import { APPROVAL_QUEUES, CHANGE_REQUEST_KINDS, LEAVE_REQUEST_STATUSES } from '../models/LeaveRequest.js';
import { isRealCalendarDate } from '../utils/calendarDates.js';
import { checkId, checkNote, checkOptionalLeaveYear } from './leaveValidators.js';
import { bodyNotObjectResult, isPlainObject, validationResult } from './requestShape.js';

const START_PORTIONS = Object.freeze([DAY_PORTIONS.FULL, DAY_PORTIONS.SECOND_HALF]);
const END_PORTIONS = Object.freeze([DAY_PORTIONS.FULL, DAY_PORTIONS.FIRST_HALF]);

function checkDate(rawDate, fieldName, validationErrors) {
  if (!isRealCalendarDate(rawDate))
    validationErrors.push({ field: fieldName, message: 'must be a date as YYYY-MM-DD' });
  return rawDate;
}

/** An optional choice from `allowed`, `fallback` when absent. */
function checkChoice(rawValue, fieldName, allowed, validationErrors, fallback) {
  if (rawValue === undefined || rawValue === null) return fallback;
  if (!allowed.includes(rawValue)) {
    validationErrors.push({ field: fieldName, message: `must be one of ${allowed.join(', ')}` });
  }
  return rawValue;
}

/**
 * POST /api/leave/requests and /requests/preview
 * { leaveTypeId, startDate, startDayPortion?: FULL|SECOND_HALF, endDate, endDayPortion?: FULL|FIRST_HALF,
 *   reason (not needed to preview), attachmentDocumentId? }
 */
export function validateLeaveRequestInput(requestBody, { isPreview = false } = {}) {
  if (!isPlainObject(requestBody)) return bodyNotObjectResult();
  const validationErrors = [];
  const startDate = checkDate(requestBody.startDate, 'startDate', validationErrors);
  const endDate = checkDate(requestBody.endDate, 'endDate', validationErrors);
  if (validationErrors.length === 0 && endDate < startDate) {
    validationErrors.push({ field: 'endDate', message: 'cannot be before startDate' });
  }
  const sanitizedInput = {
    leaveTypeId: checkId(requestBody.leaveTypeId, 'leaveTypeId', validationErrors),
    startDate,
    startDayPortion: checkChoice(
      requestBody.startDayPortion,
      'startDayPortion',
      START_PORTIONS,
      validationErrors,
      DAY_PORTIONS.FULL,
    ),
    endDate,
    endDayPortion: checkChoice(
      requestBody.endDayPortion,
      'endDayPortion',
      END_PORTIONS,
      validationErrors,
      DAY_PORTIONS.FULL,
    ),
  };
  if (!isPreview) {
    sanitizedInput.reason = checkNote(requestBody.reason, validationErrors, { required: true, fieldName: 'reason' });
    sanitizedInput.attachmentDocumentId =
      requestBody.attachmentDocumentId === undefined || requestBody.attachmentDocumentId === null
        ? null
        : checkId(requestBody.attachmentDocumentId, 'attachmentDocumentId', validationErrors);
  }
  return validationResult(validationErrors, sanitizedInput);
}

/** POST .../approve { note? } and .../reject { note } (a rejection says why). */
export function validateDecision(requestBody, { noteRequired }) {
  const body = requestBody ?? {};
  if (!isPlainObject(body)) return bodyNotObjectResult();
  const validationErrors = [];
  const note = checkNote(body.note, validationErrors, { required: noteRequired });
  return validationResult(validationErrors, { note });
}

/** POST .../change { kind: CANCEL|SHORTEN, newEndDate (SHORTEN), newEndDayPortion?: FULL|FIRST_HALF, reason } */
export function validateChangeRequest(requestBody) {
  if (!isPlainObject(requestBody)) return bodyNotObjectResult();
  const validationErrors = [];
  const kind = checkChoice(requestBody.kind, 'kind', Object.values(CHANGE_REQUEST_KINDS), validationErrors, null);
  if (kind === null) validationErrors.push({ field: 'kind', message: 'is required' });
  const sanitizedInput = {
    kind,
    newEndDate: null,
    newEndDayPortion: null,
    reason: checkNote(requestBody.reason, validationErrors, { required: true, fieldName: 'reason' }),
  };
  if (kind === CHANGE_REQUEST_KINDS.SHORTEN) {
    sanitizedInput.newEndDate = checkDate(requestBody.newEndDate, 'newEndDate', validationErrors);
    sanitizedInput.newEndDayPortion = checkChoice(
      requestBody.newEndDayPortion,
      'newEndDayPortion',
      END_PORTIONS,
      validationErrors,
      DAY_PORTIONS.FULL,
    );
  }
  return validationResult(validationErrors, sanitizedInput);
}

/** POST .../change/decide { approve: boolean, note? } (a refusal says why) */
export function validateChangeDecision(requestBody) {
  if (!isPlainObject(requestBody)) return bodyNotObjectResult();
  const validationErrors = [];
  const isApproved = requestBody.approve;
  if (typeof isApproved !== 'boolean') validationErrors.push({ field: 'approve', message: 'must be true or false' });
  const note = checkNote(requestBody.note, validationErrors, { required: isApproved === false });
  return validationResult(validationErrors, { isApproved, note });
}

/** GET .../requests?leaveYear=&status= */
export function validateRequestListQuery(query) {
  const validationErrors = [];
  const leaveYear = checkOptionalLeaveYear(query.leaveYear, validationErrors);
  const status = checkChoice(query.status, 'status', Object.values(LEAVE_REQUEST_STATUSES), validationErrors, null);
  return validationResult(validationErrors, { leaveYear, status });
}

/** GET /approvals?queue=requests|changes */
export function validateApprovalQueueQuery(query) {
  const validationErrors = [];
  const queue = checkChoice(
    query.queue,
    'queue',
    Object.values(APPROVAL_QUEUES),
    validationErrors,
    APPROVAL_QUEUES.REQUESTS,
  );
  return validationResult(validationErrors, { queue });
}

/** GET /payroll-export?month=YYYY-MM&changedSince=<ISO date-time> */
export function validatePayrollExportQuery(query) {
  const validationErrors = [];
  const { month } = query;
  if (typeof month !== 'string' || !CALENDAR_MONTH_PATTERN.test(month)) {
    validationErrors.push({ field: 'month', message: 'must be a month as YYYY-MM' });
  }
  let changedSince = null;
  if (query.changedSince !== undefined) {
    changedSince = new Date(query.changedSince);
    if (typeof query.changedSince !== 'string' || Number.isNaN(changedSince.getTime())) {
      validationErrors.push({ field: 'changedSince', message: 'must be a date and time (ISO 8601)' });
    }
  }
  return validationResult(validationErrors, { month, changedSince });
}
