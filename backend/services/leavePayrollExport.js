/**
 * Leave figures for one payroll month, for payroll to apply (payslips stay separate from leave):
 *   unpaidDays     approved leave of unpaid types (Loss of Pay) charged on days in the month,
 *                  including sandwich and border charges on those days
 *   encashments    days encashed with this payroll month, by type and payroll reference
 *
 * With `changedSince`, only employees whose figures may have changed since then are listed (an
 * unpaid request approved, cancelled or shortened, or an encashment posted), each with their full
 * figures for the month, so payroll replaces rather than adds.
 */

import { LEAVE_LIMITS } from '../constants/validation.js';
import LeaveLedgerEntry, { LEDGER_ENTRY_TYPES } from '../models/LeaveLedgerEntry.js';
import LeaveRequest, { LEAVE_REQUEST_STATUSES } from '../models/LeaveRequest.js';
import LeaveType from '../models/LeaveType.js';
import EmployeeProfile from '../models/EmployeeProfile.js';
import User from '../models/User.js';
import { addDaysToCalendarDate } from '../utils/calendarDates.js';
import { centidaysToDays } from '../utils/leaveDays.js';
import { monthRange } from './leaveYear.js';

/** Requests whose days or border charges can fall in the month: border charges sit just outside a range. */
function overlapsMonth({ firstDate, lastDate }) {
  return {
    startDate: { $lte: addDaysToCalendarDate(lastDate, LEAVE_LIMITS.MAX_SANDWICH_GAP_DAYS) },
    endDate: { $gte: addDaysToCalendarDate(firstDate, -LEAVE_LIMITS.MAX_SANDWICH_GAP_DAYS) },
  };
}

async function contactsOf(employeeIds) {
  const profiles = await EmployeeProfile.find({ _id: { $in: employeeIds } })
    .select('userId')
    .lean();
  const users = await User.find({ _id: { $in: profiles.map((profile) => profile.userId) } })
    .select('name email')
    .lean();
  const userById = new Map(users.map((user) => [user._id.toString(), user]));
  return new Map(profiles.map((profile) => [profile._id.toString(), userById.get(profile.userId.toString()) ?? null]));
}

/**
 * @param {{ month: string, changedSince: Date|null }} query  month as "YYYY-MM"
 */
export async function exportLeaveForPayroll({ month, changedSince = null }) {
  const monthDates = monthRange(month);
  const inMonth = (date) => date >= monthDates.firstDate && date <= monthDates.lastDate;
  const unpaidTypeIds = (await LeaveType.find({ isPaid: false }).select('_id').lean()).map((type) => type._id);
  const typeCodeById = new Map(
    (await LeaveType.find({}).select('code').lean()).map((type) => [type._id.toString(), type.code]),
  );

  const figuresByEmployee = new Map();
  const figuresOf = (employeeId) => {
    const key = employeeId.toString();
    if (!figuresByEmployee.has(key))
      figuresByEmployee.set(key, { unpaidCentidays: 0, encashedCentidays: 0, encashments: [] });
    return figuresByEmployee.get(key);
  };

  const unpaidRequests = await LeaveRequest.find({
    status: LEAVE_REQUEST_STATUSES.APPROVED,
    leaveTypeId: { $in: unpaidTypeIds },
    ...overlapsMonth(monthDates),
  })
    .select('employeeId days borderCharges')
    .lean();
  for (const request of unpaidRequests) {
    const charged = [...request.days, ...request.borderCharges]
      .filter((day) => inMonth(day.date))
      .reduce((total, day) => total + day.chargedCentidays, 0);
    if (charged > 0) figuresOf(request.employeeId).unpaidCentidays += charged;
  }

  const encashments = await LeaveLedgerEntry.find({ entryType: LEDGER_ENTRY_TYPES.ENCASHMENT, payrollMonth: month })
    .sort({ createdAt: 1 })
    .lean();
  for (const entry of encashments) {
    const figures = figuresOf(entry.employeeId);
    figures.encashedCentidays -= entry.balanceDeltaCentidays;
    figures.encashments.push({
      leaveTypeCode: typeCodeById.get(entry.leaveTypeId.toString()) ?? null,
      days: centidaysToDays(-entry.balanceDeltaCentidays),
      payrollReference: entry.payrollReference,
    });
  }

  let employeeIds = [...figuresByEmployee.keys()];
  if (changedSince) {
    const changedRequestEmployees = await LeaveRequest.distinct('employeeId', {
      leaveTypeId: { $in: unpaidTypeIds },
      updatedAt: { $gte: changedSince },
      ...overlapsMonth(monthDates),
    });
    const changedEncashmentEmployees = await LeaveLedgerEntry.distinct('employeeId', {
      entryType: LEDGER_ENTRY_TYPES.ENCASHMENT,
      payrollMonth: month,
      createdAt: { $gte: changedSince },
    });
    const changed = new Set([...changedRequestEmployees, ...changedEncashmentEmployees].map(String));
    // An employee whose only unpaid leave was cancelled is listed with zero, so payroll clears it.
    employeeIds = [...changed];
  }

  const peopleById = await contactsOf(employeeIds);
  const employees = employeeIds
    .map((employeeId) => {
      const figures = figuresByEmployee.get(employeeId) ?? {
        unpaidCentidays: 0,
        encashedCentidays: 0,
        encashments: [],
      };
      const person = peopleById.get(employeeId);
      return {
        employeeId,
        name: person?.name ?? null,
        email: person?.email ?? null,
        unpaidDays: centidaysToDays(figures.unpaidCentidays),
        encashedDays: centidaysToDays(figures.encashedCentidays),
        encashments: figures.encashments,
      };
    })
    .sort(
      (first, second) =>
        (first.name ?? '').localeCompare(second.name ?? '') || first.employeeId.localeCompare(second.employeeId),
    );
  return { month, changedSince, employees };
}
