/**
 * Who is working today: the Today board for team leads and HR, and an employee's own day for their
 * punch screen. Read only.
 *
 * Each person's day is in their office's time zone ("today" can differ between offices), or on the
 * date asked for. A person's status, in order of precedence:
 *   in / out     they punched in today (out once the punch is closed), with how and when
 *   on_leave     approved leave covers the day (leave.half FULL, FIRST or SECOND)
 *   no_office    HR has not given them a base office, so no working day can be judged
 *   holiday      their office's holiday
 *   weekly_off   their office's weekly off
 *   not_in       a working day without a punch-in yet
 * Half-day leave with a punch-in shows as in/out with the leave alongside.
 *
 * Who appears: HR and administrators see everyone (optionally one department); anyone else sees the
 * people who report to them, and nobody when nobody does (403). Invited people who have not joined
 * yet, and people whose joining date is later, are left out.
 */

import { HTTP_STATUS } from '../constants/httpStatus.js';
import { ATTENDANCE_MESSAGES } from '../constants/messages.js';
import { DAY_KINDS } from '../constants/calendarDays.js';
import Attendance, {
  ATTENDANCE_ENTRY_SOURCES,
  ATTENDANCE_STATUSES,
  ATTENDANCE_WORK_MODES,
} from '../models/Attendance.js';
import Department from '../models/Department.js';
import EmployeeProfile, { EMPLOYMENT_STATUSES } from '../models/EmployeeProfile.js';
import LeaveDayClaim, { DAY_HALVES } from '../models/LeaveDayClaim.js';
import LeaveRequest, { LEAVE_REQUEST_STATUSES } from '../models/LeaveRequest.js';
import OfficeLocation from '../models/OfficeLocation.js';
import User, { ACCOUNT_STATUSES } from '../models/User.js';
import {
  allowedWorkModes,
  automaticPunchOut,
  effectiveGeofenceRadiusMeters,
  readOfficeLocalClock,
} from './attendancePolicy.js';
import { getCompanySettings } from './companySettings.js';
import { ServiceError } from './serviceError.js';
import { loadOfficeCalendar } from './workCalendar.js';
import { isWorkforceAdmin } from './workforceAccess.js';
import { classifyCalendarDay } from './workingDays.js';

export const TODAY_STATUSES = Object.freeze({
  IN: 'in',
  OUT: 'out',
  ON_LEAVE: 'on_leave',
  NO_OFFICE: 'no_office',
  HOLIDAY: 'holiday',
  WEEKLY_OFF: 'weekly_off',
  NOT_IN: 'not_in',
});

export const TODAY_SCOPES = Object.freeze({ ORGANISATION: 'organisation', DIRECT_REPORTS: 'direct_reports' });

const LEAVE_HALVES = Object.freeze({ FULL: 'FULL', ...DAY_HALVES });

const toIdString = (id) => id?.toString() ?? null;
const isoOrNull = (date) => date?.toISOString() ?? null;

/** The profiles the viewer may see, and how they were chosen. */
async function resolveScope(viewer, departmentId) {
  const currentEmployees = { 'organizationData.employmentStatus': { $ne: EMPLOYMENT_STATUSES.TERMINATED } };
  if (isWorkforceAdmin(viewer.role)) {
    return {
      scope: TODAY_SCOPES.ORGANISATION,
      filter: departmentId ? { ...currentEmployees, 'organizationData.departmentId': departmentId } : currentEmployees,
    };
  }
  const ownProfile = await EmployeeProfile.findOne({ userId: viewer.id }).select('_id').lean();
  const hasReports =
    ownProfile &&
    (await EmployeeProfile.exists({ ...currentEmployees, 'organizationData.reportingManagerId': ownProfile._id }));
  if (!hasReports)
    throw new ServiceError(HTTP_STATUS.FORBIDDEN, 'TODAY_FORBIDDEN', ATTENDANCE_MESSAGES.TODAY_FORBIDDEN);
  return {
    scope: TODAY_SCOPES.DIRECT_REPORTS,
    filter: { ...currentEmployees, 'organizationData.reportingManagerId': ownProfile._id },
  };
}

/** Each office's calendar day on `date`, by office id. */
async function loadOfficeDays(officesById, dateByOfficeId) {
  const entries = await Promise.all(
    [...officesById.keys()].map(async (officeId) => {
      const date = dateByOfficeId.get(officeId);
      const calendar = await loadOfficeCalendar(officeId, date, date);
      return [officeId, classifyCalendarDay(date, calendar)];
    }),
  );
  return new Map(entries);
}

