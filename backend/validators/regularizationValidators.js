/**
 * Request validation for attendance regularization. Pure functions, no I/O. Each returns
 * { isValid: true, sanitizedInput } or { isValid: false, validationErrors: [{ field, message }] }.
 *
 *   validateRegularizeRequest          POST /api/attendance/regularize            (employee)
 *   validateReviewDecision             POST /api/attendance/regularization-reviews/:id/decision (reviewer)
 *   validateAgentRegularization        POST /api/internal/attendance/regularizations        (ai-service)
 *   validateAgentReviewSubmission      POST /api/internal/attendance/regularization-reviews  (ai-service)
 *
 * Internal requests come from the ai-service, which is trusted to call but not to be correct: every
 * field is checked here again, and the business rules are enforced in
 * services/attendanceRegularization.js whoever the caller is.
 */

import { REGULARIZATION_MESSAGES } from '../constants/messages.js';
import { ATTENDANCE_FIELD_LIMITS, LOCAL_TIME_PATTERN } from '../constants/validation.js';
import { isRealCalendarDate } from '../models/Attendance.js';
import { REVIEW_ROUTING_REASONS } from '../models/RegularizationReview.js';
import { isValidObjectIdString } from './conversationValidators.js';

/** ISO 8601 date-time with an explicit offset ("Z" or "+05:30"); a local time without one is ambiguous. */
const ZONED_DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const PRINTABLE_TOKEN_PATTERN = /^[\x21-\x7E]+$/;
const REASON_MAX_LENGTH = 300;
const MAX_EVIDENCE_EVENTS = 500;

function isPlainObject(candidateValue) {
  return typeof candidateValue === 'object' && candidateValue !== null && !Array.isArray(candidateValue);
}

function result(validationErrors, sanitizedInput) {
  return validationErrors.length > 0 ? { isValid: false, validationErrors } : { isValid: true, sanitizedInput };
}

function bodyError() {
  return { isValid: false, validationErrors: [{ field: 'body', message: REGULARIZATION_MESSAGES.BODY_MUST_BE_OBJECT }] };
}

/** null/undefined -> null; otherwise a trimmed string of at most `maxLength`, or an error. */
function optionalText(rawValue, maxLength) {
  if (rawValue === undefined || rawValue === null) return { value: null };
  if (typeof rawValue !== 'string') return { error: true };
  const trimmedValue = rawValue.trim().replace(/\s+/g, ' ');
  if (trimmedValue.length > maxLength) return { error: true };
  return { value: trimmedValue.length > 0 ? trimmedValue : null };
}

export function validateRegularizeRequest(requestBody) {
  if (!isPlainObject(requestBody)) return bodyError();
  const validationErrors = [];
  const { message, startNew } = requestBody;

  const trimmedMessage = typeof message === 'string' ? message.trim() : '';
  if (trimmedMessage.length === 0 || trimmedMessage.length > ATTENDANCE_FIELD_LIMITS.REGULARIZATION_MESSAGE_MAX_LENGTH) {
    validationErrors.push({ field: 'message', message: REGULARIZATION_MESSAGES.MESSAGE_INVALID });
  }
  if (startNew !== undefined && typeof startNew !== 'boolean') {
    validationErrors.push({ field: 'startNew', message: REGULARIZATION_MESSAGES.START_NEW_INVALID });
  }
  return result(validationErrors, { message: trimmedMessage, startNew: startNew === true });
}

export const REVIEW_DECISIONS = Object.freeze({ APPROVE: 'approve', REJECT: 'reject' });

export function validateReviewDecision(requestBody) {
  if (!isPlainObject(requestBody)) return bodyError();
  const validationErrors = [];
  const { decision, punchInTime, note } = requestBody;

  if (!Object.values(REVIEW_DECISIONS).includes(decision)) {
    validationErrors.push({ field: 'decision', message: REGULARIZATION_MESSAGES.DECISION_INVALID });
  }
  if (decision === REVIEW_DECISIONS.APPROVE && (typeof punchInTime !== 'string' || !LOCAL_TIME_PATTERN.test(punchInTime))) {
    validationErrors.push({ field: 'punchInTime', message: REGULARIZATION_MESSAGES.PUNCH_IN_TIME_INVALID });
  }
  const noteCheck = optionalText(note, ATTENDANCE_FIELD_LIMITS.REVIEW_NOTE_MAX_LENGTH);
  if (noteCheck.error) validationErrors.push({ field: 'note', message: REGULARIZATION_MESSAGES.NOTE_INVALID });

  return result(validationErrors, {
    decision,
    punchInTime: decision === REVIEW_DECISIONS.APPROVE ? punchInTime : null,
    note: noteCheck.value ?? null,
  });
}

