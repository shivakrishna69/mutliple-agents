/**
 * Working-day rules: which days are working days for an office, and how many leave days a date
 * range costs. Pure functions (no database, no clock), so leave, attendance and payroll all apply
 * exactly the same rule. services/workCalendar.js loads the calendar these functions take.
 *
 * A calendar is { weeklyOffRules, holidaysByDate }:
 *   weeklyOffRules   OfficeLocation.workday.weeklyOffRules ({ weekday, occurrencesInMonth })
 *   holidaysByDate   Map "YYYY-MM-DD" -> holiday name, for the office and the company
 * A holiday that falls on a weekly off is reported as the holiday (it names the day); either way
 * the day is not a working day.
 *
 * Leave days for a range
 * ----------------------
 *   Each working day in the range costs one day, or half a day at either end:
 *     startDayPortion SECOND_HALF   the leave starts after the first half of the first day
 *     endDayPortion   FIRST_HALF    the leave ends after the first half of the last day
 *   A one-day range may be the first half (endDayPortion FIRST_HALF) or the second half
 *   (startDayPortion SECOND_HALF), not both.
 *   Weekly offs and holidays cost nothing, unless `sandwich` is on: then a non-working day costs a
 *   full day when the nearest working days on both sides of it, within the range, are FULL leave
 *   days. A half day is half a day worked, so it never triggers the rule: Friday afternoon plus
 *   Monday costs 1.5 days and the weekend stays free. Non-working days at the start or end of the
 *   range never cost anything, so a Friday-only leave never charges the weekend after it.
 */

import { WORK_CALENDAR_LIMITS } from '../constants/validation.js';
import {
  daysBetweenCalendarDates,
  isRealCalendarDate,
  listCalendarDates,
  weekdayOccurrenceInMonth,
  weekdayOfCalendarDate,
} from '../utils/calendarDates.js';

export const DAY_KINDS = Object.freeze({ WORKING: 'working', WEEKLY_OFF: 'weekly_off', HOLIDAY: 'holiday' });

export const DAY_PORTIONS = Object.freeze({ FULL: 'full', FIRST_HALF: 'first_half', SECOND_HALF: 'second_half' });

const FULL_DAY = 1;
const HALF_DAY = 0.5;

/** Thrown for a range the calculator cannot price; `code` is stable for API responses. */
export class LeaveRangeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LeaveRangeError';
    this.code = code;
  }
}

/** True when the office's weekly-off rules make `calendarDate` a day off. */
export function isWeeklyOff(calendarDate, weeklyOffRules) {
  const matchingRule = weeklyOffRules.find((rule) => rule.weekday === weekdayOfCalendarDate(calendarDate));
  if (!matchingRule) return false;
  return (
    matchingRule.occurrencesInMonth.length === 0 ||
    matchingRule.occurrencesInMonth.includes(weekdayOccurrenceInMonth(calendarDate))
  );
}

/** { date, kind, holidayName } for one day of an office's calendar. */
export function classifyCalendarDay(calendarDate, calendar) {
  const holidayName = calendar.holidaysByDate.get(calendarDate) ?? null;
  if (holidayName) return { date: calendarDate, kind: DAY_KINDS.HOLIDAY, holidayName };
  if (isWeeklyOff(calendarDate, calendar.weeklyOffRules)) {
    return { date: calendarDate, kind: DAY_KINDS.WEEKLY_OFF, holidayName: null };
  }
  return { date: calendarDate, kind: DAY_KINDS.WORKING, holidayName: null };
}

/** Every day from `firstDate` to `lastDate`, classified. */
export function classifyCalendarRange(firstDate, lastDate, calendar) {
  return listCalendarDates(firstDate, lastDate).map((calendarDate) => classifyCalendarDay(calendarDate, calendar));
}