/** Approved leave on the employees' dates: "<employeeId>|<date>" -> FULL, FIRST or SECOND. */
async function loadApprovedLeave(employeeIds, dates) {
  const claims = await LeaveDayClaim.find({ employeeId: { $in: employeeIds }, date: { $in: dates } })
    .select('employeeId date half leaveRequestId')
    .lean();
  if (claims.length === 0) return new Map();
  const approvedRequestIds = new Set(
    (
      await LeaveRequest.find({
        _id: { $in: claims.map((claim) => claim.leaveRequestId) },
        status: LEAVE_REQUEST_STATUSES.APPROVED,
      })
        .select('_id')
        .lean()
    ).map((request) => request._id.toString()),
  );
  const halvesByKey = new Map();
  for (const claim of claims) {
    if (!approvedRequestIds.has(claim.leaveRequestId.toString())) continue;
    const key = `${claim.employeeId}|${claim.date}`;
    halvesByKey.set(key, [...(halvesByKey.get(key) ?? []), claim.half]);
  }
  return new Map([...halvesByKey].map(([key, halves]) => [key, halves.length > 1 ? LEAVE_HALVES.FULL : halves[0]]));
}

function statusOf({ punch, leaveHalf, office, officeDay }) {
  if (punch) return punch.checkOutTime ? TODAY_STATUSES.OUT : TODAY_STATUSES.IN;
  if (leaveHalf) return TODAY_STATUSES.ON_LEAVE;
  if (!office) return TODAY_STATUSES.NO_OFFICE;
  if (officeDay?.kind === DAY_KINDS.HOLIDAY) return TODAY_STATUSES.HOLIDAY;
  if (officeDay?.kind === DAY_KINDS.WEEKLY_OFF) return TODAY_STATUSES.WEEKLY_OFF;
  return TODAY_STATUSES.NOT_IN;
}

/** What a punch shows on the board; no coordinates, only how far from the office it was made. */
function toPunchView(punch) {
  if (!punch) return null;
  return {
    entrySource: punch.entrySource,
    workMode: punch.workMode ?? null,
    onDutyReason: punch.onDutyReason ?? null,
    arrivalStatus: punch.calculationStatus,
    lateByMinutes: punch.lateByMinutes,
    checkInTime: isoOrNull(punch.checkInTime),
    checkOutTime: isoOrNull(punch.checkOutTime),
    checkOutSource: punch.checkOutSource ?? null,
    workedMinutes: punch.workedMinutes ?? null,
    distanceMeters: punch.geofence?.distanceMeters ?? null,
  };
}

/**
 * The Today board.
 * @param {{ viewer: { id: string, role: string }, date?: string|null, departmentId?: string|null, now?: Date }} request
 * @returns {Promise<{ scope: string, date: string|null, people: object[], counts: Record<string, number> }>}
 *   `date` is the date asked for, or null when each person's own today was used.
 */
