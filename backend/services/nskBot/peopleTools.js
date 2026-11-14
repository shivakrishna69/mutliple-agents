/**
 * The NSK people tools, for people with a people scope (nskAccess.js): the whole company for roles
 * with RUN_PEOPLE_LOOKUP, the departments they head for department heads. Called by nskTools.js after
 * it has checked the actor; every answer here is also audited there with the fields shown.
 *
 *   lookupEmployeeProfile   one person by name, employee ID or work email, among the current
 *                           employees in scope:
 *                             exactly one match (an employee ID always wins)  their profile, as
 *                                                                              profileMasking.js lets
 *                                                                              this role see it
 *                             several                                         the candidates to pick
 *                                                                              from (name, ID,
 *                                                                              designation, department)
 *                             none                                            nothing, and for a head
 *                                                                              a note that only their
 *                                                                              departments are searched
 *                           Salary is read only for roles allowed to see it (latest issued payslip).
 *   departmentMetrics       one department in scope, by name or code (the only one, for a head of one):
 *                           headcount, today's attendance by status, the active sprint with its tasks
 *                           by status and the open tasks, and pending approvals (leave requests and
 *                           attendance regularizations). Without a match: the departments to choose from.
 */

import { CAPABILITIES, ROLE_DEFINITIONS, hasCapability } from '../../constants/accessRoles.js';
import { NSK_BOT_MESSAGES } from '../../constants/messages.js';
import { NSK_BOT_SETTINGS } from '../../constants/validation.js';
import { ATTENDANCE_STATUSES } from '../../models/Attendance.js';
import Department from '../../models/Department.js';
import EmployeeProfile from '../../models/EmployeeProfile.js';
import LeaveRequest, { LEAVE_REQUEST_STATUSES } from '../../models/LeaveRequest.js';
import OfficeLocation from '../../models/OfficeLocation.js';
import Payslip, { PAYSLIP_STATUSES } from '../../models/Payslip.js';
import RegularizationReview, { REVIEW_STATUSES } from '../../models/RegularizationReview.js';
import Sprint, { SPRINT_STATUSES } from '../../models/Sprint.js';
import Task, { TASK_STATUSES } from '../../models/Task.js';
import User from '../../models/User.js';
import { calendarDateOfUtcInstant } from '../../utils/calendarDates.js';
import { escapeRegularExpression } from '../../utils/regularExpressions.js';
import { asClockTime } from '../attendanceAnalytics.js';
import { readOfficeLocalClock } from '../attendancePolicy.js';
import { TODAY_STATUSES, loadAttendanceDays } from '../attendanceToday.js';
import { getCompanySettings } from '../companySettings.js';
import { getEmployeeBalances } from '../leaveBalances.js';
import { CURRENT_EMPLOYEES, loadTeamRoster } from '../teamRoster.js';
import { PEOPLE_SCOPES } from './nskAccess.js';
import { revealProfile } from './profileMasking.js';

const S = NSK_BOT_SETTINGS;
const LABELS = NSK_BOT_MESSAGES.SOURCE_LABELS;
const MAX_NAME_TOKENS = 5;
const roleLabelOf = (role) => ROLE_DEFINITIONS.find((definition) => definition.value === role)?.label ?? role;
const toIdString = (id) => id?.toString() ?? null;

/** Current employees in the scope: everyone not terminated, within the head's departments for a head. */
function scopeFilter(scope) {
  return scope.kind === PEOPLE_SCOPES.ORGANISATION
    ? { ...CURRENT_EMPLOYEES }
    : { ...CURRENT_EMPLOYEES, 'organizationData.departmentId': { $in: scope.departmentIds } };
}

// =================================================================================================
// lookupEmployeeProfile
// =================================================================================================