function assertPricableRange({ startDate, endDate, startDayPortion, endDayPortion }) {
  if (!isRealCalendarDate(startDate) || !isRealCalendarDate(endDate)) {
    throw new LeaveRangeError('INVALID_DATE', 'Leave dates must be real calendar days as YYYY-MM-DD');
  }
  const rangeLengthDays = daysBetweenCalendarDates(startDate, endDate) + 1;
  if (rangeLengthDays < 1) throw new LeaveRangeError('END_BEFORE_START', 'The leave cannot end before it starts');
  if (rangeLengthDays > WORK_CALENDAR_LIMITS.MAX_RANGE_DAYS) {
    throw new LeaveRangeError(
      'RANGE_TOO_LONG',
      `A leave cannot span more than ${WORK_CALENDAR_LIMITS.MAX_RANGE_DAYS} days`,
    );
  }
  if (![DAY_PORTIONS.FULL, DAY_PORTIONS.SECOND_HALF].includes(startDayPortion)) {
    throw new LeaveRangeError('INVALID_PORTION', 'The first day must be a full day or start at the second half');
  }
  if (![DAY_PORTIONS.FULL, DAY_PORTIONS.FIRST_HALF].includes(endDayPortion)) {
    throw new LeaveRangeError('INVALID_PORTION', 'The last day must be a full day or end after the first half');
  }
  if (
    rangeLengthDays === 1 &&
    startDayPortion === DAY_PORTIONS.SECOND_HALF &&
    endDayPortion === DAY_PORTIONS.FIRST_HALF
  ) {
    throw new LeaveRangeError('INVALID_PORTION', 'A one-day leave can be the first half or the second half, not both');
  }
}

/**
 * Leave days the range costs under the office calendar.
 * @param {{ startDate: string, endDate: string, startDayPortion?: string, endDayPortion?: string,
 *           sandwich?: boolean }} range
 * @param {{ weeklyOffRules: object[], holidaysByDate: Map<string, string> }} calendar
 * @returns {{ totalDays: number, days: { date: string, kind: string, holidayName: string|null,
 *            chargedDays: number }[] }}
 * @throws {LeaveRangeError}
 */
export function calculateLeaveDays(
  { startDate, endDate, startDayPortion = DAY_PORTIONS.FULL, endDayPortion = DAY_PORTIONS.FULL, sandwich = false },
  calendar,
) {
  assertPricableRange({ startDate, endDate, startDayPortion, endDayPortion });
  const classifiedDays = classifyCalendarRange(startDate, endDate, calendar);
  const lastIndex = classifiedDays.length - 1;

  // Working days first: each costs a full day, less half a day at a half-day edge.
  const workingDayCharges = classifiedDays.map((day, dayIndex) => {
    if (day.kind !== DAY_KINDS.WORKING) return null;
    let chargedDays = FULL_DAY;
    if (dayIndex === 0 && startDayPortion === DAY_PORTIONS.SECOND_HALF) chargedDays -= HALF_DAY;
    if (dayIndex === lastIndex && endDayPortion === DAY_PORTIONS.FIRST_HALF) chargedDays -= HALF_DAY;
    return chargedDays;
  });

  // A non-working day is sandwiched only between two FULL leave days (the nearest working days on
  // either side within the range); the edges of the range have no neighbour on one side.
  const isFullLeaveDay = (dayIndex) => dayIndex !== -1 && workingDayCharges[dayIndex] === FULL_DAY;
  const nearestWorkingDayIndex = (fromIndex, step) => {
    for (let dayIndex = fromIndex + step; dayIndex >= 0 && dayIndex <= lastIndex; dayIndex += step) {
      if (workingDayCharges[dayIndex] !== null) return dayIndex;
    }
    return -1;
  };

  const days = classifiedDays.map((day, dayIndex) => {
    if (workingDayCharges[dayIndex] !== null) return { ...day, chargedDays: workingDayCharges[dayIndex] };
    const isSandwiched =
      sandwich &&
      isFullLeaveDay(nearestWorkingDayIndex(dayIndex, -1)) &&
      isFullLeaveDay(nearestWorkingDayIndex(dayIndex, 1));
    return { ...day, chargedDays: isSandwiched ? FULL_DAY : 0 };
  });

  return { totalDays: days.reduce((total, day) => total + day.chargedDays, 0), days };
}
