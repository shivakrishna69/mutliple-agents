/**
 * The attendance and leave audit of someone leaving: an .xlsx workbook (exceljs) over the
 * OFFBOARDING_SETTINGS.AUDIT_MONTHS months up to their last working day (or up to today, when that day
 * is still ahead), for HR's records and the settlement.
 *
 *   Summary               the person, the period, and the totals: working days, present, late, half
 *                         days, no attendance recorded, weekly offs and holidays, hours worked,
 *                         regularized days, and leave taken by type (approved), pending and other
 *   Daily Attendance Log  every calendar day: its kind (working day, weekly off, holiday), the status,
 *                         punch in and out in the office's time zone, hours, work mode, minutes late,
 *                         regularization, and the approved or pending leave on that day with its type,
 *                         full or half day and reason
 *   Leave Breakdown       every leave day recorded in the period, whatever became of the request
 *                         (approved, pending, rejected, cancelled): the type, full day or which half,
 *                         days charged, the status, the reason given, the request's range, when it was
 *                         applied for and decided
 *
 * loadAttendanceAudit reads the records; buildAttendanceAuditWorkbook is pure (the model in, the
 * file's bytes out), so it is tested without a database.
 */

import ExcelJS from 'exceljs';
import { DAY_KINDS, DAY_PORTIONS } from '../../../constants/calendarDays.js';
import { OFFBOARDING_SETTINGS } from '../../../constants/validation.js';
import Attendance, { ATTENDANCE_STATUSES } from '../../../models/Attendance.js';
import LeaveRequest, { LEAVE_REQUEST_STATUSES } from '../../../models/LeaveRequest.js';
import LeaveType from '../../../models/LeaveType.js';
import { DEFAULT_WEEKLY_OFF_RULES } from '../../../models/OfficeLocation.js';
import { addDaysToCalendarDate, listCalendarDates, weekdayOfCalendarDate } from '../../../utils/calendarDates.js';
import { loadOfficeCalendar } from '../../workCalendar.js';
import { classifyCalendarDay } from '../../workingDays.js';

export const AUDIT_SHEETS = Object.freeze({
  SUMMARY: 'Summary',
  DAILY_LOG: 'Daily Attendance Log',
  LEAVE_BREAKDOWN: 'Leave Breakdown',
});

