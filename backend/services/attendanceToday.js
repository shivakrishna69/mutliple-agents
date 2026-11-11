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
 * Who appears is decided by services/teamRoster.js: HR and administrators see everyone (optionally
 * one department), team leads their reports, anyone else is refused (403 TODAY_FORBIDDEN).
 */

import { ATTENDANCE_MESSAGES } from '../constants/messages.js';
import { DAY_KINDS } from '../constants/calendarDays.js';
import Attendance, {
  ATTENDANCE_ENTRY_SOURCES,
  ATTENDANCE_STATUSES,
  ATTENDANCE_WORK_MODES,
} from '../models/Attendance.js';
import EmployeeProfile from '../models/EmployeeProfile.js';
import LeaveDayClaim, { DAY_HALVES } from '../models/LeaveDayClaim.js';
import LeaveRequest, { LEAVE_REQUEST_STATUSES } from '../models/LeaveRequest.js';
import OfficeLocation from '../models/OfficeLocation.js';
import {
  allowedWorkModes,
  automaticPunchOut,
  effectiveGeofenceRadiusMeters,
  readOfficeLocalClock,
} from './attendancePolicy.js';
import { getCompanySettings } from './companySettings.js';
import { loadTeamRoster, localDateOf, resolveTeamScope, toPersonView } from './teamRoster.js';
import { loadOfficeCalendar } from './workCalendar.js';
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

export const LEAVE_HALVES = Object.freeze({ FULL: 'FULL', ...DAY_HALVES });

const isoOrNull = (date) => date?.toISOString() ?? null;

const TODAY_FORBIDDEN = Object.freeze({ code: 'TODAY_FORBIDDEN', message: ATTENDANCE_MESSAGES.TODAY_FORBIDDEN });

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
export async function loadApprovedLeave(employeeIds, dates) {
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
 * Each person's attendance on their day: their punch, approved leave, their office's day (working,
 * holiday or weekly off), and the status that follows (TODAY_STATUSES).
 * @param {{ people: object[], officesById: Map<string, object>, companyTimeZone: string,
 *   date?: string|null, now?: Date }} request  people and offices from services/teamRoster.js;
 *   without `date`, each person's own today (people without an office: the company's)
 * @returns {Promise<Map<string, { date: string, status: string, punch: object|null,
 *   leaveHalf: string|null, officeDay: object|null }>>} by employee id
 */
export async function loadAttendanceDays({ people, officesById, companyTimeZone, date = null, now = new Date() }) {
  const dateOf = (person) => date ?? localDateOf(person, companyTimeZone, now);
  const dateByOfficeId = new Map(
    [...officesById.values()].map((office) => [
      office._id.toString(),
      date ?? readOfficeLocalClock(now, office.timeZone).calendarDate,
    ]),
  );
  const dates = [...new Set(people.map(dateOf))];
  const employeeIds = people.map((person) => person.employeeId);
  const [punches, leaveByKey, officeDays] = await Promise.all([
    Attendance.find({ employeeId: { $in: employeeIds }, date: { $in: dates } }).lean(),
    loadApprovedLeave(employeeIds, dates),
    loadOfficeDays(officesById, dateByOfficeId),
  ]);
  const punchByKey = new Map(punches.map((punch) => [`${punch.employeeId}|${punch.date}`, punch]));

  return new Map(
    people.map((person) => {
      const personDate = dateOf(person);
      const key = `${person.employeeId}|${personDate}`;
      const punch = punchByKey.get(key) ?? null;
      const leaveHalf = leaveByKey.get(key) ?? null;
      const officeDay = person.office ? officeDays.get(person.officeId) : null;
      return [
        person.employeeId,
        {
          date: personDate,
          status: statusOf({ punch, leaveHalf, office: person.office, officeDay }),
          punch,
          leaveHalf,
          officeDay,
        },
      ];
    }),
  );
}

/**
 * The Today board.
 * @param {{ viewer: { id: string, role: string }, date?: string|null, departmentId?: string|null, now?: Date }} request
 * @returns {Promise<{ scope: string, date: string|null, people: object[], counts: Record<string, number> }>}
 *   `date` is the date asked for, or null when each person's own today was used.
 */
export async function getTodayBoard({ viewer, date = null, departmentId = null, now = new Date() }) {
  const { scope, filter } = await resolveTeamScope(viewer, { departmentId, forbidden: TODAY_FORBIDDEN });
  const roster = await loadTeamRoster({ filter, now });
  const attendanceDays = await loadAttendanceDays({ ...roster, date, now });

  const rows = roster.people.map((person) => {
    const day = attendanceDays.get(person.employeeId);
    return {
      ...toPersonView(person),
      date: day.date,
      status: day.status,
      holidayName: day.officeDay?.holidayName ?? null,
      leave: day.leaveHalf ? { half: day.leaveHalf } : null,
      punch: toPunchView(day.punch),
    };
  });

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
    // A punch made without a base office closes on its own time limit (automaticPunchOut with null).
    automaticPunchOutAt:
      isOpenDevicePunch && (office || !punch.officeLocationId)
        ? isoOrNull(automaticPunchOut(punch, punch.officeLocationId ? office : null).deadline)
        : null,
  };
}
