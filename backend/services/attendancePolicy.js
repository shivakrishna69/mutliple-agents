/**
 * Attendance rules as pure functions: the office's local clock, arrival classification, and the
 * geofence decision. No I/O, so each rule can be tested directly and reasoned about in isolation.
 */

import { ATTENDANCE_STATUSES } from '../models/Attendance.js';
import { haversineDistanceMetres } from '../utils/geoDistance.js';

/**
 * Reads the wall-clock date and time at `instant` in `timeZone`.
 * Intl applies the zone's UTC offset and daylight-saving rules; hourCycle 'h23' keeps midnight as
 * 00 (some locales would print 24).
 * @param {Date} instant
 * @param {string} timeZone  IANA zone, e.g. "Asia/Kolkata"
 * @returns {{ calendarDate: string, minutesSinceMidnight: number }}  "YYYY-MM-DD" and 0..1439
 */
export function readOfficeLocalClock(instant, timeZone) {
  const dateTimeParts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const partValue = (partType) => dateTimeParts.find((datePart) => datePart.type === partType).value;
  return {
    calendarDate: `${partValue('year')}-${partValue('month')}-${partValue('day')}`,
    minutesSinceMidnight: Number(partValue('hour')) * 60 + Number(partValue('minute')),
  };
}

/**
 * Classifies an arrival against the office shift.
 *
 *   minutesAfterShiftStart = local arrival minute − shift start minute   (negative when early)
 *   ≤ lateGraceMinutes                       → Normal
 *   > lateGraceMinutes, ≤ halfDayAfterMinutes → Late
 *   > halfDayAfterMinutes                     → Half_Day
 *
 * Boundaries are inclusive for the more lenient status: arriving exactly at the end of the grace
 * period is still Normal.
 * @param {number} minutesSinceMidnight  local arrival time, 0..1439
 * @param {{ shiftStartLocalTime: string, lateGraceMinutes: number, halfDayAfterMinutes: number }} workday
 * @returns {{ calculationStatus: string, lateByMinutes: number }}
 */
export function classifyArrival(minutesSinceMidnight, workday) {
  const [shiftStartHour, shiftStartMinute] = workday.shiftStartLocalTime.split(':').map(Number);
  const minutesAfterShiftStart = minutesSinceMidnight - (shiftStartHour * 60 + shiftStartMinute);
  const lateByMinutes = Math.max(0, minutesAfterShiftStart);

  if (minutesAfterShiftStart > workday.halfDayAfterMinutes) return { calculationStatus: ATTENDANCE_STATUSES.HALF_DAY, lateByMinutes };
  if (minutesAfterShiftStart > workday.lateGraceMinutes) return { calculationStatus: ATTENDANCE_STATUSES.LATE, lateByMinutes };
  return { calculationStatus: ATTENDANCE_STATUSES.NORMAL, lateByMinutes };
}

/**
 * Spatial verification of a punch.
 *
 *   1. d = Haversine great-circle distance (metres) from the punch point to the office centre.
 *   2. The punch is inside when d ≤ allowedRadiusMeters (a point on the boundary counts as inside).
 *
 * The device's own uncertainty (accuracyMeters) is bounded before this runs (a fix less precise
 * than ATTENDANCE_FIELD_LIMITS.MAX_LOCATION_ACCURACY_METRES is refused), so the distance compared
 * here is from a reading precise enough to be meaningful at office scale.
 *
 * @param {{ lat: number, lng: number }} punchPoint
 * @param {{ lat: number, lng: number }} officeCoordinates
 * @param {number} allowedRadiusMeters
 * @returns {{ distanceMeters: number, isInsideGeofence: boolean }}
 */
export function evaluateGeofence(punchPoint, officeCoordinates, allowedRadiusMeters) {
  const distanceMeters = haversineDistanceMetres(punchPoint, officeCoordinates);
  return { distanceMeters, isInsideGeofence: distanceMeters <= allowedRadiusMeters };
}

/** "HH:MM" -> minutes since midnight. */
export function localTimeToMinutes(localTime) {
  const [hours, minutes] = localTime.split(':').map(Number);
  return hours * 60 + minutes;
}

/** Minutes since midnight -> "HH:MM". */
export function minutesToLocalTime(minutesSinceMidnight) {
  return `${String(Math.floor(minutesSinceMidnight / 60)).padStart(2, '0')}:${String(minutesSinceMidnight % 60).padStart(2, '0')}`;
}

/** Whole days from one "YYYY-MM-DD" to a later one (negative when `laterDate` is earlier). */
export function daysBetweenCalendarDates(earlierDate, laterDate) {
  const toUtcMs = (calendarDate) => {
    const [year, month, day] = calendarDate.split('-').map(Number);
    return Date.UTC(year, month - 1, day);
  };
  return Math.round((toUtcMs(laterDate) - toUtcMs(earlierDate)) / 86_400_000);
}

/** The zone's UTC offset at `instant`, in milliseconds (positive east of Greenwich). */
function utcOffsetMs(instant, timeZone) {
  const dateTimeParts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const partNumber = (partType) => Number(dateTimeParts.find((datePart) => datePart.type === partType).value);
  const wallClockAsUtcMs = Date.UTC(partNumber('year'), partNumber('month') - 1, partNumber('day'), partNumber('hour'), partNumber('minute'), partNumber('second'));
  return wallClockAsUtcMs - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * The instant at which the clock in `timeZone` shows `localTime` on `calendarDate`.
 *
 * The wall-clock reading is first treated as if it were UTC, then shifted by the zone's offset.
 * The offset is evaluated a second time at the resulting instant, because near a daylight-saving
 * change the offset at the guess and at the true instant differ. A wall-clock time that does not
 * exist in the zone (skipped by a spring-forward change) cannot round-trip and returns null.
 * @param {string} calendarDate  "YYYY-MM-DD"
 * @param {string} localTime     "HH:MM"
 * @param {string} timeZone      IANA zone
 * @returns {Date | null}
 */
export function zonedLocalTimeToInstant(calendarDate, localTime, timeZone) {
  const [year, month, day] = calendarDate.split('-').map(Number);
  const [hours, minutes] = localTime.split(':').map(Number);
  const wallClockAsUtcMs = Date.UTC(year, month - 1, day, hours, minutes);
  const firstGuessMs = wallClockAsUtcMs - utcOffsetMs(new Date(wallClockAsUtcMs), timeZone);
  const instant = new Date(wallClockAsUtcMs - utcOffsetMs(new Date(firstGuessMs), timeZone));
  const roundTrip = readOfficeLocalClock(instant, timeZone);
  const isExactRoundTrip = roundTrip.calendarDate === calendarDate && roundTrip.minutesSinceMidnight === hours * 60 + minutes;
  return isExactRoundTrip ? instant : null;
}
