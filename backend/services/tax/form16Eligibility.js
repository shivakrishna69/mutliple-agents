/**
 * Who the Form 16 portal handles, and which financial years it offers: the single place for both
 * rules, so every list, count, lookup and download applies the same ones.
 *
 *   eligible      annual CTC (EmployeeProfile.compensation.annualCtc) strictly above
 *                 FORM16_SETTINGS.CTC_THRESHOLD; no CTC on record counts as not eligible
 *   years         the current financial year (April to March, in the company's time zone) and the
 *                 ones before it, newest first (FORM16_SETTINGS.FINANCIAL_YEARS_OFFERED)
 *
 * The threshold is applied inside every database query (eligibleProfileFilter()), never by loading
 * employees and filtering them afterwards, so an employee at or below it cannot reach a CA through
 * a list, a count, a search or a lookup by id.
 */

import { FORM16_SETTINGS } from '../../constants/validation.js';
import { financialYearOf } from '../../utils/payroll/finalSettlement.js';

export const FORM16_CTC_THRESHOLD = FORM16_SETTINGS.CTC_THRESHOLD;

/** The EmployeeProfile filter for employees the portal handles (a new object each time: Mongoose casts filters in place). */
export const eligibleProfileFilter = () => ({
  'compensation.annualCtc': { $gt: FORM16_CTC_THRESHOLD },
});

/** True when an annual CTC is above the threshold (null, missing or not a number: false). */
export const isForm16EligibleCtc = (annualCtc) => Number.isFinite(annualCtc) && annualCtc > FORM16_CTC_THRESHOLD;

/** The financial year that starts `offset` years after this one: ("2025-26", 1) → "2026-27". */
export function shiftFinancialYear(financialYear, offset) {
  const startYear = Number(financialYear.slice(0, 4)) + offset;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

/** The assessment year in which a financial year's income is assessed: the year after it. */
export const assessmentYearOf = (financialYear) => shiftFinancialYear(financialYear, 1);

/** Today's calendar date in `timeZone` (an IANA name). */
export function calendarDateIn(timeZone, now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** The financial years the portal offers, newest first: ["2026-27", "2025-26"] during 2026-27. */
export function offeredFinancialYears(timeZone, now = new Date()) {
  const currentYear = financialYearOf(calendarDateIn(timeZone, now));
  return Array.from({ length: FORM16_SETTINGS.FINANCIAL_YEARS_OFFERED }, (unused, index) =>
    shiftFinancialYear(currentYear, -index),
  );
}
