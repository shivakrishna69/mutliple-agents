/**
 * The single place where regularized Attendance entries are written, for both approval paths:
 *   - the regularization agent (POST /api/internal/attendance/regularizations), method
 *     "automatic_evidence", within SELF_SERVICE_REGULARIZATION_DAYS;
 *   - a manager approving a review (POST /api/attendance/regularization-reviews/:id/decision),
 *     method "manager_approved", within MANAGER_REGULARIZATION_DAYS.
 *
 * Rules checked before writing (each failure is a RegularizationRuleError with an HTTP status):
 *   1. Employee      the profile exists and employment has not ended                    404 / 409
 *   2. Office        the profile has an office with a time zone and a shift              409
 *   3. Date          a real calendar day, not after today in the OFFICE's time zone, and
 *                    within the method's window                                          400 / 422
 *   4. Punch time    falls on that date in the office's time zone, inside the shift
 *                    [start, end), and not in the future                                 422
 *   5. Duplicates    an entry for (employee, date) already exists -> nothing is written;
 *                    the existing entry is returned with newlyCreated = false. The unique
 *                    { employeeId, date } index makes this hold under concurrent requests
 *                    too: a racing insert fails with E11000 and the winner is returned.
 * Status: Normal / Late / Half_Day from the punch time against the office's grace rules
 * (services/attendancePolicy.js classifyArrival), the same rule a device punch uses.
 */

import Attendance, { ATTENDANCE_ENTRY_SOURCES, REGULARIZATION_METHODS, isRealCalendarDate } from '../models/Attendance.js';
import EmployeeProfile, { EMPLOYMENT_STATUSES } from '../models/EmployeeProfile.js';
import OfficeLocation from '../models/OfficeLocation.js';
import { ATTENDANCE_FIELD_LIMITS } from '../constants/validation.js';
import { classifyArrival, daysBetweenCalendarDates, localTimeToMinutes, readOfficeLocalClock } from './attendancePolicy.js';

const DUPLICATE_KEY_ERROR_CODE = 11000;

export const REGULARIZATION_RULE_CODES = Object.freeze({
  EMPLOYEE_NOT_FOUND: 'EMPLOYEE_NOT_FOUND',
  EMPLOYMENT_ENDED: 'EMPLOYMENT_ENDED',
  OFFICE_NOT_CONFIGURED: 'OFFICE_NOT_CONFIGURED',
  INVALID_DATE: 'INVALID_DATE',
  DATE_IN_FUTURE: 'DATE_IN_FUTURE',
  OUTSIDE_REGULARIZATION_WINDOW: 'OUTSIDE_REGULARIZATION_WINDOW',
  PUNCH_NOT_ON_DATE: 'PUNCH_NOT_ON_DATE',
  PUNCH_OUTSIDE_SHIFT: 'PUNCH_OUTSIDE_SHIFT',
  PUNCH_IN_FUTURE: 'PUNCH_IN_FUTURE',
});

/** A regularization the rules refuse; `httpStatus` and `code` go straight into the error response. */
export class RegularizationRuleError extends Error {
  constructor(httpStatus, code, message) {
    super(message);
    this.name = 'RegularizationRuleError';
    this.httpStatus = httpStatus;
    this.code = code;
  }
}

const WINDOW_DAYS_BY_METHOD = Object.freeze({
  [REGULARIZATION_METHODS.AUTOMATIC_EVIDENCE]: ATTENDANCE_FIELD_LIMITS.SELF_SERVICE_REGULARIZATION_DAYS,
  [REGULARIZATION_METHODS.MANAGER_APPROVED]: ATTENDANCE_FIELD_LIMITS.MANAGER_REGULARIZATION_DAYS,
});

/** The fields every regularization response shows. */
export function toRegularizedAttendanceSummary(attendanceRecord) {
  return {
    id: attendanceRecord._id.toString(),
    employeeId: attendanceRecord.employeeId.toString(),
    date: attendanceRecord.date,
    timeZone: attendanceRecord.timeZone,
    checkInTime: attendanceRecord.checkInTime.toISOString(),
    calculationStatus: attendanceRecord.calculationStatus,
    lateByMinutes: attendanceRecord.lateByMinutes,
    entrySource: attendanceRecord.entrySource ?? ATTENDANCE_ENTRY_SOURCES.DEVICE_PUNCH,
    regularization: attendanceRecord.regularization
      ? {
          method: attendanceRecord.regularization.method,
          regularizedBySystem: attendanceRecord.regularization.regularizedBySystem,
          approvedByUserId: attendanceRecord.regularization.approvedByUserId ? attendanceRecord.regularization.approvedByUserId.toString() : null,
        }
      : null,
  };
}

/**
 * Validates and writes one regularized entry (see the module comment).
 * @param {object} regularization
 * @param {string} regularization.employeeId           EmployeeProfile id
 * @param {string} regularization.date                 "YYYY-MM-DD" in the office's time zone
 * @param {Date}   regularization.punchInTime          the instant to record as checkInTime
 * @param {string} regularization.method               REGULARIZATION_METHODS value
 * @param {string|null} [regularization.approvedByUserId]  approving manager (manager_approved only)
 * @param {string|null} [regularization.reviewId]
 * @param {number} [regularization.evidenceEventCount]
 * @param {string|null} [regularization.reason]
 * @param {string|null} [regularization.sourceThreadId]
 * @param {Date}   [regularization.now]                 clock, injectable for tests
 * @returns {Promise<{ attendance: object, newlyCreated: boolean }>}
 * @throws {RegularizationRuleError}
 */