/** The profiles in scope matching `query`: an exact employee ID alone when there is one. */
export async function findMatches(scope, query) {
  const filter = scopeFilter(scope);
  const exactly = new RegExp(`^${escapeRegularExpression(query)}$`, 'i');
  const byCode = await EmployeeProfile.find({ ...filter, employeeCode: exactly })
    .limit(2)
    .lean();
  if (byCode.length === 1) return byCode;
  const tokens = query.split(/\s+/).filter(Boolean).slice(0, MAX_NAME_TOKENS);
  const email = query.toLowerCase();
  const users = await User.find({
    $or: [
      { email },
      { companyEmail: email },
      { $and: tokens.map((token) => ({ name: new RegExp(escapeRegularExpression(token), 'i') })) },
    ],
  })
    .select('_id')
    .limit(S.LOOKUP_CANDIDATES_MAX * 10)
    .lean();
  return EmployeeProfile.find({ ...filter, userId: { $in: users.map((user) => user._id) } })
    .limit(S.LOOKUP_CANDIDATES_MAX * 10)
    .lean();
}

async function namesOf(profiles) {
  const users = await User.find({ _id: { $in: profiles.map((profile) => profile.userId) } })
    .select('name role phoneNumber')
    .lean();
  return new Map(users.map((user) => [user._id.toString(), user]));
}

export async function departmentNames(ids) {
  const departments = await Department.find({ _id: { $in: ids.filter(Boolean) } })
    .select('name code')
    .lean();
  return new Map(departments.map((department) => [department._id.toString(), department]));
}

export async function candidatesOf(profiles) {
  const [users, departments] = await Promise.all([
    namesOf(profiles),
    departmentNames(profiles.map((profile) => profile.organizationData.departmentId)),
  ]);
  return profiles
    .map((profile) => ({
      employee_code: profile.employeeCode,
      name: users.get(profile.userId.toString())?.name ?? null,
      designation: profile.organizationData.designation,
      department: departments.get(toIdString(profile.organizationData.departmentId))?.name ?? null,
    }))
    .sort((first, second) => (first.name ?? '').localeCompare(second.name ?? ''));
}

/** The latest issued payslip's figures, or a note that none was issued. */
async function latestSalary(employeeId) {
  const payslip = await Payslip.findOne({ employeeId, status: PAYSLIP_STATUSES.ISSUED })
    .sort({ 'period.year': -1, 'period.month': -1 })
    .select('period earnings grossEarnings totalDeductions netPay')
    .lean();
  if (!payslip) return { available: false, note: NSK_BOT_MESSAGES.SALARY_NOT_ISSUED };
  return {
    available: true,
    source: 'latest issued payslip',
    period: `${payslip.period.year}-${String(payslip.period.month).padStart(2, '0')}`,
    currency: 'INR',
    gross_monthly: payslip.grossEarnings,
    deductions_monthly: payslip.totalDeductions,
    net_pay_monthly: payslip.netPay,
    earnings: payslip.earnings.map((line) => ({ label: line.label, amount: line.amount })),
  };
}

async function attendanceToday(profile, now) {
  const roster = await loadTeamRoster({ filter: { _id: profile._id }, now });
  const [person] = roster.people;
  if (!person) return null;
  const days = await loadAttendanceDays({ ...roster, now });
  const day = days.get(person.employeeId);
  const timeZone = person.office?.timeZone ?? roster.companyTimeZone;
  const clock = (instant) =>
    instant ? asClockTime(readOfficeLocalClock(instant, timeZone).minutesSinceMidnight) : null;
  return {
    date: day.date,
    status: day.status,
    late: day.punch ? day.punch.calculationStatus !== ATTENDANCE_STATUSES.NORMAL : null,
    punch_in: clock(day.punch?.checkInTime),
    punch_out: clock(day.punch?.checkOutTime),
    leave_half: day.leaveHalf,
  };
}

