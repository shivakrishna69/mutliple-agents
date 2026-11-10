/**
 * Attendance rules as pure functions: the office's local clock, arrival classification, and the
 * geofence decision. No I/O, so each rule can be tested directly and reasoned about in isolation.
 */

import { ATTENDANCE_DEFAULTS } from '../constants/validation.js';
import { ATTENDANCE_STATUSES, ATTENDANCE_WORK_MODES } from '../models/Attendance.js';
import { WORK_LOCATION_TYPES } from '../models/EmployeeProfile.js';
import { haversineDistanceMetres } from '../utils/geoDistance.js';

const { OFFICE, HOME, ON_DUTY } = ATTENDANCE_WORK_MODES;

/**
 * The work modes each work type may punch in with, the usual one first (the default when the
 * client sends none). On-site staff never work from home but may be on duty at a client site;
 * remote staff may still come to the office, where its radius is checked.
 */
const WORK_MODES_BY_LOCATION_TYPE = Object.freeze({
  [WORK_LOCATION_TYPES.ONSITE]: Object.freeze([OFFICE, ON_DUTY]),
  [WORK_LOCATION_TYPES.HYBRID]: Object.freeze([OFFICE, HOME, ON_DUTY]),
  [WORK_LOCATION_TYPES.REMOTE]: Object.freeze([HOME, OFFICE, ON_DUTY]),
});

/** @param {string} workLocationType  EmployeeProfile.organizationData.workLocationType */
export function allowedWorkModes(workLocationType) {
  return WORK_MODES_BY_LOCATION_TYPE[workLocationType] ?? WORK_MODES_BY_LOCATION_TYPE[WORK_LOCATION_TYPES.ONSITE];
}

/**
 * The radius an office punch-in is checked against: the employee's own when HR set one, otherwise
 * the office's. The default covers offices saved before offices had a radius.
 * @param {{ geofenceRadiusMeters?: number }} office
 * @param {number|null|undefined} employeeRadiusMeters  EmployeeProfile.biometricMetadata.allowedGeofenceRadius
 */
export function effectiveGeofenceRadiusMeters(office, employeeRadiusMeters) {
  return employeeRadiusMeters ?? office.geofenceRadiusMeters ?? ATTENDANCE_DEFAULTS.OFFICE_GEOFENCE_RADIUS_METRES;
}

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

  if (minutesAfterShiftStart > workday.halfDayAfterMinutes)
    return { calculationStatus: ATTENDANCE_STATUSES.HALF_DAY, lateByMinutes };
  if (minutesAfterShiftStart > workday.lateGraceMinutes)
    return { calculationStatus: ATTENDANCE_STATUSES.LATE, lateByMinutes };
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

const MINUTE_MS = 60_000;

/**
 * When an open punch is closed automatically, and the check-out time it gets then.
 *   Punched in before the shift ended: closed at the shift end of its day, once the office's
 *   autoPunchOutAfterMinutes have passed after it (until then the employee may punch out).
 *   Punched in after the shift ended: closed after that delay (at least a minute), at that moment.
 * @param {{ date: string, checkInTime: Date }} punch
 * @param {{ timeZone: string, workday: { shiftEndLocalTime: string, autoPunchOutAfterMinutes?: number } }|null} office
 *   null for a punch made without a base office: it is closed UNASSIGNED_AUTO_PUNCH_OUT_AFTER_MINUTES
 *   after the punch-in
 * @returns {{ closeAt: Date, deadline: Date }}  deadline: from then on the punch is closed at closeAt
 */
export function automaticPunchOut({ date, checkInTime }, office) {
  if (!office) {
    const closeAt = new Date(
      checkInTime.getTime() + ATTENDANCE_DEFAULTS.UNASSIGNED_AUTO_PUNCH_OUT_AFTER_MINUTES * MINUTE_MS,
    );
    return { closeAt, deadline: closeAt };
  }
  const delayMinutes = office.workday.autoPunchOutAfterMinutes ?? ATTENDANCE_DEFAULTS.AUTO_PUNCH_OUT_AFTER_MINUTES;
  const shiftEnd = zonedLocalTimeToInstant(date, office.workday.shiftEndLocalTime, office.timeZone);
  if (shiftEnd && shiftEnd > checkInTime) {
    return { closeAt: shiftEnd, deadline: new Date(shiftEnd.getTime() + delayMinutes * MINUTE_MS) };
  }
  const closeAt = new Date(checkInTime.getTime() + Math.max(delayMinutes, 1) * MINUTE_MS);
  return { closeAt, deadline: closeAt };
}

/** Whole minutes worked between a check-in and a check-out. */
export function workedMinutesBetween(checkInTime, checkOutTime) {
  return Math.floor((checkOutTime.getTime() - checkInTime.getTime()) / MINUTE_MS);
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
  const wallClockAsUtcMs = Date.UTC(
    partNumber('year'),
    partNumber('month') - 1,
    partNumber('day'),
    partNumber('hour'),
    partNumber('minute'),
    partNumber('second'),
  );
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
  const isExactRoundTrip =
    roundTrip.calendarDate === calendarDate && roundTrip.minutesSinceMidnight === hours * 60 + minutes;
  return isExactRoundTrip ? instant : null;
}

/**
 * The first instant of `calendarDate` in `timeZone`: local midnight, or 01:00 where a
 * daylight-saving change skips midnight.
 * @param {string} calendarDate  "YYYY-MM-DD"
 * @param {string} timeZone      IANA zone
 * @returns {Date}
 */
export function localDayStart(calendarDate, timeZone) {
  return (
    zonedLocalTimeToInstant(calendarDate, '00:00', timeZone) ?? zonedLocalTimeToInstant(calendarDate, '01:00', timeZone)
  );
}
