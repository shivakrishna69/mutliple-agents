/**
 * Request validation for the leave endpoints. Settings and leave types are checked for shape only
 * (validators/requestShape.js); their values are validated by models/LeaveSettings.js and
 * models/LeaveType.js. Movements (adjustments, encashments) are checked in full here; balances and
 * policy limits are checked by services/leaveMovements.js.
 */

import { CALENDAR_MONTH_PATTERN, LEAVE_LIMITS } from '../constants/validation.js';
import { ADJUSTMENT_REASON_CODES } from '../models/LeaveLedgerEntry.js';
import { isRealCalendarDate } from '../utils/calendarDates.js';
import { isWholeCentidays } from '../utils/leaveDays.js';
import { isValidObjectIdString } from './conversationValidators.js';
import {
  bodyNotObjectResult,
  checkVersion,
  hasChanges,
  isPlainObject,
  pickShapedFields,
  validationResult,
} from './requestShape.js';

const LIMITS = LEAVE_LIMITS;

const SETTINGS_FIELDS = Object.freeze(['leaveYearStartMonth', 'defaultTimeZone']);
const LEAVE_TYPE_FIELDS = Object.freeze([
  'code',
  'name',
  'description',
  'isPaid',
  'tracksBalance',
  'accrual',
  'accrueDuringNotice',
  'carryForward',
  'encashment',
  'usage',
  'isActive',
]);
const LEAVE_TYPE_GROUPS = Object.freeze({
  accrual: Object.freeze(['method', 'annualQuotaDays', 'timing', 'proRataRoundingStepDays']),
  carryForward: Object.freeze(['maxDays', 'yearEndExcessAction']),
  encashment: Object.freeze(['isEncashable', 'minBalanceRetainedDays']),
  usage: Object.freeze([
    'sandwichRule',
    'allowHalfDay',
    'maxConsecutiveDays',
    'minNoticeDays',
    'maxBackdatedDays',
    'eligibleEmploymentStatuses',
    'minServiceDays',
    'attachmentRequiredAfterDays',
    'allowNegativeBalance',
    'maxNegativeDays',
  ]),
});
/** Adjustments HR may post by hand; the others are posted by the system. */
export const HR_ADJUSTMENT_REASON_CODES = Object.freeze([
  ADJUSTMENT_REASON_CODES.MANUAL,
  ADJUSTMENT_REASON_CODES.ENTITLEMENT_GRANT,
]);

export function checkId(rawId, fieldName, validationErrors) {
  if (!isValidObjectIdString(rawId)) {
    validationErrors.push({ field: fieldName, message: 'must be a valid id' });
    return undefined;
  }
  return rawId.toLowerCase();
}

/** A leave year (number in a body, string in a query); `undefined`/empty means the current one. */
export function checkOptionalLeaveYear(rawLeaveYear, validationErrors) {
  if (rawLeaveYear === undefined || rawLeaveYear === null || rawLeaveYear === '') return null;
  const leaveYear = Number(rawLeaveYear);
  if (!Number.isInteger(leaveYear) || leaveYear < LIMITS.EARLIEST_LEAVE_YEAR || leaveYear > LIMITS.LATEST_LEAVE_YEAR) {
    validationErrors.push({
      field: 'leaveYear',
      message: `must be a leave year from ${LIMITS.EARLIEST_LEAVE_YEAR} to ${LIMITS.LATEST_LEAVE_YEAR}`,
    });
  }
  return leaveYear;
}

/** Days moved by one entry: up to two decimals, not zero, within the single-movement limit. */
function checkMovementDays(rawDays, validationErrors, { mustBePositive }) {
  const isValid =
    isWholeCentidays(rawDays) &&
    rawDays !== 0 &&
    Math.abs(rawDays) <= LIMITS.MAX_SINGLE_MOVEMENT_DAYS &&
    (!mustBePositive || rawDays > 0);
  if (!isValid) {
    const range = mustBePositive ? 'more than 0' : 'not 0';
    validationErrors.push({
      field: 'days',
      message: `must be ${range}, at most ${LIMITS.MAX_SINGLE_MOVEMENT_DAYS} days, with up to two decimals`,
    });
  }
  return rawDays;
}

/** Free text of NOTE_MIN_LENGTH to NOTE_MAX_LENGTH characters (a note, or a reason). */
export function checkNote(rawNote, validationErrors, { required, fieldName = 'note' }) {
  if (!required && (rawNote === undefined || rawNote === null || rawNote === '')) return null;
  const note = typeof rawNote === 'string' ? rawNote.trim() : '';
  if (note.length < LIMITS.NOTE_MIN_LENGTH || note.length > LIMITS.NOTE_MAX_LENGTH) {
    validationErrors.push({
      field: fieldName,
      message: `must be ${LIMITS.NOTE_MIN_LENGTH}-${LIMITS.NOTE_MAX_LENGTH} characters`,
    });
  }
  return note;
}

/** PATCH /api/leave/settings */
export function validateLeaveSettingsChanges(requestBody) {
  if (!isPlainObject(requestBody)) return bodyNotObjectResult();
  const validationErrors = [];
  const changes = pickShapedFields(requestBody, SETTINGS_FIELDS, {}, validationErrors);
  if (!hasChanges(changes)) validationErrors.push({ field: 'body', message: 'nothing to change' });
  const version = checkVersion(requestBody.version, validationErrors);
  return validationResult(validationErrors, { changes, version });
}

