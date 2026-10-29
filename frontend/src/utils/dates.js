/** Dates as the person using the browser sees them (their own time zone, not UTC). */

const pad2 = (value) => String(value).padStart(2, '0');

/** This month as "YYYY-MM", in the browser's time zone. */
export function currentLocalMonth(now = new Date()) {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}`;
}

/** Today as "YYYY-MM-DD", in the browser's time zone. */
export function localToday(now = new Date()) {
  return `${currentLocalMonth(now)}-${pad2(now.getDate())}`;
}

const CALENDAR_DATE_FORMAT = Object.freeze({ day: 'numeric', month: 'short', year: 'numeric' });

/**
 * A calendar day ("2026-10-20": a holiday, a leave date) as text. Read as UTC, because the day has
 * no time zone: parsing it as an instant would show the previous day in browsers west of UTC.
 */
export function formatCalendarDate(calendarDate, options = CALENDAR_DATE_FORMAT) {
  if (!calendarDate) return '—';
  return new Date(`${calendarDate}T00:00:00Z`).toLocaleDateString('en-IN', { ...options, timeZone: 'UTC' });
}