const WEEKDAY_NAMES = Object.freeze(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']);
const DAY_KIND_LABELS = Object.freeze({
  [DAY_KINDS.WORKING]: 'Working day',
  [DAY_KINDS.WEEKLY_OFF]: 'Weekly off',
  [DAY_KINDS.HOLIDAY]: 'Holiday',
});
const ATTENDANCE_STATUS_LABELS = Object.freeze({
  [ATTENDANCE_STATUSES.NORMAL]: 'Present',
  [ATTENDANCE_STATUSES.LATE]: 'Present (late)',
  [ATTENDANCE_STATUSES.HALF_DAY]: 'Half day',
  [ATTENDANCE_STATUSES.ABSENT]: 'Absent',
});
export const PORTION_LABELS = Object.freeze({
  [DAY_PORTIONS.FULL]: 'Full day',
  [DAY_PORTIONS.FIRST_HALF]: 'First half',
  [DAY_PORTIONS.SECOND_HALF]: 'Second half',
});
const LEAVE_STATUS_LABELS = Object.freeze({
  [LEAVE_REQUEST_STATUSES.APPROVED]: 'Approved',
  [LEAVE_REQUEST_STATUSES.PENDING]: 'Pending',
  [LEAVE_REQUEST_STATUSES.REJECTED]: 'Rejected',
  [LEAVE_REQUEST_STATUSES.CANCELLED]: 'Cancelled',
});
const STATUS_TEXT = Object.freeze({
  ON_LEAVE: 'On leave',
  HALF_DAY_LEAVE: 'Half-day leave',
  NO_RECORD: 'No attendance recorded',
});
const SANDWICH_LABEL = 'Non-working day charged (sandwich rule)';
// Statuses whose leave shows on the daily log; rejected and cancelled leave is in the breakdown only.
const LOGGED_LEAVE_STATUSES = Object.freeze([LEAVE_REQUEST_STATUSES.APPROVED, LEAVE_REQUEST_STATUSES.PENDING]);

const centidaysToDays = (centidays) => Math.round(centidays) / 100;
const hours = (minutes) => (minutes === null || minutes === undefined ? null : Math.round((minutes / 60) * 100) / 100);

function clockIn(timeZone) {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  return (instant) => (instant ? formatter.format(new Date(instant)) : null);
}

/** `calendarDate` minus whole months, the day clamped to the month's last day. */
function monthsBefore(calendarDate, monthCount) {
  const [year, month, day] = calendarDate.split('-').map(Number);
  const target = new Date(Date.UTC(year, month - 1 - monthCount, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}

/** The audit period: AUDIT_MONTHS months ending on the last working day, or today when that is earlier. */
export function auditPeriod(lastWorkingDay, today) {
  const lastDate = lastWorkingDay < today ? lastWorkingDay : today;
  const firstDate = addDaysToCalendarDate(monthsBefore(lastDate, OFFBOARDING_SETTINGS.AUDIT_MONTHS), 1);
  return { firstDate, lastDate };
}

/** Which part of a request's day is leave: its first or last day may be a half. */
export function portionOf(request, date, chargedCentidays) {
  if (date === request.startDate && request.startDayPortion !== DAY_PORTIONS.FULL) return request.startDayPortion;
  if (date === request.endDate && request.endDayPortion !== DAY_PORTIONS.FULL) return request.endDayPortion;
  return chargedCentidays > 0 && chargedCentidays < 100 ? DAY_PORTIONS.FIRST_HALF : DAY_PORTIONS.FULL;
}

/** One row per leave day of each request inside the period (the sandwich days included). */
export function leaveDaysOf(requests, leaveTypeById, period) {
  const inPeriod = (date) => date >= period.firstDate && date <= period.lastDate;
  const rows = [];
  for (const request of requests) {
    const leaveType = leaveTypeById.get(request.leaveTypeId.toString()) ?? { code: '—', name: '—' };
    const common = {
      leaveCode: leaveType.code,
      leaveName: leaveType.name,
      status: request.status,
      reason: request.reason,
      requestFrom: request.startDate,
      requestTo: request.endDate,
      appliedOn: request.createdAt ?? null,
      decidedOn: request.decision?.at ?? request.cancellation?.at ?? null,
    };
    for (const day of request.days ?? []) {
      if (day.chargedCentidays <= 0 || !inPeriod(day.date)) continue;
      rows.push({
        ...common,
        date: day.date,
        portion: portionOf(request, day.date, day.chargedCentidays),
        days: centidaysToDays(day.chargedCentidays),
        sandwich: false,
      });
    }
    for (const border of request.borderCharges ?? []) {
      if (border.chargedCentidays <= 0 || !inPeriod(border.date)) continue;
      rows.push({
        ...common,
        date: border.date,
        portion: DAY_PORTIONS.FULL,
        days: centidaysToDays(border.chargedCentidays),
        sandwich: true,
      });
    }
  }
  return rows.sort(
    (first, second) => first.date.localeCompare(second.date) || first.leaveCode.localeCompare(second.leaveCode),
  );
}

/** Every calendar day of the period with its attendance and its approved or pending leave. */
export function dailyLogOf({ period, calendar, attendance, leaveDays }) {
  const recordByDate = new Map(attendance.map((record) => [record.date, record]));
  const leaveByDate = new Map();
  for (const leaveDay of leaveDays) {
    if (!LOGGED_LEAVE_STATUSES.includes(leaveDay.status)) continue;
    const known = leaveByDate.get(leaveDay.date);
    // Approved leave wins over a pending request for the same day.
    if (!known || leaveDay.status === LEAVE_REQUEST_STATUSES.APPROVED) leaveByDate.set(leaveDay.date, leaveDay);
  }
  return listCalendarDates(period.firstDate, period.lastDate).map((date) => {
    const { kind, holidayName } = classifyCalendarDay(date, calendar);
    const record = recordByDate.get(date) ?? null;
    const leave = leaveByDate.get(date) ?? null;
    let status = null;
    if (record) status = ATTENDANCE_STATUS_LABELS[record.calculationStatus] ?? record.calculationStatus;
    else if (leave?.status === LEAVE_REQUEST_STATUSES.APPROVED) {
      status = leave.portion === DAY_PORTIONS.FULL ? STATUS_TEXT.ON_LEAVE : STATUS_TEXT.HALF_DAY_LEAVE;
    } else if (kind === DAY_KINDS.WORKING) status = STATUS_TEXT.NO_RECORD;
    const toClock = record ? clockIn(record.timeZone) : null;
    return {
      date,
      weekday: WEEKDAY_NAMES[weekdayOfCalendarDate(date)],
      kind,
      holidayName,
      status,
      attendanceStatus: record?.calculationStatus ?? null,
      punchIn: toClock ? toClock(record.checkInTime) : null,
      punchOut: toClock ? toClock(record.checkOutTime) : null,
      workedMinutes: record?.workedMinutes ?? null,
      workMode: record?.workMode ?? null,
      lateByMinutes: record?.lateByMinutes ?? 0,
      regularized: Boolean(record?.regularization),
      regularizationReason: record?.regularization?.reason ?? null,
      leave,
    };
  });
}

/** The Summary sheet's totals. */
export function summaryOf({ days, leaveDays }) {
  const count = (test) => days.filter(test).length;
  const present = days.filter((day) =>
    [ATTENDANCE_STATUSES.NORMAL, ATTENDANCE_STATUSES.LATE, ATTENDANCE_STATUSES.HALF_DAY].includes(day.attendanceStatus),
  );
  const workedMinutes = present.reduce((sum, day) => sum + (day.workedMinutes ?? 0), 0);
  const byStatus = (status) => leaveDays.filter((day) => day.status === status);
  const approvedByType = new Map();
  for (const day of byStatus(LEAVE_REQUEST_STATUSES.APPROVED)) {
    const key = `${day.leaveName} (${day.leaveCode})`;
    approvedByType.set(key, Math.round(((approvedByType.get(key) ?? 0) + day.days) * 100) / 100);
  }
  const daysOf = (rows) => Math.round(rows.reduce((sum, day) => sum + day.days, 0) * 100) / 100;
  return {
    calendarDays: days.length,
    workingDays: count((day) => day.kind === DAY_KINDS.WORKING),
    weeklyOffs: count((day) => day.kind === DAY_KINDS.WEEKLY_OFF),
    holidays: count((day) => day.kind === DAY_KINDS.HOLIDAY),
    present: present.length,
    late: count((day) => day.attendanceStatus === ATTENDANCE_STATUSES.LATE),
    halfDays: count((day) => day.attendanceStatus === ATTENDANCE_STATUSES.HALF_DAY),
    absent: count((day) => day.attendanceStatus === ATTENDANCE_STATUSES.ABSENT),
    noRecord: count((day) => day.status === STATUS_TEXT.NO_RECORD),
    regularized: count((day) => day.regularized),
    hoursWorked: hours(workedMinutes) ?? 0,
    averageHoursPerPresentDay: present.length ? hours(workedMinutes / present.length) : 0,
    leaveTakenDays: daysOf(byStatus(LEAVE_REQUEST_STATUSES.APPROVED)),
    leaveTakenByType: [...approvedByType.entries()].map(([type, total]) => ({ type, days: total })),
    leavePendingDays: daysOf(byStatus(LEAVE_REQUEST_STATUSES.PENDING)),
    leaveRejectedOrCancelledDays: daysOf(
      leaveDays.filter((day) =>
        [LEAVE_REQUEST_STATUSES.REJECTED, LEAVE_REQUEST_STATUSES.CANCELLED].includes(day.status),
      ),
    ),
  };
}

/**
 * Reads what the audit needs.
 * @param {{ profile: object, snapshot: object, lastWorkingDay: string, today: string }} input
 */
export async function loadAttendanceAudit({ profile, snapshot, lastWorkingDay, today }) {
  const period = auditPeriod(lastWorkingDay, today);
  const officeId = profile.organizationData.officeLocationId;
  const [attendance, requests, calendar] = await Promise.all([
    Attendance.find({ employeeId: profile._id, date: { $gte: period.firstDate, $lte: period.lastDate } })
      .select(
        'date timeZone checkInTime checkOutTime workedMinutes workMode calculationStatus lateByMinutes regularization',
      )
      .lean(),
    LeaveRequest.find({
      employeeId: profile._id,
      startDate: { $lte: period.lastDate },
      endDate: { $gte: period.firstDate },
    })
      .select(
        'leaveTypeId startDate startDayPortion endDate endDayPortion days borderCharges status reason decision.at cancellation.at createdAt',
      )
      .lean(),
    officeId
      ? loadOfficeCalendar(officeId, period.firstDate, period.lastDate)
      : { weeklyOffRules: DEFAULT_WEEKLY_OFF_RULES, holidaysByDate: new Map() },
  ]);
  const leaveTypes = await LeaveType.find({ _id: { $in: requests.map((request) => request.leaveTypeId) } })
    .select('code name')
    .lean();
  const leaveTypeById = new Map(leaveTypes.map((leaveType) => [leaveType._id.toString(), leaveType]));
  const leaveDays = leaveDaysOf(requests, leaveTypeById, period);
  const days = dailyLogOf({ period, calendar, attendance, leaveDays });
  return { employee: snapshot, period, days, leaveDays, summary: summaryOf({ days, leaveDays }) };
}

// =================================================================================================
// The workbook
// =================================================================================================

const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } };

function addTable(sheet, columns, rows) {
  sheet.columns = columns.map(({ header, key, width }) => ({ header, key, width }));
  const header = sheet.getRow(1);
  header.font = { bold: true };
  header.fill = HEADER_FILL;
  header.alignment = { vertical: 'middle', wrapText: true };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  for (const row of rows) sheet.addRow(row);
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
}

function addSummarySheet(workbook, { employee, period, summary, companyName, generatedAt }) {
  const sheet = workbook.addWorksheet(AUDIT_SHEETS.SUMMARY);
  sheet.columns = [
    { header: 'Item', key: 'item', width: 38 },
    { header: 'Value', key: 'value', width: 44 },
  ];
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).fill = HEADER_FILL;
  const rows = [
    ['Company', companyName],
    ['Employee', employee.name],
    ['Employee ID', employee.employeeCode],
    ['Designation', employee.designation],
    ['Department', employee.departmentName ?? '—'],
    ['Office', employee.officeName ?? '—'],
    ['Period from', period.firstDate],
    ['Period to', period.lastDate],
    ['Generated at (UTC)', generatedAt.toISOString().replace('T', ' ').slice(0, 16)],
    [null, null],
    ['Calendar days', summary.calendarDays],
    ['Working days', summary.workingDays],
    ['Weekly offs', summary.weeklyOffs],
    ['Holidays', summary.holidays],
    ['Days present (including late and half days)', summary.present],
    ['Late arrivals', summary.late],
    ['Half days', summary.halfDays],
    ['Marked absent', summary.absent],
    ['Working days with no attendance recorded', summary.noRecord],
    ['Regularized days', summary.regularized],
    ['Hours worked', summary.hoursWorked],
    ['Average hours per day present', summary.averageHoursPerPresentDay],
    [null, null],
    ['Leave taken (approved, days)', summary.leaveTakenDays],
    ...summary.leaveTakenByType.map(({ type, days }) => [`  ${type}`, days]),
    ['Leave pending approval (days)', summary.leavePendingDays],
    ['Leave rejected or cancelled (days)', summary.leaveRejectedOrCancelledDays],
  ];
  for (const [item, value] of rows) sheet.addRow({ item, value });
}