export function validateAgentRegularization(requestBody) {
  if (!isPlainObject(requestBody)) return bodyError();
  const validationErrors = [];
  const { employee_id: employeeId, date, punch_in_time: rawPunchInTime, evidence_event_count: evidenceEventCount, reason, thread_id: threadId } = requestBody;

  if (!isValidObjectIdString(employeeId)) validationErrors.push({ field: 'employee_id', message: REGULARIZATION_MESSAGES.EMPLOYEE_ID_INVALID });
  if (!isRealCalendarDate(date)) validationErrors.push({ field: 'date', message: REGULARIZATION_MESSAGES.DATE_INVALID });

  let punchInTime = null;
  if (typeof rawPunchInTime === 'string' && ZONED_DATE_TIME_PATTERN.test(rawPunchInTime)) {
    punchInTime = new Date(rawPunchInTime);
  }
  if (!punchInTime || Number.isNaN(punchInTime.getTime())) validationErrors.push({ field: 'punch_in_time', message: REGULARIZATION_MESSAGES.ZONED_TIME_INVALID });

  // An automatic regularization is only ever made on evidence, so at least one event is required.
  if (!Number.isInteger(evidenceEventCount) || evidenceEventCount < 1 || evidenceEventCount > MAX_EVIDENCE_EVENTS) {
    validationErrors.push({ field: 'evidence_event_count', message: REGULARIZATION_MESSAGES.EVIDENCE_COUNT_INVALID });
  }
  const reasonCheck = optionalText(reason, REASON_MAX_LENGTH);
  if (reasonCheck.error) validationErrors.push({ field: 'reason', message: REGULARIZATION_MESSAGES.REASON_INVALID });
  if (threadId !== undefined && threadId !== null && (typeof threadId !== 'string' || threadId.length > 200 || !PRINTABLE_TOKEN_PATTERN.test(threadId))) {
    validationErrors.push({ field: 'thread_id', message: REGULARIZATION_MESSAGES.THREAD_ID_INVALID });
  }

  return result(validationErrors, {
    employeeId: typeof employeeId === 'string' ? employeeId.toLowerCase() : employeeId,
    date,
    punchInTime,
    evidenceEventCount,
    reason: reasonCheck.value ?? null,
    threadId: threadId ?? null,
  });
}

export function validateAgentReviewSubmission(requestBody) {
  if (!isPlainObject(requestBody)) return bodyError();
  const validationErrors = [];
  const {
    employee_id: employeeId,
    date,
    claimed_punch_in_time: claimedPunchInTime,
    reason,
    routing_reason: routingReason,
    qualifying_event_count: qualifyingEventCount,
    allowed_geofence_radius: allowedGeofenceRadius,
    idempotency_key: idempotencyKey,
  } = requestBody;

  if (!isValidObjectIdString(employeeId)) validationErrors.push({ field: 'employee_id', message: REGULARIZATION_MESSAGES.EMPLOYEE_ID_INVALID });
  if (date !== null && date !== undefined && !isRealCalendarDate(date)) validationErrors.push({ field: 'date', message: REGULARIZATION_MESSAGES.DATE_INVALID });
  if (claimedPunchInTime !== null && claimedPunchInTime !== undefined && (typeof claimedPunchInTime !== 'string' || !LOCAL_TIME_PATTERN.test(claimedPunchInTime))) {
    validationErrors.push({ field: 'claimed_punch_in_time', message: REGULARIZATION_MESSAGES.PUNCH_IN_TIME_INVALID });
  }
  const reasonCheck = optionalText(reason, REASON_MAX_LENGTH);
  if (reasonCheck.error) validationErrors.push({ field: 'reason', message: REGULARIZATION_MESSAGES.REASON_INVALID });
  if (!REVIEW_ROUTING_REASONS.includes(routingReason)) validationErrors.push({ field: 'routing_reason', message: REGULARIZATION_MESSAGES.ROUTING_REASON_INVALID });
  if (!Number.isInteger(qualifyingEventCount) || qualifyingEventCount < 0 || qualifyingEventCount > MAX_EVIDENCE_EVENTS) {
    validationErrors.push({ field: 'qualifying_event_count', message: REGULARIZATION_MESSAGES.EVIDENCE_COUNT_INVALID });
  }
  if (allowedGeofenceRadius !== null && allowedGeofenceRadius !== undefined && (!Number.isInteger(allowedGeofenceRadius) || allowedGeofenceRadius < 0 || allowedGeofenceRadius > 100_000)) {
    validationErrors.push({ field: 'allowed_geofence_radius', message: REGULARIZATION_MESSAGES.GEOFENCE_RADIUS_INVALID });
  }
  if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0 || idempotencyKey.length > 300 || !PRINTABLE_TOKEN_PATTERN.test(idempotencyKey)) {
    validationErrors.push({ field: 'idempotency_key', message: REGULARIZATION_MESSAGES.IDEMPOTENCY_KEY_INVALID });
  }

  return result(validationErrors, {
    employeeId: typeof employeeId === 'string' ? employeeId.toLowerCase() : employeeId,
    date: date ?? null,
    claimedPunchInTime: claimedPunchInTime ?? null,
    reason: reasonCheck.value ?? null,
    routingReason,
    qualifyingEventCount,
    allowedGeofenceRadius: allowedGeofenceRadius ?? null,
    idempotencyKey,
  });
}
