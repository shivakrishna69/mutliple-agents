/**
 * Calendar dates as "YYYY-MM-DD" strings, the form used everywhere a day matters more than an
 * instant (attendance, holidays, leave). Pure functions; arithmetic is done on UTC midnights, so
 * results never depend on the server's time zone or daylight-saving changes.
 */

import { CALENDAR_DATE_PATTERN } from '../constants/validation.js';

const MILLISECONDS_PER_DAY = 86_400_000;
/** Days in one week; also the size of each "nth week of the month" block (days 1-7, 8-14, ...). */
const DAYS_PER_WEEK = 7;

function toUtcMs(calendarDate) {
  const [year, month, day] = calendarDate.split('-').map(Number);
  return Date.UTC(year, month - 1, day);
}

function fromUtcMs(utcMs) {
  return new Date(utcMs).toISOString().slice(0, 10);
}

/** True when "YYYY-MM-DD" names a real calendar day (rejects 2026-02-30). */
export function isRealCalendarDate(calendarDate) {
  if (typeof calendarDate !== 'string' || !CALENDAR_DATE_PATTERN.test(calendarDate)) return false;
  const [year, month, day] = calendarDate.split('-').map(Number);
  const utcDate = new Date(Date.UTC(year, month - 1, day));
  return utcDate.getUTCFullYear() === year && utcDate.getUTCMonth() === month - 1 && utcDate.getUTCDate() === day;
}

/** Whole days from one "YYYY-MM-DD" to a later one (negative when `laterDate` is earlier). */
export function daysBetweenCalendarDates(earlierDate, laterDate) {
  return Math.round((toUtcMs(laterDate) - toUtcMs(earlierDate)) / MILLISECONDS_PER_DAY);
}

/** The date `dayCount` days after `calendarDate` (before it when negative). */
export function addDaysToCalendarDate(calendarDate, dayCount) {
  return fromUtcMs(toUtcMs(calendarDate) + dayCount * MILLISECONDS_PER_DAY);
}

/** Day of the week: 0 = Sunday ... 6 = Saturday (the JavaScript convention). */
export function weekdayOfCalendarDate(calendarDate) {
  return new Date(toUtcMs(calendarDate)).getUTCDay();
}

/**
 * Which occurrence of its weekday the date is within its month: 1 for days 1-7, 2 for days 8-14,
 * and so on up to 5. "The 2nd Saturday" is the Saturday whose value is 2.
 */
export function weekdayOccurrenceInMonth(calendarDate) {
  const dayOfMonth = Number(calendarDate.slice(8, 10));
  return Math.ceil(dayOfMonth / DAYS_PER_WEEK);
}

/** Every date from `firstDate` to `lastDate`, both included; empty when `lastDate` is earlier. */
export function listCalendarDates(firstDate, lastDate) {
  const dayCount = daysBetweenCalendarDates(firstDate, lastDate);
  return Array.from({ length: Math.max(dayCount + 1, 0) }, (_, offset) => addDaysToCalendarDate(firstDate, offset));
}