function addDailySheet(workbook, days) {
  const sheet = workbook.addWorksheet(AUDIT_SHEETS.DAILY_LOG);
  addTable(
    sheet,
    [
      { header: 'Date', key: 'date', width: 12 },
      { header: 'Weekday', key: 'weekday', width: 11 },
      { header: 'Day type', key: 'dayType', width: 22 },
      { header: 'Status', key: 'status', width: 24 },
      { header: 'Punch in', key: 'punchIn', width: 10 },
      { header: 'Punch out', key: 'punchOut', width: 10 },
      { header: 'Hours worked', key: 'hours', width: 12 },
      { header: 'Work mode', key: 'workMode', width: 11 },
      { header: 'Late by (minutes)', key: 'late', width: 12 },
      { header: 'Regularized', key: 'regularized', width: 12 },
      { header: 'Regularization reason', key: 'regularizationReason', width: 32 },
      { header: 'Leave type', key: 'leaveType', width: 22 },
      { header: 'Leave: full or half day', key: 'leavePortion', width: 16 },
      { header: 'Leave status', key: 'leaveStatus', width: 12 },
      { header: 'Leave reason', key: 'leaveReason', width: 40 },
    ],
    days.map((day) => ({
      date: day.date,
      weekday: day.weekday,
      dayType: day.holidayName ? `${DAY_KIND_LABELS[day.kind]}: ${day.holidayName}` : DAY_KIND_LABELS[day.kind],
      status: day.status ?? '',
      punchIn: day.punchIn ?? '',
      punchOut: day.punchOut ?? '',
      hours: hours(day.workedMinutes) ?? '',
      workMode: day.workMode ?? '',
      late: day.lateByMinutes || '',
      regularized: day.regularized ? 'Yes' : '',
      regularizationReason: day.regularizationReason ?? '',
      leaveType: day.leave ? `${day.leave.leaveName} (${day.leave.leaveCode})` : '',
      leavePortion: day.leave ? PORTION_LABELS[day.leave.portion] : '',
      leaveStatus: day.leave ? LEAVE_STATUS_LABELS[day.leave.status] : '',
      leaveReason: day.leave?.reason ?? '',
    })),
  );
}

