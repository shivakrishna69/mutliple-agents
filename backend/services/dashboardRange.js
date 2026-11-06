/**
 * The period a dashboard shows, in the company's time zone, and the period it is compared with.
 *
 *   today  from today's local midnight to now
 *   7d     from local midnight 6 days ago to now (the last 7 calendar days, today included)
 *   30d    the same over 30 days
 *
 * The comparison period is the one just before, of the same length so far: for "today" at 14:30,
 * yesterday from midnight to 14:30. So a change ("−400 ms") compares like with like.
 *
 * Days start at local midnight in the zone (01:00 where daylight saving skips midnight), so "today"
 * is the company's today even when the server's clock (UTC) is still on yesterday.
 */

import { DASHBOARD_SETTINGS } from '../constants/validation.js';
import { addDaysToCalendarDate } from '../utils/calendarDates.js';
import { localDayStart, readOfficeLocalClock } from './attendancePolicy.js';

/** True for a range the dashboard knows ("today", "7d", "30d"). */
export function isDashboardRange(rangeKey) {
  return Object.values(DASHBOARD_SETTINGS.RANGES).includes(rangeKey);
}

/**
 * @param {string} rangeKey   one of DASHBOARD_SETTINGS.RANGES
 * @param {string} timeZone   IANA zone, the company's
 * @param {Date} now
 * @returns {{ key: string, timeZone: string, firstDate: string, lastDate: string, start: Date,
 *   end: Date, previousStart: Date, previousEnd: Date, dayCount: number }}
 *   firstDate and lastDate are local calendar dates ("YYYY-MM-DD"); start..end and
 *   previousStart..previousEnd are half-open [start, end)
 */
export function resolveDashboardRange(rangeKey, timeZone, now) {
  const dayCount = DASHBOARD_SETTINGS.RANGE_DAYS[rangeKey];
  const lastDate = readOfficeLocalClock(now, timeZone).calendarDate;
  const firstDate = addDaysToCalendarDate(lastDate, -(dayCount - 1));
  const start = localDayStart(firstDate, timeZone);
  const previousStart = localDayStart(addDaysToCalendarDate(firstDate, -dayCount), timeZone);
  const elapsedMs = now.getTime() - start.getTime();
  return {
    key: rangeKey,
    timeZone,
    firstDate,
    lastDate,
    start,
    end: now,
    previousStart,
    previousEnd: new Date(previousStart.getTime() + elapsedMs),
    dayCount,
  };
}

/**
 * The buckets the activity chart groups replies into: each local hour of the day for "today",
 * each local day for longer ranges. `key` is how MongoDB's $dateToString prints a moment in the
 * zone with `format`, so counts can be matched to their bucket.
 * @returns {{ unit: 'hour'|'day', format: string, buckets: { key: string, label: string }[] }}
 */
export function chartBucketsOf(range) {
  if (range.dayCount === 1) {
    const hours = Array.from({ length: 24 }, (_, hour) => String(hour).padStart(2, '0'));
    return {
      unit: 'hour',
      format: '%Y-%m-%dT%H',
      buckets: hours.map((hour) => ({ key: `${range.lastDate}T${hour}`, label: `${hour}:00` })),
    };
  }
  const days = Array.from({ length: range.dayCount }, (_, index) => addDaysToCalendarDate(range.firstDate, index));
  return { unit: 'day', format: '%Y-%m-%d', buckets: days.map((day) => ({ key: day, label: day })) };
}
