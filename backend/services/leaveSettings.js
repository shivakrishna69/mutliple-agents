/**
 * The company's leave settings (models/LeaveSettings.js) and what follows from them for an
 * employee: their leave "today" and current leave year.
 */

import { HTTP_STATUS } from '../constants/httpStatus.js';
import { LEAVE_MESSAGES } from '../constants/messages.js';
import EmployeeProfile from '../models/EmployeeProfile.js';
import LeaveLedgerEntry from '../models/LeaveLedgerEntry.js';
import LeaveSettings, { LEAVE_SETTINGS_KEY } from '../models/LeaveSettings.js';
import OfficeLocation from '../models/OfficeLocation.js';
import { isDuplicateKeyError } from '../utils/mongoErrors.js';
import { readOfficeLocalClock } from './attendancePolicy.js';
import { leaveYearOfDate } from './leaveYear.js';
import { assertCurrentVersion, employeeNotFound, saveVersioned, ServiceError } from './serviceError.js';

export function toLeaveSettingsSummary(settings) {
  return {
    leaveYearStartMonth: settings.leaveYearStartMonth,
    defaultTimeZone: settings.defaultTimeZone,
    version: settings.__v,
  };
}

/** The settings document, created with the defaults on first use. */
export async function getLeaveSettings() {
  try {
    return await LeaveSettings.findOneAndUpdate(
      { key: LEAVE_SETTINGS_KEY },
      { $setOnInsert: { key: LEAVE_SETTINGS_KEY } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
  } catch (upsertError) {
    // Two first uses at once: the other one created it.
    if (!isDuplicateKeyError(upsertError)) throw upsertError;
    return LeaveSettings.findOne({ key: LEAVE_SETTINGS_KEY });
  }
}

/** HR's changes. The leave year's start month is locked once any leave has been recorded. */
export async function updateLeaveSettings({ changes, version, actorUserId }) {
  const settings = await getLeaveSettings();
  assertCurrentVersion(settings, version);
  const changesStartMonth =
    changes.leaveYearStartMonth !== undefined && changes.leaveYearStartMonth !== settings.leaveYearStartMonth;
  if (changesStartMonth && (await LeaveLedgerEntry.exists({}))) {
    throw new ServiceError(HTTP_STATUS.CONFLICT, 'LEAVE_YEAR_LOCKED', LEAVE_MESSAGES.LEAVE_YEAR_LOCKED);
  }
  settings.set({ ...changes, updatedByUserId: actorUserId });
  await saveVersioned(settings);
  return toLeaveSettingsSummary(settings);
}

/** Today's date for an employee: in their office's zone, or the company default without an office. */
export function employeeToday({ officeTimeZone, settings, now = new Date() }) {
  return readOfficeLocalClock(now, officeTimeZone ?? settings.defaultTimeZone).calendarDate;
}

/** The leave year that contains `calendarDate` under the company settings. */
export function leaveYearForDate(calendarDate, settings) {
  return leaveYearOfDate(calendarDate, settings.leaveYearStartMonth);
}

/**
 * One employee as leave sees them: their profile, the settings, their time zone (their office's, or
 * the company default), their today and current leave year.
 * @throws {ServiceError} 404 EMPLOYEE_NOT_FOUND
 */
export async function loadEmployeeLeaveContext(employeeId, { now = new Date() } = {}) {
  const employee = await EmployeeProfile.findById(employeeId)
    .select(
      'organizationData.dateOfJoining organizationData.employmentStatus organizationData.officeLocationId ' +
        'organizationData.reportingManagerId',
    )
    .lean();
  if (!employee) throw employeeNotFound();
  const settings = await getLeaveSettings();
  const { officeLocationId } = employee.organizationData;
  const office = officeLocationId ? await OfficeLocation.findById(officeLocationId).select('timeZone').lean() : null;
  const timeZone = office?.timeZone ?? settings.defaultTimeZone;
  const today = employeeToday({ officeTimeZone: timeZone, settings, now });
  return { employee, settings, timeZone, today, currentLeaveYear: leaveYearForDate(today, settings) };
}
