/**
 * The company's leave settings (models/LeaveSettings.js) and what follows from them for an
 * employee: their leave "today" and current leave year.
 */

import mongoose from 'mongoose';
import { HTTP_STATUS } from '../constants/httpStatus.js';
import { COMMON_MESSAGES, LEAVE_MESSAGES } from '../constants/messages.js';
import LeaveLedgerEntry from '../models/LeaveLedgerEntry.js';
import LeaveSettings, { LEAVE_SETTINGS_KEY } from '../models/LeaveSettings.js';
import { readOfficeLocalClock } from './attendancePolicy.js';
import { leaveYearOfDate } from './leaveYear.js';
import { ServiceError } from './serviceError.js';

const DUPLICATE_KEY_ERROR_CODE = 11000;

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
    if (upsertError?.code !== DUPLICATE_KEY_ERROR_CODE) throw upsertError;
    return LeaveSettings.findOne({ key: LEAVE_SETTINGS_KEY });
  }
}

/** HR's changes. The leave year's start month is locked once any leave has been recorded. */
export async function updateLeaveSettings({ changes, version, actorUserId }) {
  const settings = await getLeaveSettings();
  if (settings.__v !== version)
    throw new ServiceError(HTTP_STATUS.CONFLICT, 'STALE_VERSION', COMMON_MESSAGES.STALE_VERSION);
  const changesStartMonth =
    changes.leaveYearStartMonth !== undefined && changes.leaveYearStartMonth !== settings.leaveYearStartMonth;
  if (changesStartMonth && (await LeaveLedgerEntry.exists({}))) {
    throw new ServiceError(HTTP_STATUS.CONFLICT, 'LEAVE_YEAR_LOCKED', LEAVE_MESSAGES.LEAVE_YEAR_LOCKED);
  }
  settings.set({ ...changes, updatedByUserId: actorUserId });
  try {
    await settings.save();
  } catch (saveError) {
    if (saveError instanceof mongoose.Error.VersionError) {
      throw new ServiceError(HTTP_STATUS.CONFLICT, 'STALE_VERSION', COMMON_MESSAGES.STALE_VERSION);
    }
    throw saveError;
  }
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