async function fullProfile(profile, actor, now) {
  const { organizationData: organization } = profile;
  const [user, manager, office, department] = await Promise.all([
    User.findById(profile.userId).select('name role phoneNumber').lean(),
    organization.reportingManagerId
      ? EmployeeProfile.findById(organization.reportingManagerId).select('userId employeeCode').lean()
      : null,
    organization.officeLocationId ? OfficeLocation.findById(organization.officeLocationId).lean() : null,
    organization.departmentId ? Department.findById(organization.departmentId).select('name code').lean() : null,
  ]);
  const managerUser = manager ? await User.findById(manager.userId).select('name').lean() : null;
  const [today, balances, salary] = await Promise.all([
    attendanceToday(profile, now),
    getEmployeeBalances({ employeeId: profile._id, leaveYear: null, now }),
    // Read only for a role allowed to see it; revealProfile hides it from the others as well.
    hasCapability(actor.role, CAPABILITIES.MANAGE_COMPENSATION) ? latestSalary(profile._id) : null,
  ]);
  return {
    name: user?.name ?? null,
    employee_code: profile.employeeCode,
    role: user ? roleLabelOf(user.role) : null,
    designation: organization.designation,
    department: department?.name ?? null,
    reporting_manager: manager ? { name: managerUser?.name ?? null, employee_code: manager.employeeCode } : null,
    joining_date: calendarDateOfUtcInstant(organization.dateOfJoining),
    employment_status: organization.employmentStatus,
    work_location_type: organization.workLocationType,
    office: office ? { name: office.name, time_zone: office.timeZone } : null,
    shift: office ? `${office.workday.shiftStartLocalTime}-${office.workday.shiftEndLocalTime}` : null,
    attendance_today: today,
    leave_balances: {
      leave_year: { from: balances.leaveYearRange.firstDate, to: balances.leaveYearRange.lastDate },
      balances: balances.balances.map((balance) => ({
        code: balance.leaveType.code,
        name: balance.leaveType.name,
        available_days: balance.availableDays,
      })),
    },
    phone: user?.phoneNumber ?? null,
    salary,
  };
}

/**
 * @param {{ actor: object, scope: object, query: string, now: Date }} request
 * @returns {Promise<{ result: object, source: string|null, audit: object }>}
 */
export async function lookupEmployeeProfile({ actor, scope, query, now }) {
  const matches = await findMatches(scope, query);
  if (matches.length === 0) {
    return {
      result: {
        matches: 0,
        ...(scope.kind === PEOPLE_SCOPES.DEPARTMENTS ? { note: NSK_BOT_MESSAGES.PEOPLE_OUT_OF_SCOPE } : {}),
      },
      source: null,
      audit: { query, matches: 0, targetEmployeeIds: [], fieldsShown: [] },
    };
  }
  if (matches.length > 1) {
    const candidates = await candidatesOf(matches);
    return {
      result: {
        matches: matches.length,
        candidates: candidates.slice(0, S.LOOKUP_CANDIDATES_MAX),
        more_not_shown: Math.max(candidates.length - S.LOOKUP_CANDIDATES_MAX, 0),
      },
      source: LABELS.PEOPLE_SEARCH(query),
      audit: {
        query,
        matches: matches.length,
        targetEmployeeIds: matches.slice(0, S.LOOKUP_CANDIDATES_MAX).map((profile) => profile._id.toString()),
        fieldsShown: ['name', 'employee_code', 'designation', 'department'],
      },
    };
  }
  const [profile] = matches;
  const { profile: shown, fieldsShown } = revealProfile(await fullProfile(profile, actor, now), actor.role);
  return {
    result: { matches: 1, profile: shown },
    source: LABELS.EMPLOYEE_PROFILE(shown.name, shown.employee_code),
    audit: { query, matches: 1, targetEmployeeIds: [profile._id.toString()], fieldsShown },
  };
}

// =================================================================================================
// departmentMetrics
// =================================================================================================

async function departmentsInScope(scope) {
  const filter = { isActive: { $ne: false } };
  if (scope.kind === PEOPLE_SCOPES.DEPARTMENTS) filter._id = { $in: scope.departmentIds };
  return Department.find(filter).select('name code').sort({ name: 1 }).lean();
}

/** The department `query` names (code, then exact name, then a single partial name), or null. */
export function matchDepartment(departments, query) {
  if (!query) return departments.length === 1 ? departments[0] : null;
  const wanted = query.trim().toLowerCase();
  const byCode = departments.find((department) => department.code?.toLowerCase() === wanted);
  if (byCode) return byCode;
  const byName = departments.find((department) => department.name.toLowerCase() === wanted);
  if (byName) return byName;
  const partial = departments.filter((department) => department.name.toLowerCase().includes(wanted));
  return partial.length === 1 ? partial[0] : null;
}