export async function getTodayBoard({ viewer, date = null, departmentId = null, now = new Date() }) {
  const { scope, filter } = await resolveScope(viewer, departmentId);
  const profiles = await EmployeeProfile.find({ ...filter, 'organizationData.dateOfJoining': { $lte: now } })
    .select(
      'userId employeeCode organizationData.designation organizationData.departmentId organizationData.officeLocationId',
    )
    .lean();
  const accounts = await User.find({
    _id: { $in: profiles.map((profile) => profile.userId) },
    status: ACCOUNT_STATUSES.ACTIVE,
  })
    .select('name')
    .lean();
  const nameByUserId = new Map(accounts.map((account) => [account._id.toString(), account.name]));
  const people = profiles.filter((profile) => nameByUserId.has(profile.userId.toString()));

  const officeIds = [...new Set(people.map((profile) => toIdString(profile.organizationData.officeLocationId)))];
  const departmentIds = [...new Set(people.map((profile) => toIdString(profile.organizationData.departmentId)))];
  const [offices, departments, companySettings] = await Promise.all([
    OfficeLocation.find({ _id: { $in: officeIds.filter(Boolean) } })
      .select('name timeZone')
      .lean(),
    Department.find({ _id: { $in: departmentIds.filter(Boolean) } })
      .select('name')
      .lean(),
    getCompanySettings(),
  ]);
  const officesById = new Map(offices.map((office) => [office._id.toString(), office]));
  const departmentNameById = new Map(departments.map((department) => [department._id.toString(), department.name]));

  // Each office's today (or the date asked for); people without an office use the company's zone.
  const dateByOfficeId = new Map(
    offices.map((office) => [office._id.toString(), date ?? readOfficeLocalClock(now, office.timeZone).calendarDate]),
  );
  const companyDate = date ?? readOfficeLocalClock(now, companySettings.timeZone).calendarDate;
  const dateOf = (profile) => dateByOfficeId.get(toIdString(profile.organizationData.officeLocationId)) ?? companyDate;
  const dates = [...new Set([...dateByOfficeId.values(), companyDate])];

  const employeeIds = people.map((profile) => profile._id);
  const [punches, leaveByKey, officeDays] = await Promise.all([
    Attendance.find({ employeeId: { $in: employeeIds }, date: { $in: dates } }).lean(),
    loadApprovedLeave(employeeIds, dates),
    loadOfficeDays(officesById, dateByOfficeId),
  ]);
  const punchByKey = new Map(punches.map((punch) => [`${punch.employeeId}|${punch.date}`, punch]));

  const rows = people.map((profile) => {
    const officeId = toIdString(profile.organizationData.officeLocationId);
    const office = officesById.get(officeId) ?? null;
    const personDate = dateOf(profile);
    const key = `${profile._id}|${personDate}`;
    const punch = punchByKey.get(key) ?? null;
    const leaveHalf = leaveByKey.get(key) ?? null;
    const officeDay = office ? officeDays.get(officeId) : null;
    const departmentId = toIdString(profile.organizationData.departmentId);
    return {
      employeeId: profile._id.toString(),
      employeeCode: profile.employeeCode ?? null,
      name: nameByUserId.get(profile.userId.toString()),
      designation: profile.organizationData.designation,
      department: departmentId ? { id: departmentId, name: departmentNameById.get(departmentId) ?? null } : null,
      office: office ? { id: officeId, name: office.name } : null,
      date: personDate,
      status: statusOf({ punch, leaveHalf, office, officeDay }),
      holidayName: officeDay?.holidayName ?? null,
      leave: leaveHalf ? { half: leaveHalf } : null,
      punch: toPunchView(punch),
    };
  });
  rows.sort((first, second) => first.name.localeCompare(second.name));

  const counts = Object.fromEntries(Object.values(TODAY_STATUSES).map((status) => [status, 0]));
  for (const row of rows) counts[row.status] += 1;
  // Late here includes half days: both arrived after the grace period.
  counts.late = rows.filter((row) => row.punch && row.punch.arrivalStatus !== ATTENDANCE_STATUSES.NORMAL).length;
  counts.onDuty = rows.filter((row) => row.punch?.workMode === ATTENDANCE_WORK_MODES.ON_DUTY).length;
  return { scope, date, people: rows, counts };
}

/**
 * The signed-in employee's day, for their punch screen: their office and its radius, the work modes
 * they may choose, today's punch, and (automaticPunchOutAt) when an open punch will be closed on its
 * own if they do not punch out.
 * @returns {Promise<object|null>} null when no employee profile is linked to the account
 */
export async function getMyAttendanceDay({ userId, now = new Date() }) {
  const profile = await EmployeeProfile.findOne({ userId })
    .select('organizationData +biometricMetadata.allowedGeofenceRadius')
    .lean();
  if (!profile) return null;
  const { workLocationType, officeLocationId } = profile.organizationData;
  const workModes = allowedWorkModes(workLocationType);
  const office = officeLocationId ? await OfficeLocation.findById(officeLocationId).lean() : null;
  const timeZone = office?.timeZone ?? (await getCompanySettings()).timeZone;
  const date = readOfficeLocalClock(now, timeZone).calendarDate;

  const [punch, leaveByKey, calendar] = await Promise.all([
    Attendance.findOne({ employeeId: profile._id, date }).lean(),
    loadApprovedLeave([profile._id], [date]),
    office ? loadOfficeCalendar(office._id.toString(), date, date) : null,
  ]);
  const officeDay = calendar ? classifyCalendarDay(date, calendar) : null;
  const leaveHalf = leaveByKey.get(`${profile._id}|${date}`) ?? null;
  const isOpenDevicePunch = punch?.entrySource === ATTENDANCE_ENTRY_SOURCES.DEVICE_PUNCH && !punch.checkOutTime;

  return {
    date,
    timeZone,
    status: statusOf({ punch, leaveHalf, office, officeDay }),
    holidayName: officeDay?.holidayName ?? null,
    leave: leaveHalf ? { half: leaveHalf } : null,
    workLocationType,
    allowedWorkModes: workModes,
    defaultWorkMode: workModes[0],
    office: office
      ? {
          id: office._id.toString(),
          name: office.name,
          coordinates: { lat: office.coordinates.lat, lng: office.coordinates.lng },
          geofenceRadiusMeters: effectiveGeofenceRadiusMeters(office, profile.biometricMetadata?.allowedGeofenceRadius),
          shiftStartLocalTime: office.workday.shiftStartLocalTime,
          shiftEndLocalTime: office.workday.shiftEndLocalTime,
        }
      : null,
    punch: toPunchView(punch),
    automaticPunchOutAt: isOpenDevicePunch && office ? isoOrNull(automaticPunchOut(punch, office).deadline) : null,
  };
}
