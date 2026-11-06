/**
 * The dashboard's people section (HR and administrators): the organisation today, from the same
 * services as the Attendance, Presence and Leave pages, so the numbers always agree with them.
 *
 *   attendance   today's board counts (services/attendanceToday.js): present (in or out), late,
 *                on leave, not in yet, on a holiday or weekly off, without an office
 *   presence     who is available / away / offline now (services/presenceActivity.js); null when
 *                the company has switched presence off
 *   waiting      what is waiting on this viewer: leave requests and leave changes they can decide,
 *                and attendance corrections still pending review
 *   headcount    current employees, by department, and joiners this month (company time zone)
 *   holidays     the next DASHBOARD_SETTINGS.UPCOMING_HOLIDAYS holidays from today
 */

import { DASHBOARD_SETTINGS } from '../constants/validation.js';
import Department from '../models/Department.js';
import EmployeeProfile, { EMPLOYMENT_STATUSES } from '../models/EmployeeProfile.js';
import { APPROVAL_QUEUES } from '../models/LeaveRequest.js';
import RegularizationReview, { REVIEW_STATUSES } from '../models/RegularizationReview.js';
import { addDaysToCalendarDate } from '../utils/calendarDates.js';
import { getTodayBoard } from './attendanceToday.js';
import { localDayStart } from './attendancePolicy.js';
import { listCurrentEmployees } from './employeeDirectory.js';
import { listApprovalQueue } from './leaveRequests.js';
import { getPresenceNow } from './presenceActivity.js';
import { loadPresenceSettings } from './presenceSettings.js';
import { listHolidays } from './workCalendar.js';
import { findOwnEmployeeProfileId } from './workforceAccess.js';

async function loadAttendance(viewer, now) {
  const { people, counts } = await getTodayBoard({ viewer, now });
  return {
    employees: people.length,
    present: counts.in + counts.out,
    late: counts.late,
    onLeave: counts.on_leave,
    notInYet: counts.not_in,
    dayOff: counts.holiday + counts.weekly_off,
    withoutOffice: counts.no_office,
  };
}

async function loadPresence(viewer, now) {
  const settings = await loadPresenceSettings();
  if (!settings.enabled) return null;
  return (await getPresenceNow({ viewer, now })).counts;
}

async function loadWaiting(viewer) {
  const actor = { role: viewer.role, employeeId: await findOwnEmployeeProfileId(viewer.id) };
  const [requests, changes, corrections] = await Promise.all([
    listApprovalQueue({ actor, queue: APPROVAL_QUEUES.REQUESTS }),
    listApprovalQueue({ actor, queue: APPROVAL_QUEUES.CHANGES }),
    RegularizationReview.countDocuments({ status: REVIEW_STATUSES.PENDING }),
  ]);
  return { leaveRequests: requests.length, leaveChanges: changes.length, attendanceCorrections: corrections };
}

async function loadHeadcount(range, now) {
  const employees = await listCurrentEmployees();
  const departmentCounts = new Map();
  for (const employee of employees) {
    const key = employee.departmentId ?? null;
    departmentCounts.set(key, (departmentCounts.get(key) ?? 0) + 1);
  }
  const departments = await Department.find({ _id: { $in: [...departmentCounts.keys()].filter(Boolean) } })
    .select('name')
    .lean();
  const departmentNames = new Map(departments.map((department) => [department._id.toString(), department.name]));
  const monthStart = localDayStart(`${range.lastDate.slice(0, 8)}01`, range.timeZone);
  const joinersThisMonth = await EmployeeProfile.countDocuments({
    'organizationData.employmentStatus': { $ne: EMPLOYMENT_STATUSES.TERMINATED },
    'organizationData.dateOfJoining': { $gte: monthStart, $lte: now },
  });
  return {
    employees: employees.length,
    joinersThisMonth,
    byDepartment: [...departmentCounts.entries()]
      .map(([departmentId, count]) => ({
        departmentId,
        name: departmentId ? (departmentNames.get(departmentId) ?? null) : null,
        count,
      }))
      .sort((first, second) => second.count - first.count),
  };
}

async function loadUpcomingHolidays(range) {
  const holidays = await listHolidays({
    firstDate: range.lastDate,
    lastDate: addDaysToCalendarDate(range.lastDate, DASHBOARD_SETTINGS.HOLIDAY_LOOKAHEAD_DAYS),
  });
  return holidays.slice(0, DASHBOARD_SETTINGS.UPCOMING_HOLIDAYS).map(({ id, name, date }) => ({ id, name, date }));
}

/**
 * @param {{ viewer: { id: string, role: string }, range: object, now: Date }} request
 *   range: services/dashboardRange.js (its lastDate is today in the company's time zone)
 */
export async function loadPeopleSummary({ viewer, range, now }) {
  const [attendance, presence, waiting, headcount, holidays] = await Promise.all([
    loadAttendance(viewer, now),
    loadPresence(viewer, now),
    loadWaiting(viewer),
    loadHeadcount(range, now),
    loadUpcomingHolidays(range),
  ]);
  return { attendance, presence, waiting, headcount, holidays };
}
