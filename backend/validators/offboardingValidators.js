/**
 * Request validation for offboarding through NSK (routes/nskBotRoutes.js, /offboarding and
 * /artifacts). Amounts are rupees with at most 2 decimals; dates are real YYYY-MM-DD days; ids must
 * be ids; unknown fields are refused.
 */

import { OFFBOARDING_SETTINGS as S } from '../constants/validation.js';
import { OFFBOARDING_STATUSES, SEPARATION_KINDS } from '../models/OffboardingCase.js';
import { isRealCalendarDate } from '../utils/calendarDates.js';
import { readText, refuseUnknownFields } from './agentChatValidators.js';
import { isValidObjectIdString } from './conversationValidators.js';
import { bodyNotObjectResult, isPlainObject, validationResult } from './requestShape.js';

const ADJUSTMENT_FIELDS = Object.freeze([
  'monthlyGross',
  'monthlyBasic',
  'salaryDays',
  'encashableDays',
  'noticeShortfallDays',
  'noticeRecoveryWaived',
  'isFixedTerm',
  'tdsOverride',
  'otherEarnings',
  'otherDeductions',
]);

const isAmount = (value, max) =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= max &&
  Math.abs(Math.round(value * 100) - value * 100) < 1e-6;

function readId(value, field, errors) {
  if (!isValidObjectIdString(value)) {
    errors.push({ field, message: 'must be an id' });
    return null;
  }
  return value.toLowerCase();
}

function readDate(value, field, errors) {
  if (typeof value !== 'string' || !isRealCalendarDate(value)) {
    errors.push({ field, message: 'must be a date as YYYY-MM-DD' });
    return null;
  }
  return value;
}

/** A number of 0..max with at most 2 decimals (`integer`: whole numbers only), or null when absent. */
function readOptionalNumber(value, field, max, errors, { integer = false } = {}) {
  if (value === undefined || value === null) return null;
  if (!isAmount(value, max) || (integer && !Number.isInteger(value))) {
    errors.push({
      field,
      message: `must be ${integer ? 'a whole number' : 'a number with at most 2 decimals'} from 0 to ${max}`,
    });
    return null;
  }
  return value;
}

function readBoolean(value, field, errors) {
  if (value === undefined || value === null) return false;
  if (typeof value !== 'boolean') {
    errors.push({ field, message: 'must be true or false' });
    return false;
  }
  return value;
}

function readLines(value, field, errors, { withTaxable }) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > S.OTHER_LINES_MAX) {
    errors.push({ field, message: `must be a list of at most ${S.OTHER_LINES_MAX} lines` });
    return [];
  }
  return value.map((line, index) => {
    const at = `${field}[${index}]`;
    if (!isPlainObject(line)) {
      errors.push({ field: at, message: 'must be an object' });
      return null;
    }
    const unknown = [];
    refuseUnknownFields(line, withTaxable ? ['label', 'amount', 'taxable'] : ['label', 'amount'], unknown);
    errors.push(...unknown.map((fieldError) => ({ ...fieldError, field: `${at}.${fieldError.field}` })));
    const label = readText(line.label, `${at}.label`, S.OTHER_LINE_LABEL_MAX_LENGTH, errors);
    if (!isAmount(line.amount, S.AMOUNT_MAX)) {
      errors.push({ field: `${at}.amount`, message: `must be an amount from 0 to ${S.AMOUNT_MAX}` });
    }
    const taxable = withTaxable ? line.taxable !== false : true;
    if (withTaxable && line.taxable !== undefined && typeof line.taxable !== 'boolean') {
      errors.push({ field: `${at}.taxable`, message: 'must be true or false' });
    }
    return { label, amount: line.amount, taxable };
  });
}

