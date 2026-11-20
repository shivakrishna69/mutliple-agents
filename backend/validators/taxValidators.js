/**
 * Request validation for the Form 16 portal (routes/taxRoutes.js) and the annual CTC editor
 * (PUT /api/employees/:employeeId/compensation). Shapes and ranges only; the models stay the final
 * authority for stored values.
 *
 * Each returns { isValid: true, sanitizedInput } or { isValid: false, validationErrors }.
 */

import { CALENDAR_DATE_PATTERN, EMPLOYEE_COMPENSATION_LIMITS, FORM16_SETTINGS } from '../constants/validation.js';
import { FORM16_PART_TYPES, FORM16_TAX_REGIMES } from '../models/Form16Record.js';
import { FORM16_LIST_STATUSES } from '../services/tax/form16Service.js';
import { isRealCalendarDate } from '../utils/calendarDates.js';
import { bodyNotObjectResult, isPlainObject, validationResult } from './requestShape.js';

const SUMMARY_AMOUNT_FIELDS = Object.freeze([
  'grossSalary',
  'totalDeductions',
  'taxableIncome',
  'totalTaxPayable',
  'tdsDeducted',
]);
const SUMMARY_FIELDS = Object.freeze([...SUMMARY_AMOUNT_FIELDS, 'taxRegime', 'caRemarks']);

/** The financial year asked for (`fy`), which must be one the portal offers; the newest when absent. */
function financialYearFrom(rawYear, offeredYears, validationErrors, field = 'fy') {
  if (rawYear === undefined || rawYear === '') return offeredYears[0];
  if (typeof rawYear !== 'string' || !offeredYears.includes(rawYear)) {
    validationErrors.push({ field, message: `must be one of ${offeredYears.join(', ')}` });
    return null;
  }
  return rawYear;
}

/** GET /api/tax/my-form16?fy= and GET /api/tax/ca/employees/:employeeId?fy= */
export function validateFinancialYearQuery(query, offeredYears) {
  const validationErrors = [];
  const financialYear = financialYearFrom(query.fy, offeredYears, validationErrors);
  return validationResult(validationErrors, { financialYear });
}

/** GET /api/tax/ca/employees?fy=&search=&status= */
export function validateCaListQuery(query, offeredYears) {
  const validationErrors = [];
  const financialYear = financialYearFrom(query.fy, offeredYears, validationErrors);

  let search = null;
  if (query.search !== undefined) {
    if (typeof query.search !== 'string' || query.search.trim().length > FORM16_SETTINGS.SEARCH_MAX_LENGTH) {
      validationErrors.push({
        field: 'search',
        message: `must be at most ${FORM16_SETTINGS.SEARCH_MAX_LENGTH} characters`,
      });
    } else {
      search = query.search.trim() || null;
    }
  }

  let status = null;
  if (query.status !== undefined && query.status !== '') {
    if (!Object.values(FORM16_LIST_STATUSES).includes(query.status)) {
      validationErrors.push({
        field: 'status',
        message: `must be ${Object.values(FORM16_LIST_STATUSES).join(' or ')}`,
      });
    } else {
      status = query.status;
    }
  }
  return validationResult(validationErrors, { financialYear, search, status });
}