async function todayRollup(departmentId, now) {
  const roster = await loadTeamRoster({
    filter: { ...CURRENT_EMPLOYEES, 'organizationData.departmentId': departmentId },
    now,
  });
  const days = await loadAttendanceDays({ ...roster, now });
  const counts = Object.fromEntries(Object.values(TODAY_STATUSES).map((status) => [status, 0]));
  let late = 0;
  for (const day of days.values()) {
    counts[day.status] += 1;
    if (day.punch && day.punch.calculationStatus !== ATTENDANCE_STATUSES.NORMAL) late += 1;
  }
  return { people_counted: roster.people.length, by_status: counts, late };
}

async function sprintSummary(departmentId) {
  const [sprint, openTasks] = await Promise.all([
    Sprint.findOne({ departmentId, status: SPRINT_STATUSES.ACTIVE }).select('name goal startDate endDate').lean(),
    Task.countDocuments({ departmentId, status: { $ne: TASK_STATUSES.DONE } }),
  ]);
  if (!sprint) return { active_sprint: null, open_tasks: openTasks };
  const byStatus = await Task.aggregate([
    { $match: { departmentId, sprintId: sprint._id } },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);
  const tasks = Object.fromEntries(Object.values(TASK_STATUSES).map((status) => [status, 0]));
  for (const { _id: status, count } of byStatus) tasks[status] = count;
  return {
    active_sprint: {
      name: sprint.name,
      goal: sprint.goal || null,
      start: sprint.startDate,
      end: sprint.endDate,
      tasks,
    },
    open_tasks: openTasks,
  };
}

async function pendingApprovals(departmentId) {
  const members = await EmployeeProfile.find({ ...CURRENT_EMPLOYEES, 'organizationData.departmentId': departmentId })
    .select('_id')
    .lean();
  const memberIds = members.map((member) => member._id);
  const [leaveRequests, leaveChanges, regularizations] = await Promise.all([
    LeaveRequest.countDocuments({ employeeId: { $in: memberIds }, status: LEAVE_REQUEST_STATUSES.PENDING }),
    LeaveRequest.countDocuments({
      employeeId: { $in: memberIds },
      status: LEAVE_REQUEST_STATUSES.APPROVED,
      pendingChange: { $ne: null },
    }),
    RegularizationReview.countDocuments({ employeeId: { $in: memberIds }, status: REVIEW_STATUSES.PENDING }),
  ]);
  return { leave_requests: leaveRequests, leave_changes: leaveChanges, attendance_regularizations: regularizations };
}

/**
 * @param {{ scope: object, department: string|null, now: Date }} request
 * @returns {Promise<{ result: object, source: string|null, audit: object }>}
 */
export async function departmentMetrics({ scope, department: query, now }) {
  const departments = await departmentsInScope(scope);
  const department = matchDepartment(departments, query);
  if (!department) {
    return {
      result: {
        found: false,
        note: NSK_BOT_MESSAGES.DEPARTMENT_NOT_FOUND,
        departments: departments.slice(0, S.DEPARTMENT_CHOICES_MAX).map(({ name, code }) => ({ name, code })),
        more_not_shown: Math.max(departments.length - S.DEPARTMENT_CHOICES_MAX, 0),
      },
      source: LABELS.DEPARTMENTS,
      audit: { query, targetDepartmentIds: [], fieldsShown: ['departments'] },
    };
  }
  const departmentId = department._id;
  const [headcount, today, work, approvals, { timeZone }] = await Promise.all([
    EmployeeProfile.countDocuments({ ...CURRENT_EMPLOYEES, 'organizationData.departmentId': departmentId }),
    todayRollup(departmentId, now),
    sprintSummary(departmentId),
    pendingApprovals(departmentId),
    getCompanySettings(),
  ]);
  const date = readOfficeLocalClock(now, timeZone).calendarDate;
  return {
    result: {
      found: true,
      department: { name: department.name, code: department.code },
      date,
      headcount,
      attendance_today: today,
      work,
      pending_approvals: approvals,
    },
    source: LABELS.DEPARTMENT_METRICS(department.name, date),
    audit: {
      query,
      targetDepartmentIds: [departmentId.toString()],
      fieldsShown: ['headcount', 'attendance_today', 'work', 'pending_approvals'],
    },
  };
}