function readAdjustments(value, errors) {
  const raw = value ?? {};
  if (!isPlainObject(raw)) {
    errors.push({ field: 'adjustments', message: 'must be an object' });
    return {};
  }
  const fieldErrors = [];
  refuseUnknownFields(raw, ADJUSTMENT_FIELDS, fieldErrors);
  const adjustments = {
    monthlyGross: readOptionalNumber(raw.monthlyGross, 'adjustments.monthlyGross', S.AMOUNT_MAX, fieldErrors),
    monthlyBasic: readOptionalNumber(raw.monthlyBasic, 'adjustments.monthlyBasic', S.AMOUNT_MAX, fieldErrors),
    salaryDays: readOptionalNumber(raw.salaryDays, 'adjustments.salaryDays', 31, fieldErrors, { integer: true }),
    encashableDays: readOptionalNumber(
      raw.encashableDays,
      'adjustments.encashableDays',
      S.ENCASHABLE_DAYS_MAX,
      fieldErrors,
    ),
    noticeShortfallDays: readOptionalNumber(
      raw.noticeShortfallDays,
      'adjustments.noticeShortfallDays',
      S.NOTICE_SHORTFALL_DAYS_MAX,
      fieldErrors,
      { integer: true },
    ),
    noticeRecoveryWaived: readBoolean(raw.noticeRecoveryWaived, 'adjustments.noticeRecoveryWaived', fieldErrors),
    isFixedTerm: readBoolean(raw.isFixedTerm, 'adjustments.isFixedTerm', fieldErrors),
    tdsOverride: readOptionalNumber(raw.tdsOverride, 'adjustments.tdsOverride', S.AMOUNT_MAX, fieldErrors),
    otherEarnings: readLines(raw.otherEarnings, 'adjustments.otherEarnings', fieldErrors, { withTaxable: true }),
    otherDeductions: readLines(raw.otherDeductions, 'adjustments.otherDeductions', fieldErrors, { withTaxable: false }),
  };
  // The Basic is part of the gross; one entered without the other is checked against the prefill later.
  if (
    adjustments.monthlyGross !== null &&
    adjustments.monthlyBasic !== null &&
    adjustments.monthlyBasic > adjustments.monthlyGross
  ) {
    fieldErrors.push({ field: 'adjustments.monthlyBasic', message: 'cannot be more than the monthly gross' });
  }
  errors.push(
    ...fieldErrors.map((fieldError) => ({
      ...fieldError,
      field: fieldError.field.startsWith('adjustments') ? fieldError.field : `adjustments.${fieldError.field}`,
    })),
  );
  return adjustments;
}

function readSeparation(value, errors) {
  if (!isPlainObject(value)) {
    errors.push({ field: 'separation', message: 'must be an object' });
    return null;
  }
  const fieldErrors = [];
  refuseUnknownFields(value, ['kind', 'noticeDate', 'lastWorkingDay', 'reason'], fieldErrors);
  if (!Object.values(SEPARATION_KINDS).includes(value.kind)) {
    fieldErrors.push({ field: 'kind', message: `must be one of ${Object.values(SEPARATION_KINDS).join(', ')}` });
  }
  const separation = {
    kind: value.kind,
    noticeDate: readDate(value.noticeDate, 'noticeDate', fieldErrors),
    lastWorkingDay: readDate(value.lastWorkingDay, 'lastWorkingDay', fieldErrors),
    reason: readText(value.reason, 'reason', S.SEPARATION_REASON_MAX_LENGTH, fieldErrors, { optional: true }),
  };
  errors.push(...fieldErrors.map((fieldError) => ({ ...fieldError, field: `separation.${fieldError.field}` })));
  return separation;
}

function readVersion(value, errors, { required }) {
  if (!required && (value === undefined || value === null)) return null;
  if (!Number.isInteger(value) || value < 0) {
    errors.push({ field: 'version', message: 'must be the version you are working from' });
    return null;
  }
  return value;
}

/** POST /offboarding/preview: { employeeId, separation, adjustments?, version? } */
export function validateOffboardingPreview(requestBody) {
  if (!isPlainObject(requestBody)) return bodyNotObjectResult();
  const errors = [];
  refuseUnknownFields(requestBody, ['employeeId', 'separation', 'adjustments', 'version'], errors);
  return validationResult(errors, {
    employeeId: readId(requestBody.employeeId, 'employeeId', errors),
    separation: readSeparation(requestBody.separation, errors),
    adjustments: readAdjustments(requestBody.adjustments, errors),
    version: readVersion(requestBody.version, errors, { required: false }),
  });
}

/** POST /offboarding/execute: { caseId, version } (version: the preview's, for a draft) */
export function validateOffboardingExecute(requestBody) {
  if (!isPlainObject(requestBody)) return bodyNotObjectResult();
  const errors = [];
  refuseUnknownFields(requestBody, ['caseId', 'version'], errors);
  return validationResult(errors, {
    caseId: readId(requestBody.caseId, 'caseId', errors),
    version: readVersion(requestBody.version, errors, { required: true }),
  });
}

/** DELETE /offboarding/cases/:caseId?version=n */
export function validateOffboardingCancel(params, query) {
  const errors = [];
  const version = query.version === undefined ? undefined : Number(query.version);
  return validationResult(errors, {
    caseId: readId(params.caseId, 'caseId', errors),
    version: readVersion(version, errors, { required: true }),
  });
}

/** GET /offboarding/cases?status= */
export function validateCaseListQuery(query) {
  const errors = [];
  refuseUnknownFields(query, ['status'], errors);
  const status = query.status ?? null;
  if (status !== null && !Object.values(OFFBOARDING_STATUSES).includes(status)) {
    errors.push({ field: 'status', message: `must be one of ${Object.values(OFFBOARDING_STATUSES).join(', ')}` });
  }
  return validationResult(errors, { status });
}

/** [{ field, message }] when the route parameter is not an id, otherwise null. */
export const idParamErrors = (params, name) =>
  isValidObjectIdString(params[name]) ? null : [{ field: name, message: 'must be an id' }];
