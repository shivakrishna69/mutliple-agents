/**
 * The work calendar: loading an office's calendar (weekly offs + holidays) for the working-day
 * rules in services/workingDays.js, and HR's changes to weekly offs and holidays.
 *
 * Permission checks are made by the controller; these functions assume the caller is allowed.
 * Errors the client can act on are thrown as WorkCalendarError with a stable `code`.
 */

import mongoose from 'mongoose';
import EmployeeProfile from '../models/EmployeeProfile.js';
import Holiday from '../models/Holiday.js';
import OfficeLocation from '../models/OfficeLocation.js';
import { WORK_CALENDAR_MESSAGES } from '../constants/messages.js';

export class WorkCalendarError extends Error {
  constructor(httpStatus, code, message) {
    super(message);
    this.name = 'WorkCalendarError';
    this.httpStatus = httpStatus;
    this.code = code;
  }
}

const notFoundOffice = () => new WorkCalendarError(404, 'OFFICE_NOT_FOUND', WORK_CALENDAR_MESSAGES.OFFICE_NOT_FOUND);
const notFoundHoliday = () => new WorkCalendarError(404, 'HOLIDAY_NOT_FOUND', WORK_CALENDAR_MESSAGES.HOLIDAY_NOT_FOUND);
const staleVersion = () => new WorkCalendarError(409, 'STALE_VERSION', WORK_CALENDAR_MESSAGES.STALE_VERSION);

const toWeeklyOffRulesSummary = (rules) =>
  (rules ?? []).map((rule) => ({ weekday: rule.weekday, occurrencesInMonth: [...rule.occurrencesInMonth] }));

export function toOfficeCalendarSummary(office) {
  return {
    id: office._id.toString(),
    name: office.name,
    code: office.code,
    timeZone: office.timeZone,
    weeklyOffRules: toWeeklyOffRulesSummary(office.workday?.weeklyOffRules),
    version: office.__v,
  };
}

export function toHolidaySummary(holiday) {
  return {
    id: holiday._id.toString(),
    name: holiday.name,
    date: holiday.date,
    officeLocationIds: holiday.officeLocationIds.map((officeId) => officeId.toString()),
    appliesToAllOffices: holiday.officeLocationIds.length === 0,
    version: holiday.__v,
  };
}

/** Holidays on [firstDate, lastDate] that apply to the office: its own and company-wide ones. */
function holidaysForOfficeFilter(officeLocationId, firstDate, lastDate) {
  return {
    date: { $gte: firstDate, $lte: lastDate },
    $or: [{ officeLocationIds: { $size: 0 } }, { officeLocationIds: new mongoose.Types.ObjectId(officeLocationId) }],
  };
}

/**
 * The calendar services/workingDays.js needs for one office over a date range.
 * @returns {Promise<{ office: object, weeklyOffRules: object[], holidaysByDate: Map<string, string> }>}
 */
export async function loadOfficeCalendar(officeLocationId, firstDate, lastDate) {
  const office = await OfficeLocation.findById(officeLocationId)
    .select('name code timeZone workday.weeklyOffRules')
    .lean();
  if (!office) throw notFoundOffice();
  const holidays = await Holiday.find(holidaysForOfficeFilter(officeLocationId, firstDate, lastDate))
    .select('name date')
    .lean();
  return {
    office,
    weeklyOffRules: toWeeklyOffRulesSummary(office.workday?.weeklyOffRules),
    holidaysByDate: new Map(holidays.map((holiday) => [holiday.date, holiday.name])),
  };
}

/** The signed-in user's base office id, or null (no profile, or HR has not assigned an office yet). */
export async function findOwnOfficeLocationId(userId) {
  const ownProfile = await EmployeeProfile.findOne({ userId }).select('organizationData.officeLocationId').lean();
  return ownProfile?.organizationData?.officeLocationId?.toString() ?? null;
}

// =================================================================================================
// Offices: weekly offs
// =================================================================================================