function addLeaveSheet(workbook, leaveDays) {
  const sheet = workbook.addWorksheet(AUDIT_SHEETS.LEAVE_BREAKDOWN);
  const asDate = (instant) => (instant ? new Date(instant).toISOString().slice(0, 10) : '');
  addTable(
    sheet,
    [
      { header: 'Date', key: 'date', width: 12 },
      { header: 'Weekday', key: 'weekday', width: 11 },
      { header: 'Leave type', key: 'leaveType', width: 22 },
      { header: 'Code', key: 'code', width: 8 },
      { header: 'Full or half day', key: 'portion', width: 16 },
      { header: 'Days charged', key: 'days', width: 12 },
      { header: 'Status', key: 'status', width: 12 },
      { header: 'Reason', key: 'reason', width: 44 },
      { header: 'Request from', key: 'from', width: 12 },
      { header: 'Request to', key: 'to', width: 12 },
      { header: 'Applied on', key: 'appliedOn', width: 12 },
      { header: 'Decided on', key: 'decidedOn', width: 12 },
      { header: 'Note', key: 'note', width: 36 },
    ],
    leaveDays.map((day) => ({
      date: day.date,
      weekday: WEEKDAY_NAMES[weekdayOfCalendarDate(day.date)],
      leaveType: day.leaveName,
      code: day.leaveCode,
      portion: PORTION_LABELS[day.portion],
      days: day.days,
      status: LEAVE_STATUS_LABELS[day.status] ?? day.status,
      reason: day.reason,
      from: day.requestFrom,
      to: day.requestTo,
      appliedOn: asDate(day.appliedOn),
      decidedOn: asDate(day.decidedOn),
      note: day.sandwich ? SANDWICH_LABEL : '',
    })),
  );
}

/**
 * @param {{ employee: object, period: { firstDate: string, lastDate: string }, days: object[],
 *   leaveDays: object[], summary: object }} audit  loadAttendanceAudit's result
 * @param {{ companyName: string, generatedAt: Date }} context
 * @returns {Promise<Buffer>} the .xlsx bytes
 */
export async function buildAttendanceAuditWorkbook(audit, { companyName, generatedAt }) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = companyName;
  workbook.created = generatedAt;
  workbook.modified = generatedAt;
  addSummarySheet(workbook, { ...audit, companyName, generatedAt });
  addDailySheet(workbook, audit.days);
  addLeaveSheet(workbook, audit.leaveDays);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