export async function recordRegularizedAttendance({
  employeeId,
  date,
  punchInTime,
  method,
  approvedByUserId = null,
  reviewId = null,
  evidenceEventCount = 0,
  reason = null,
  sourceThreadId = null,
  now = new Date(),
}) {
  // ---- 1. Employee ----------------------------------------------------------------------------
  const employeeProfile = await EmployeeProfile.findById(employeeId).select('organizationData').lean();
  if (!employeeProfile) throw new RegularizationRuleError(404, REGULARIZATION_RULE_CODES.EMPLOYEE_NOT_FOUND, 'Employee not found');
  if (employeeProfile.organizationData.employmentStatus === EMPLOYMENT_STATUSES.TERMINATED) {
    throw new RegularizationRuleError(409, REGULARIZATION_RULE_CODES.EMPLOYMENT_ENDED, 'The employee is no longer employed');
  }

  // ---- 2. Office ------------------------------------------------------------------------------
  const office = employeeProfile.organizationData.officeLocationId ? await OfficeLocation.findById(employeeProfile.organizationData.officeLocationId).lean() : null;
  if (!office || !office.workday?.shiftEndLocalTime) {
    throw new RegularizationRuleError(409, REGULARIZATION_RULE_CODES.OFFICE_NOT_CONFIGURED, 'The employee has no office with a shift configured');
  }

  // ---- 3. Date --------------------------------------------------------------------------------
  if (!isRealCalendarDate(date)) throw new RegularizationRuleError(400, REGULARIZATION_RULE_CODES.INVALID_DATE, 'date must be a real calendar day as YYYY-MM-DD');
  const officeToday = readOfficeLocalClock(now, office.timeZone).calendarDate;
  const daysAgo = daysBetweenCalendarDates(date, officeToday);
  if (daysAgo < 0) throw new RegularizationRuleError(422, REGULARIZATION_RULE_CODES.DATE_IN_FUTURE, 'The date is in the future in the office time zone');
  const windowDays = WINDOW_DAYS_BY_METHOD[method];
  if (daysAgo > windowDays) {
    throw new RegularizationRuleError(422, REGULARIZATION_RULE_CODES.OUTSIDE_REGULARIZATION_WINDOW, `Only the last ${windowDays} days can be regularized this way`);
  }

  // ---- 4. Punch time --------------------------------------------------------------------------
  if (punchInTime.getTime() > now.getTime()) throw new RegularizationRuleError(422, REGULARIZATION_RULE_CODES.PUNCH_IN_FUTURE, 'The punch-in time is in the future');
  const localPunch = readOfficeLocalClock(punchInTime, office.timeZone);
  if (localPunch.calendarDate !== date) {
    throw new RegularizationRuleError(422, REGULARIZATION_RULE_CODES.PUNCH_NOT_ON_DATE, `The punch-in time does not fall on ${date} in ${office.timeZone}`);
  }
  const shiftStartMinutes = localTimeToMinutes(office.workday.shiftStartLocalTime);
  const shiftEndMinutes = localTimeToMinutes(office.workday.shiftEndLocalTime);
  if (localPunch.minutesSinceMidnight < shiftStartMinutes || localPunch.minutesSinceMidnight >= shiftEndMinutes) {
    throw new RegularizationRuleError(
      422,
      REGULARIZATION_RULE_CODES.PUNCH_OUTSIDE_SHIFT,
      `The punch-in time must be within the shift (${office.workday.shiftStartLocalTime}-${office.workday.shiftEndLocalTime} ${office.timeZone})`,
    );
  }

  // ---- 5. Duplicates and write ----------------------------------------------------------------
  const existingEntry = await Attendance.findOne({ employeeId, date }).lean();
  if (existingEntry) return { attendance: existingEntry, newlyCreated: false };

  const { calculationStatus, lateByMinutes } = classifyArrival(localPunch.minutesSinceMidnight, office.workday);
  try {
    const createdEntry = await Attendance.create({
      entrySource: ATTENDANCE_ENTRY_SOURCES.REGULARIZATION,
      employeeId,
      officeLocationId: office._id,
      date,
      timeZone: office.timeZone,
      checkInTime: punchInTime,
      calculationStatus,
      lateByMinutes,
      regularization: {
        method,
        regularizedBySystem: method === REGULARIZATION_METHODS.AUTOMATIC_EVIDENCE,
        approvedByUserId: method === REGULARIZATION_METHODS.MANAGER_APPROVED ? approvedByUserId : null,
        reviewId,
        evidenceEventCount,
        reason,
        sourceThreadId,
        regularizedAt: now,
      },
    });
    return { attendance: createdEntry.toObject(), newlyCreated: true };
  } catch (writeError) {
    if (writeError?.code !== DUPLICATE_KEY_ERROR_CODE) throw writeError;
    // A concurrent request (or a device punch) won the unique { employeeId, date } index.
    const winningEntry = await Attendance.findOne({ employeeId, date }).lean();
    return { attendance: winningEntry, newlyCreated: false };
  }
}
