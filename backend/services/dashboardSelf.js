/**
 * The dashboard's "me" section: the signed-in person's own day, for anyone with an employee
 * profile (an account without one gets null). Read from the same services as their Attendance,
 * Leave and Payroll pages.
 *
 *   today          today's attendance status, punch times and minutes worked (services/attendanceToday.js)
 *   leaveBalances  the first DASHBOARD_SETTINGS.TOP_LEAVE_BALANCES leave types with available days
 *   pendingLeave   their leave requests still waiting for a decision
 *   latestPayslip  the newest issued payslip's id and month, or null
 *   nextHoliday    the next holiday at their office (or company-wide), or null
 */

import { DASHBOARD_SETTINGS } from '../constants/validation.js';
import { LEAVE_REQUEST_STATUSES } from '../models/LeaveRequest.js';
import Payslip, { PAYSLIP_STATUSES } from '../models/Payslip.js';
import { addDaysToCalendarDate } from '../utils/calendarDates.js';
import { getMyAttendanceDay } from './attendanceToday.js';
import { getEmployeeBalances } from './leaveBalances.js';
import { listEmployeeLeaveRequests } from './leaveRequests.js';
import { findOwnOfficeAssignment, listHolidays } from './workCalendar.js';
import { findOwnEmployeeProfileId } from './workforceAccess.js';

async function loadToday(userId, now) {
  const day = await getMyAttendanceDay({ userId, now });
  return {
    date: day.date,
    status: day.status,
    holidayName: day.holidayName,
    checkInTime: day.punch?.checkInTime ?? null,
    checkOutTime: day.punch?.checkOutTime ?? null,
    workedMinutes: day.punch?.workedMinutes ?? null,
  };
}

async function loadLeaveBalances(employeeId, now) {
  const { balances } = await getEmployeeBalances({ employeeId, leaveYear: null, now });
  return balances.slice(0, DASHBOARD_SETTINGS.TOP_LEAVE_BALANCES).map((balance) => ({
    leaveTypeId: balance.leaveType.id,
    code: balance.leaveType.code,
    name: balance.leaveType.name,
    availableDays: balance.availableDays,
  }));
}

async function loadLatestPayslip(employeeId) {
  const payslip = await Payslip.findOne({ employeeId, status: PAYSLIP_STATUSES.ISSUED })
    .sort({ 'period.year': -1, 'period.month': -1 })
    .select('_id period')
    .lean();
  return payslip ? { id: payslip._id.toString(), year: payslip.period.year, month: payslip.period.month } : null;
}

async function loadNextHoliday(userId, today) {
  const assignment = await findOwnOfficeAssignment(userId);
  const [holiday] = await listHolidays({
    firstDate: today,
    lastDate: addDaysToCalendarDate(today, DASHBOARD_SETTINGS.HOLIDAY_LOOKAHEAD_DAYS),
    officeLocationId: assignment?.officeLocationId ?? null,
  });
  return holiday ? { id: holiday.id, name: holiday.name, date: holiday.date } : null;
}

/**
 * @param {{ viewer: { id: string }, now: Date }} request
 * @returns {Promise<object|null>} null when the account has no employee profile
 */
export async function loadSelfSummary({ viewer, now }) {
  const employeeId = await findOwnEmployeeProfileId(viewer.id);
  if (!employeeId) return null;
  const today = await loadToday(viewer.id, now);
  const [leaveBalances, pending, latestPayslip, nextHoliday] = await Promise.all([
    loadLeaveBalances(employeeId, now),
    listEmployeeLeaveRequests({ employeeId, status: LEAVE_REQUEST_STATUSES.PENDING }),
    loadLatestPayslip(employeeId),
    loadNextHoliday(viewer.id, today.date),
  ]);
  return { today, leaveBalances, pendingLeave: pending.length, latestPayslip, nextHoliday };
}
