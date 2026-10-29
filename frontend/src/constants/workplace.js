/**
 * Display data for offices and the work calendar. Values mirror the backend
 * (backend/models/OfficeLocation.js, constants/validation.js WORK_CALENDAR_LIMITS); the backend
 * validates every change, so these only shape the forms.
 */

/** Weekday names indexed as JavaScript dates number them (0 = Sunday), like the backend's WEEKDAYS. */
export const WEEKDAY_NAMES = Object.freeze([
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
]);

/** Weekdays in the order an Indian work week is read: Monday first. */
export const WEEKDAYS_FROM_MONDAY = Object.freeze([1, 2, 3, 4, 5, 6, 0]);

/** "1st" ... "5th": which occurrence of a weekday in the month (backend MAX_WEEKDAY_OCCURRENCE = 5). */
export const WEEKDAY_OCCURRENCES = Object.freeze([
  { value: 1, label: '1st' },
  { value: 2, label: '2nd' },
  { value: 3, label: '3rd' },
  { value: 4, label: '4th' },
  { value: 5, label: '5th' },
]);

/** "Saturday (2nd and 4th)" or "Sunday" for one weekly-off rule. */
export function describeWeeklyOffRule({ weekday, occurrencesInMonth }) {
  if (occurrencesInMonth.length === 0) return WEEKDAY_NAMES[weekday];
  const occurrenceLabels = [...occurrencesInMonth]
    .sort((first, second) => first - second)
    .map((occurrence) => WEEKDAY_OCCURRENCES[occurrence - 1].label);
  const joined =
    occurrenceLabels.length === 1
      ? occurrenceLabels[0]
      : `${occurrenceLabels.slice(0, -1).join(', ')} and ${occurrenceLabels.at(-1)}`;
  return `${WEEKDAY_NAMES[weekday]} (${joined})`;
}

/**
 * Options for a time zone picker: every IANA zone this browser knows, plus `currentZone`. Browsers
 * list canonical names only (Chromium has "Asia/Calcutta", not "Asia/Kolkata", and no "UTC"), so a
 * stored zone can be missing from the list; it is added, or the picker would show another zone
 * than the one saved.
 */
export function timeZoneOptions(currentZone) {
  const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  const withCurrent = currentZone && !zones.includes(currentZone) ? [currentZone, ...zones] : zones;
  return withCurrent.map((zone) => ({ value: zone, label: zone }));
}

/** The browser's own time zone: the starting value for a new office. */
export function browserTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
}