export async function listOfficeCalendars() {
  // __v is the version HR sends back with an edit (optimistic concurrency).
  const offices = await OfficeLocation.find({})
    .select('name code timeZone workday.weeklyOffRules __v')
    .sort({ name: 1 });
  return offices.map(toOfficeCalendarSummary);
}

export async function updateOfficeWeeklyOffs({ officeLocationId, weeklyOffRules, version }) {
  const office = await OfficeLocation.findById(officeLocationId);
  if (!office) throw notFoundOffice();
  if (office.__v !== version) throw staleVersion();
  office.workday.weeklyOffRules = weeklyOffRules;
  try {
    await office.save();
  } catch (saveError) {
    if (saveError instanceof mongoose.Error.VersionError) throw staleVersion();
    throw saveError;
  }
  return toOfficeCalendarSummary(office);
}

// =================================================================================================
// Holidays
// =================================================================================================

/** HR's list: every holiday in the range, or only those that apply to one office. */
export async function listHolidays({ firstDate, lastDate, officeLocationId = null }) {
  const filter = officeLocationId
    ? holidaysForOfficeFilter(officeLocationId, firstDate, lastDate)
    : { date: { $gte: firstDate, $lte: lastDate } };
  const holidays = await Holiday.find(filter).sort({ date: 1, name: 1 });
  return holidays.map(toHolidaySummary);
}

async function assertOfficesExist(officeLocationIds) {
  if (officeLocationIds.length === 0) return;
  const existingCount = await OfficeLocation.countDocuments({ _id: { $in: officeLocationIds } });
  if (existingCount !== officeLocationIds.length) throw notFoundOffice();
}

/**
 * Two holidays may not cover the same date for the same office. A company-wide holiday covers every
 * office, so it clashes with any other holiday on that date.
 */
async function assertNoHolidayClash({ date, officeLocationIds, excludeHolidayId = null }) {
  const scopeFilter =
    officeLocationIds.length === 0
      ? {}
      : { $or: [{ officeLocationIds: { $size: 0 } }, { officeLocationIds: { $in: officeLocationIds } }] };
  const clash = await Holiday.exists({
    date,
    ...(excludeHolidayId ? { _id: { $ne: excludeHolidayId } } : {}),
    ...scopeFilter,
  });
  if (clash) throw new WorkCalendarError(409, 'HOLIDAY_CLASHES', WORK_CALENDAR_MESSAGES.HOLIDAY_CLASHES);
}

export async function createHoliday({ name, date, officeLocationIds, actorUserId }) {
  await assertOfficesExist(officeLocationIds);
  await assertNoHolidayClash({ date, officeLocationIds });
  const holiday = await Holiday.create({
    name,
    date,
    officeLocationIds,
    createdByUserId: actorUserId,
    updatedByUserId: actorUserId,
  });
  return toHolidaySummary(holiday);
}

export async function updateHoliday({ holidayId, changes, version, actorUserId }) {
  const holiday = await Holiday.findById(holidayId);
  if (!holiday) throw notFoundHoliday();
  if (holiday.__v !== version) throw staleVersion();
  const nextDate = changes.date ?? holiday.date;
  const nextOfficeIds = changes.officeLocationIds ?? holiday.officeLocationIds.map((officeId) => officeId.toString());
  if (changes.officeLocationIds) await assertOfficesExist(changes.officeLocationIds);
  await assertNoHolidayClash({ date: nextDate, officeLocationIds: nextOfficeIds, excludeHolidayId: holiday._id });
  if (changes.name !== undefined) holiday.name = changes.name;
  holiday.date = nextDate;
  holiday.officeLocationIds = nextOfficeIds;
  holiday.updatedByUserId = actorUserId;
  // Bump the version on every edit, not only on array changes, so stale edits are always caught.
  holiday.increment();
  try {
    await holiday.save();
  } catch (saveError) {
    if (saveError instanceof mongoose.Error.VersionError) throw staleVersion();
    throw saveError;
  }
  return toHolidaySummary(holiday);
}

export async function deleteHoliday({ holidayId }) {
  const deleted = await Holiday.findByIdAndDelete(holidayId).lean();
  if (!deleted) throw notFoundHoliday();
  return toHolidaySummary(deleted);
}
