/**
 * Leave years. A leave year starts on the 1st of the company's start month (LeaveSettings,
 * April for an Indian financial year) and is named by the calendar year it starts in: with an April
 * start, leave year 2026 runs from 2026-04-01 to 2027-03-31. Pure functions on "YYYY-MM-DD" dates.
 */

import { addDaysToCalendarDate } from '../utils/calendarDates.js';

const MONTHS_PER_YEAR = 12;

const pad2 = (value) => String(value).padStart(2, '0');

/** The leave year a date falls in. */
export function leaveYearOfDate(calendarDate, startMonth) {
  const year = Number(calendarDate.slice(0, 4));
  const month = Number(calendarDate.slice(5, 7));
  return month >= startMonth ? year : year - 1;
}

/** First and last date of a leave year. */
export function leaveYearRange(leaveYear, startMonth) {
  const firstDate = `${leaveYear}-${pad2(startMonth)}-01`;
  const nextYearFirstDate = `${leaveYear + 1}-${pad2(startMonth)}-01`;
  return { firstDate, lastDate: addDaysToCalendarDate(nextYearFirstDate, -1) };
}

/** The twelve months of a leave year, in order, as "YYYY-MM". */
export function monthsOfLeaveYear(leaveYear, startMonth) {
  return Array.from({ length: MONTHS_PER_YEAR }, (_, monthOffset) => {
    const monthIndex = startMonth - 1 + monthOffset;
    const year = leaveYear + Math.floor(monthIndex / MONTHS_PER_YEAR);
    return `${year}-${pad2((monthIndex % MONTHS_PER_YEAR) + 1)}`;
  });
}

/** "YYYY-MM" -> its first and last date. */
export function monthRange(period) {
  const [year, month] = period.split('-').map(Number);
  const firstDate = `${period}-01`;
  const nextMonthFirstDate = month === MONTHS_PER_YEAR ? `${year + 1}-01-01` : `${year}-${pad2(month + 1)}-01`;
  return { firstDate, lastDate: addDaysToCalendarDate(nextMonthFirstDate, -1) };
}