/** The optional computation summary: whole or decimal rupees, a regime, and remarks. */
function computationSummaryFrom(rawSummary, validationErrors) {
  if (rawSummary === undefined || rawSummary === '') return {};
  let summary;
  try {
    summary = typeof rawSummary === 'string' ? JSON.parse(rawSummary) : rawSummary;
  } catch {
    validationErrors.push({ field: 'computationSummary', message: 'must be a JSON object' });
    return null;
  }
  if (!isPlainObject(summary)) {
    validationErrors.push({ field: 'computationSummary', message: 'must be a JSON object' });
    return null;
  }

  const sanitized = {};
  for (const field of Object.keys(summary)) {
    if (!SUMMARY_FIELDS.includes(field)) {
      validationErrors.push({ field: `computationSummary.${field}`, message: 'is not a computation summary field' });
    }
  }
  for (const field of SUMMARY_AMOUNT_FIELDS) {
    const amount = summary[field];
    if (amount === undefined || amount === null) continue;
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0 || amount > FORM16_SETTINGS.AMOUNT_MAX) {
      validationErrors.push({
        field: `computationSummary.${field}`,
        message: `must be rupees from 0 to ${FORM16_SETTINGS.AMOUNT_MAX}`,
      });
    } else {
      sanitized[field] = Math.round(amount * 100) / 100;
    }
  }
  if (summary.taxRegime !== undefined && summary.taxRegime !== null) {
    if (!Object.values(FORM16_TAX_REGIMES).includes(summary.taxRegime)) {
      validationErrors.push({
        field: 'computationSummary.taxRegime',
        message: `must be ${Object.values(FORM16_TAX_REGIMES).join(' or ')}`,
      });
    } else {
      sanitized.taxRegime = summary.taxRegime;
    }
  }
  if (summary.caRemarks !== undefined && summary.caRemarks !== null) {
    if (typeof summary.caRemarks !== 'string' || summary.caRemarks.trim().length > FORM16_SETTINGS.REMARKS_MAX_LENGTH) {
      validationErrors.push({
        field: 'computationSummary.caRemarks',
        message: `must be text of at most ${FORM16_SETTINGS.REMARKS_MAX_LENGTH} characters`,
      });
    } else if (summary.caRemarks.trim()) {
      sanitized.caRemarks = summary.caRemarks.trim();
    }
  }
  return sanitized;
}

/**
 * POST /api/tax/ca/employees/:employeeId/form16 (multipart): fields financialYear, partType
 * (CONSOLIDATED when absent) and computationSummary (JSON, optional). The file itself is checked by
 * the controller (present, a PDF).
 */
export function validateForm16Upload(body, offeredYears) {
  const fields = isPlainObject(body) ? body : {};
  const validationErrors = [];
  const financialYear = financialYearFrom(fields.financialYear, offeredYears, validationErrors, 'financialYear');
  const partType =
    fields.partType === undefined || fields.partType === '' ? FORM16_PART_TYPES.CONSOLIDATED : fields.partType;
  if (!Object.values(FORM16_PART_TYPES).includes(partType)) {
    validationErrors.push({
      field: 'partType',
      message: `must be one of ${Object.values(FORM16_PART_TYPES).join(', ')}`,
    });
  }
  const computationSummary = computationSummaryFrom(fields.computationSummary, validationErrors);
  return validationResult(validationErrors, { financialYear, partType, computationSummary });
}

/** PUT /api/employees/:employeeId/compensation : { annualCtc, effectiveFrom? (YYYY-MM-DD or null) } */
export function validateCompensationChange(requestBody) {
  if (!isPlainObject(requestBody)) return bodyNotObjectResult();
  const validationErrors = [];
  const { annualCtc, effectiveFrom = null } = requestBody;
  const { ANNUAL_CTC_MIN, ANNUAL_CTC_MAX } = EMPLOYEE_COMPENSATION_LIMITS;
  if (!Number.isInteger(annualCtc) || annualCtc < ANNUAL_CTC_MIN || annualCtc > ANNUAL_CTC_MAX) {
    validationErrors.push({
      field: 'annualCtc',
      message: `must be whole rupees from ${ANNUAL_CTC_MIN} to ${ANNUAL_CTC_MAX}`,
    });
  }
  const isDate =
    effectiveFrom === null ||
    (typeof effectiveFrom === 'string' &&
      CALENDAR_DATE_PATTERN.test(effectiveFrom) &&
      isRealCalendarDate(effectiveFrom));
  if (!isDate) validationErrors.push({ field: 'effectiveFrom', message: 'must be a date (YYYY-MM-DD) or null' });
  return validationResult(validationErrors, {
    annualCtc,
    effectiveFrom: effectiveFrom === null ? null : new Date(`${effectiveFrom}T00:00:00.000Z`),
  });
}
