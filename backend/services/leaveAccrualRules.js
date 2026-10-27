/**
 * Accrual and year-end rules for one leave type. Pure functions on centidays (see
 * utils/leaveDays.js) and "YYYY-MM-DD" dates; services/leaveAccrualJob.js applies them.
 *
 * Monthly accrual
 *   The annual quota is spread over the twelve months of the leave year so the months add up to
 *   exactly the quota: month n credits floor(quota * n / 12) - floor(quota * (n - 1) / 12). With a
 *   quota of 15 days every month is 1.25; with 10 days the months are 0.83, 0.83, 0.84, ...
 *   START_OF_MONTH credits on the 1st (usable straight away); END_OF_MONTH credits on the last day
 *   (earned through the completed month).
 * Upfront yearly accrual
 *   The whole quota is credited on the first day of the leave year.
 * Joiners
 *   The month (or, for upfront accrual, the leave year) in which someone joins is pro-rated by the
 *   share of its days from the joining date on, rounded to the leave type's step (half a day by
 *   default). With START_OF_MONTH or upfront accrual it is credited on the joining date; with
 *   END_OF_MONTH, at the end of the joining month, like every month of that leave type.
 * Year end
 *   What is available at the end of a leave year carries forward up to the cap; the rest lapses or
 *   is encashed. A negative balance (only possible when a type allows it) carries forward in full,
 *   so the debt is not forgotten.
 */

import { EMPLOYMENT_STATUSES } from '../models/EmployeeProfile.js';
import { ACCRUAL_METHODS, ACCRUAL_TIMINGS, YEAR_END_EXCESS_ACTIONS } from '../models/LeaveType.js';
import { daysBetweenCalendarDates } from '../utils/calendarDates.js';
import { roundCentidaysToStep } from '../utils/leaveDays.js';
import { leaveYearRange, monthRange, monthsOfLeaveYear } from './leaveYear.js';

const MONTHS_PER_YEAR = 12;

const dayCount = (firstDate, lastDate) => daysBetweenCalendarDates(firstDate, lastDate) + 1;
const laterDate = (firstDate, secondDate) => (firstDate > secondDate ? firstDate : secondDate);

/** The scheduled credit for month `monthNumber` (1-12) of the leave year. */
export function scheduledMonthlyCentidays(annualQuotaCentidays, monthNumber) {
  const cumulative = (months) => Math.floor((annualQuotaCentidays * months) / MONTHS_PER_YEAR);
  return cumulative(monthNumber) - cumulative(monthNumber - 1);
}

/** Whether an employee in this employment status accrues the leave type. */
export function isAccruingStatus(employmentStatus, { accrueDuringNotice }) {
  if (employmentStatus === EMPLOYMENT_STATUSES.TERMINATED) return false;
  if (employmentStatus === EMPLOYMENT_STATUSES.NOTICE) return accrueDuringNotice;
  return true;
}

function proRata(amountCentidays, fromDate, firstDate, lastDate, roundingStepCentidays) {
  const share = dayCount(fromDate, lastDate) / dayCount(firstDate, lastDate);
  return roundCentidaysToStep(amountCentidays * share, roundingStepCentidays);
}

/**
 * The accrual credits a leave type owes one employee in one leave year whose credit date is on or
 * before `asOfDate`, in date order.
 * @param {{ policy: { accrualMethod: string, annualQuotaCentidays: number, accrualTiming: string,
 *           proRataRoundingStepCentidays: number }, joiningDate: string, leaveYear: number,
 *           startMonth: number, asOfDate: string }} input
 * @returns {{ accrualPeriod: string, creditDate: string, amountCentidays: number, isProRata: boolean }[]}
 */
export function dueAccrualCredits({ policy, joiningDate, leaveYear, startMonth, asOfDate }) {
  const { accrualMethod, annualQuotaCentidays, accrualTiming, proRataRoundingStepCentidays } = policy;
  if (accrualMethod === ACCRUAL_METHODS.NONE || annualQuotaCentidays <= 0) return [];
  const yearRange = leaveYearRange(leaveYear, startMonth);
  if (joiningDate > yearRange.lastDate) return [];

  if (accrualMethod === ACCRUAL_METHODS.UPFRONT_YEARLY) {
    const creditDate = laterDate(yearRange.firstDate, joiningDate);
    if (creditDate > asOfDate) return [];
    const isProRata = joiningDate > yearRange.firstDate;
    const amountCentidays = isProRata
      ? proRata(
          annualQuotaCentidays,
          joiningDate,
          yearRange.firstDate,
          yearRange.lastDate,
          proRataRoundingStepCentidays,
        )
      : annualQuotaCentidays;
    return amountCentidays > 0
      ? [{ accrualPeriod: creditDate.slice(0, 7), creditDate, amountCentidays, isProRata }]
      : [];
  }

  const credits = [];
  monthsOfLeaveYear(leaveYear, startMonth).forEach((accrualPeriod, monthOffset) => {
    const { firstDate, lastDate } = monthRange(accrualPeriod);
    if (lastDate < joiningDate) return;
    const isProRata = joiningDate > firstDate;
    const scheduledCentidays = scheduledMonthlyCentidays(annualQuotaCentidays, monthOffset + 1);
    const amountCentidays = isProRata
      ? proRata(scheduledCentidays, joiningDate, firstDate, lastDate, proRataRoundingStepCentidays)
      : scheduledCentidays;
    const creditDate = accrualTiming === ACCRUAL_TIMINGS.END_OF_MONTH ? lastDate : laterDate(firstDate, joiningDate);
    if (creditDate <= asOfDate && amountCentidays > 0) {
      credits.push({ accrualPeriod, creditDate, amountCentidays, isProRata });
    }
  });
  return credits;
}

/**
 * How the balance available at the end of a leave year is split.
 * @param {{ availableCentidays: number, carryForwardCapCentidays: number|null, excessAction: string }} input
 *   carryForwardCapCentidays null = no cap
 * @returns {{ carryForwardCentidays: number, lapseCentidays: number, encashCentidays: number }}
 */
export function yearEndMovements({ availableCentidays, carryForwardCapCentidays, excessAction }) {
  if (availableCentidays <= 0) {
    return { carryForwardCentidays: availableCentidays, lapseCentidays: 0, encashCentidays: 0 };
  }
  const carryForwardCentidays =
    carryForwardCapCentidays === null ? availableCentidays : Math.min(availableCentidays, carryForwardCapCentidays);
  const excessCentidays = availableCentidays - carryForwardCentidays;
  return {
    carryForwardCentidays,
    lapseCentidays: excessAction === YEAR_END_EXCESS_ACTIONS.LAPSE ? excessCentidays : 0,
    encashCentidays: excessAction === YEAR_END_EXCESS_ACTIONS.ENCASH ? excessCentidays : 0,
  };
}