/** POST /api/leave/types */
export function validateLeaveTypeCreation(requestBody) {
  if (!isPlainObject(requestBody)) return bodyNotObjectResult();
  const validationErrors = [];
  const fields = pickShapedFields(requestBody, LEAVE_TYPE_FIELDS, LEAVE_TYPE_GROUPS, validationErrors);
  return validationResult(validationErrors, fields);
}

/** PATCH /api/leave/types/:leaveTypeId (the code identifies the type and never changes) */
export function validateLeaveTypeChanges(requestBody) {
  if (!isPlainObject(requestBody)) return bodyNotObjectResult();
  const validationErrors = [];
  const { code, ...changes } = pickShapedFields(requestBody, LEAVE_TYPE_FIELDS, LEAVE_TYPE_GROUPS, validationErrors);
  if (code !== undefined) validationErrors.push({ field: 'code', message: 'cannot be changed' });
  if (!hasChanges(changes)) validationErrors.push({ field: 'body', message: 'nothing to change' });
  const version = checkVersion(requestBody.version, validationErrors);
  return validationResult(validationErrors, { changes, version });
}

/** GET /api/leave/types?includeInactive=true */
export function validateLeaveTypeListQuery(query) {
  const { includeInactive } = query;
  if (includeInactive !== undefined && includeInactive !== 'true' && includeInactive !== 'false') {
    return validationResult([{ field: 'includeInactive', message: 'must be true or false' }]);
  }
  return validationResult([], { includeInactive: includeInactive === 'true' });
}

/** GET .../balances?leaveYear= and .../ledger?leaveYear=&leaveTypeId= */
export function validateLeaveYearQuery(query) {
  const validationErrors = [];
  const leaveYear = checkOptionalLeaveYear(query.leaveYear, validationErrors);
  const leaveTypeId =
    query.leaveTypeId === undefined ? null : checkId(query.leaveTypeId, 'leaveTypeId', validationErrors);
  return validationResult(validationErrors, { leaveYear, leaveTypeId });
}

/**
 * POST /api/leave/adjustments
 * { employeeId, leaveTypeId, leaveYear?, reasonCode: MANUAL | ENTITLEMENT_GRANT, days, note }
 * A grant adds days; a manual adjustment adds (positive) or removes (negative) them.
 */
export function validateAdjustment(requestBody) {
  if (!isPlainObject(requestBody)) return bodyNotObjectResult();
  const validationErrors = [];
  const reasonCode = requestBody.reasonCode;
  if (!HR_ADJUSTMENT_REASON_CODES.includes(reasonCode)) {
    validationErrors.push({ field: 'reasonCode', message: `must be one of ${HR_ADJUSTMENT_REASON_CODES.join(', ')}` });
  }
  const sanitizedInput = {
    employeeId: checkId(requestBody.employeeId, 'employeeId', validationErrors),
    leaveTypeId: checkId(requestBody.leaveTypeId, 'leaveTypeId', validationErrors),
    leaveYear: checkOptionalLeaveYear(requestBody.leaveYear, validationErrors),
    reasonCode,
    days: checkMovementDays(requestBody.days, validationErrors, {
      mustBePositive: reasonCode === ADJUSTMENT_REASON_CODES.ENTITLEMENT_GRANT,
    }),
    note: checkNote(requestBody.note, validationErrors, { required: true }),
  };
  return validationResult(validationErrors, sanitizedInput);
}

/**
 * POST /api/leave/encashments
 * { employeeId, leaveTypeId, days, payrollReference, payrollMonth: "YYYY-MM", note? }
 * Encashes from the employee's current leave year.
 */
export function validateEncashment(requestBody) {
  if (!isPlainObject(requestBody)) return bodyNotObjectResult();
  const validationErrors = [];
  const { payrollReference, payrollMonth } = requestBody;
  if (typeof payrollReference !== 'string' || !LIMITS.PAYROLL_REFERENCE_PATTERN.test(payrollReference)) {
    validationErrors.push({
      field: 'payrollReference',
      message: 'must be 3-64 letters, digits, ".", "_", "/" or "-", starting with a letter or digit',
    });
  }
  if (typeof payrollMonth !== 'string' || !CALENDAR_MONTH_PATTERN.test(payrollMonth)) {
    validationErrors.push({ field: 'payrollMonth', message: 'must be a month as YYYY-MM' });
  }
  const sanitizedInput = {
    employeeId: checkId(requestBody.employeeId, 'employeeId', validationErrors),
    leaveTypeId: checkId(requestBody.leaveTypeId, 'leaveTypeId', validationErrors),
    days: checkMovementDays(requestBody.days, validationErrors, { mustBePositive: true }),
    payrollReference,
    payrollMonth,
    note: checkNote(requestBody.note, validationErrors, { required: false }),
  };
  return validationResult(validationErrors, sanitizedInput);
}

/** POST /api/leave/jobs/accrual { asOfDate?: "YYYY-MM-DD" } (empty body: each employee's today) */
export function validateAccrualJobRun(requestBody) {
  const body = requestBody ?? {};
  if (!isPlainObject(body)) return bodyNotObjectResult();
  const asOfDate = body.asOfDate ?? null;
  if (asOfDate !== null && !isRealCalendarDate(asOfDate)) {
    return validationResult([{ field: 'asOfDate', message: 'must be a date as YYYY-MM-DD' }]);
  }
  return validationResult([], { asOfDate });
}
