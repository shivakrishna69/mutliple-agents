/**
 * The NSK assistant's tools: the only way it reads the portal's data. The ai-service calls them
 * through /api/internal/nsk/tools/:tool with the turn's actor token (actorToken.js); each call is
 * checked here, whatever the ai-service was told it may use:
 *
 *   1. the token is genuine, unexpired, and names the person's own session       401 ACTOR_INVALID
 *   2. the account is still active                                                 401 ACTOR_INVALID
 *   3. the tool exists                                                             404 TOOL_NOT_FOUND
 *   4. the person's role has the tool's capability (read now, not from the token) 403 TOOL_FORBIDDEN
 *   5. the arguments are valid                                                     400 with details
 *
 * Then the tool runs for that person only: no tool takes a person as an argument. Each answers
 * { result, source }: `result` is compact JSON for the model (dates as YYYY-MM-DD, shares as whole
 * percentages, amounts in days), `source` the label its citation shows ("Your attendance, 2026-11"),
 * or null for a tool that only finds where to look (knowledge_scope).
 *
 *   my_attendance_today   today's status, punch and office
 *   my_attendance_month   one month day by day (?month=YYYY-MM, default this month, at most
 *                         NSK_BOT_SETTINGS.ATTENDANCE_MONTHS_BACK back), with totals
 *   my_leave_balances     balances in the current leave year
 *   my_leave_requests     requests, newest first (?status=), at most LEAVE_REQUESTS_SHOWN
 *   knowledge_scope       the departments whose knowledge bases the person may read (the department
 *                         agents' audience rules); the ai-service searches only those
 *
 * Attendance and leave tools need an employee record; without one they answer
 * { available: false, reason } so the assistant can say so.
 */

import { CAPABILITIES, hasCapability } from '../../constants/accessRoles.js';
import { HTTP_STATUS } from '../../constants/httpStatus.js';
import { NSK_BOT_MESSAGES } from '../../constants/messages.js';
import { NSK_BOT_SETTINGS } from '../../constants/validation.js';
import ChatSession from '../../models/ChatSession.js';
import EmployeeProfile from '../../models/EmployeeProfile.js';
import { LEAVE_REQUEST_STATUSES } from '../../models/LeaveRequest.js';
import User, { ACCOUNT_STATUSES } from '../../models/User.js';
import { listAvailableAgents } from '../agentChat/agentChatService.js';
import { asClockTime, getOwnAttendanceMonth } from '../attendanceAnalytics.js';
import { readOfficeLocalClock } from '../attendancePolicy.js';
import { getMyAttendanceDay } from '../attendanceToday.js';
import { getCompanySettings } from '../companySettings.js';
import { getEmployeeBalances } from '../leaveBalances.js';
import { listEmployeeLeaveRequests } from '../leaveRequests.js';
import { ServiceError } from '../serviceError.js';
import { verifyActorToken } from './actorToken.js';

export const NSK_TOOLS = Object.freeze({
  MY_ATTENDANCE_TODAY: 'my_attendance_today',
  MY_ATTENDANCE_MONTH: 'my_attendance_month',
  MY_LEAVE_BALANCES: 'my_leave_balances',
  MY_LEAVE_REQUESTS: 'my_leave_requests',
  KNOWLEDGE_SCOPE: 'knowledge_scope',
});

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const LABELS = NSK_BOT_MESSAGES.SOURCE_LABELS;

const refusal = (httpStatus, code, message = NSK_BOT_MESSAGES[code]) => new ServiceError(httpStatus, code, message);
const percent = (share) => (share === null || share === undefined ? null : Math.round(share * 100));
const valid = (sanitizedInput = {}) => ({ isValid: true, sanitizedInput });
const localClockTime = (isoInstant, timeZone) =>
  isoInstant ? asClockTime(readOfficeLocalClock(new Date(isoInstant), timeZone).minutesSinceMidnight) : null;
const invalid = (field, message) => ({ isValid: false, validationErrors: [{ field, message }] });

function noArguments(args) {
  return Object.keys(args).length === 0 ? valid() : invalid(Object.keys(args)[0], 'is not an argument of this tool');
}

function onlyKnownArguments(args, known) {
  const unknown = Object.keys(args).find((name) => !known.includes(name));
  return unknown ? invalid(unknown, 'is not an argument of this tool') : null;
}

/** Months from `month` to `otherMonth` ("YYYY-MM"), positive when otherMonth is later. */
function monthsBetween(month, otherMonth) {
  const [year, monthNumber] = month.split('-').map(Number);
  const [otherYear, otherMonthNumber] = otherMonth.split('-').map(Number);
  return (otherYear - year) * 12 + (otherMonthNumber - monthNumber);
}

// =================================================================================================
// The tools
// =================================================================================================

const TOOL_DEFINITIONS = Object.freeze({
  [NSK_TOOLS.MY_ATTENDANCE_TODAY]: {
    capability: CAPABILITIES.USE_NSK_ASSISTANT,
    needsProfile: true,
    validate: noArguments,
    async run({ actor, now }) {
      const day = await getMyAttendanceDay({ userId: actor.id, now });
      return {
        result: {
          date: day.date,
          time_zone: day.timeZone,
          status: day.status,
          holiday: day.holidayName,
          leave_half: day.leave?.half ?? null,
          office: day.office
            ? { name: day.office.name, shift: `${day.office.shiftStartLocalTime}-${day.office.shiftEndLocalTime}` }
            : null,
          punch: day.punch
            ? {
                arrival: day.punch.arrivalStatus,
                late_by_minutes: day.punch.lateByMinutes ?? null,
                punch_in: localClockTime(day.punch.checkInTime, day.timeZone),
                punch_out: localClockTime(day.punch.checkOutTime, day.timeZone),
                worked_minutes: day.punch.workedMinutes,
                work_mode: day.punch.workMode,
              }
            : null,
        },
        source: LABELS.ATTENDANCE_TODAY(day.date),
      };
    },
  },

  [NSK_TOOLS.MY_ATTENDANCE_MONTH]: {
    capability: CAPABILITIES.USE_NSK_ASSISTANT,
    needsProfile: true,
    validate(args) {
      const unknown = onlyKnownArguments(args, ['month']);
      if (unknown) return unknown;
      if (args.month === undefined || args.month === null) return valid({ month: null });
      return typeof args.month === 'string' && MONTH_PATTERN.test(args.month)
        ? valid({ month: args.month })
        : invalid('month', 'must be YYYY-MM');
    },
    async run({ actor, input, now }) {
      const { timeZone } = await getCompanySettings();
      const currentMonth = readOfficeLocalClock(now, timeZone).calendarDate.slice(0, 7);
      const month = input.month ?? currentMonth;
      const monthsBack = monthsBetween(month, currentMonth);
      if (monthsBack < 0 || monthsBack > NSK_BOT_SETTINGS.ATTENDANCE_MONTHS_BACK) {
        throw new ServiceError(
          HTTP_STATUS.BAD_REQUEST,
          'ATTENDANCE_MONTH_OUT_OF_RANGE',
          NSK_BOT_MESSAGES.ATTENDANCE_MONTH_OUT_OF_RANGE(NSK_BOT_SETTINGS.ATTENDANCE_MONTHS_BACK),
        );
      }
      const own = await getOwnAttendanceMonth({ userId: actor.id, month, now });
      return {
        result: {
          month: own.month,
          time_zone: own.timeZone ?? timeZone,
          joined: own.person !== null,
          days_expected: own.expectedDays,
          days_present: own.presentDays,
          days_late: own.lateDays,
          completion_percent: percent(own.completion),
          days: own.days.map((day) => ({
            date: day.date,
            status: day.status,
            leave_half: day.leave,
            punch_in: day.punchIn,
            punch_out: day.punchOut,
            worked_minutes: day.workedMinutes,
            work_mode: day.workMode,
          })),
        },
        source: LABELS.ATTENDANCE_MONTH(own.month),
      };
    },
  },

  [NSK_TOOLS.MY_LEAVE_BALANCES]: {
    capability: CAPABILITIES.USE_NSK_ASSISTANT,
    needsProfile: true,
    validate: noArguments,
    async run({ profile, now }) {
      const balances = await getEmployeeBalances({ employeeId: profile._id, leaveYear: null, now });
      return {
        result: {
          leave_year: { from: balances.leaveYearRange.firstDate, to: balances.leaveYearRange.lastDate },
          balances: balances.balances.map((balance) => ({
            code: balance.leaveType.code,
            name: balance.leaveType.name,
            paid: balance.leaveType.isPaid,
            available_days: balance.availableDays,
            held_for_pending_requests_days: balance.heldDays,
            balance_days: balance.balanceDays,
          })),
        },
        source: LABELS.LEAVE_BALANCES(balances.leaveYearRange.firstDate, balances.leaveYearRange.lastDate),
      };
    },
  },

  [NSK_TOOLS.MY_LEAVE_REQUESTS]: {
    capability: CAPABILITIES.USE_NSK_ASSISTANT,
    needsProfile: true,
    validate(args) {
      const unknown = onlyKnownArguments(args, ['status']);
      if (unknown) return unknown;
      if (args.status === undefined || args.status === null) return valid({ status: null });
      return Object.values(LEAVE_REQUEST_STATUSES).includes(args.status)
        ? valid({ status: args.status })
        : invalid('status', `must be one of ${Object.values(LEAVE_REQUEST_STATUSES).join(', ')}`);
    },
    async run({ profile, input }) {
      const requests = await listEmployeeLeaveRequests({ employeeId: profile._id, status: input.status });
      const shown = requests.slice(0, NSK_BOT_SETTINGS.LEAVE_REQUESTS_SHOWN);
      return {
        result: {
          requests: shown.map((request) => ({
            type: request.leaveType.code,
            type_name: request.leaveType.name,
            start_date: request.startDate,
            start_day_portion: request.startDayPortion,
            end_date: request.endDate,
            end_day_portion: request.endDayPortion,
            days: request.totalDays,
            status: request.status,
            reason: request.reason,
            change_waiting: request.pendingChange?.kind ?? null,
          })),
          more_not_shown: requests.length - shown.length,
        },
        source: LABELS.LEAVE_REQUESTS,
      };
    },
  },

  [NSK_TOOLS.KNOWLEDGE_SCOPE]: {
    capability: CAPABILITIES.USE_NSK_ASSISTANT,
    needsProfile: false,
    validate: noArguments,
    async run({ actor }) {
      const departments = await readableKnowledgeDepartments(actor);
      return { result: { departments }, source: null };
    },
  },
});

/** The departments whose knowledge bases this person may read: { id, name }, by name. */
export async function readableKnowledgeDepartments(actor) {
  if (!hasCapability(actor.role, CAPABILITIES.ASK_DEPARTMENT_AGENTS)) return [];
  const agents = await listAvailableAgents(actor);
  return agents.map(({ department }) => ({ id: department.id, name: department.name }));
}

/** The tools `role` may call, by name: sent with each turn so the model is only offered those. */
export function toolsAvailableTo(role) {
  return Object.entries(TOOL_DEFINITIONS)
    .filter(([, definition]) => hasCapability(role, definition.capability))
    .map(([name]) => name);
}

/** The person a token acts for, read now; refuses a forged or expired token or an inactive account. */
async function loadActor(key, token, now) {
  const claims = verifyActorToken({ key, token, now });
  if (!claims) throw refusal(HTTP_STATUS.UNAUTHORIZED, 'ACTOR_INVALID');
  const [user, ownsSession] = await Promise.all([
    User.findById(claims.userId).select('name role status').lean(),
    ChatSession.exists({ _id: claims.sessionId, userId: claims.userId }),
  ]);
  if (!user || user.status !== ACCOUNT_STATUSES.ACTIVE || !ownsSession) {
    throw refusal(HTTP_STATUS.UNAUTHORIZED, 'ACTOR_INVALID');
  }
  return { id: user._id.toString(), name: user.name, role: user.role, sessionId: claims.sessionId };
}

/**
 * Runs one tool call from the ai-service.
 * @param {{ key: Buffer, token: unknown, toolName: string, args: object, now?: Date }} call
 * @returns {Promise<{ validationErrors: object[] } | { actor: object, result: object, source: string|null }>}
 * @throws {ServiceError} 401 / 403 / 404 as listed above; the tool's own refusals
 */
export async function runNskTool({ key, token, toolName, args, now = new Date() }) {
  const actor = await loadActor(key, token, now);
  const definition = Object.hasOwn(TOOL_DEFINITIONS, toolName) ? TOOL_DEFINITIONS[toolName] : null;
  if (!definition) throw refusal(HTTP_STATUS.NOT_FOUND, 'TOOL_NOT_FOUND');
  if (!hasCapability(actor.role, definition.capability)) {
    const forbidden = refusal(HTTP_STATUS.FORBIDDEN, 'TOOL_FORBIDDEN');
    forbidden.actor = actor;
    throw forbidden;
  }
  const validation = definition.validate(args);
  if (!validation.isValid) return { validationErrors: validation.validationErrors };
  let profile = null;
  if (definition.needsProfile) {
    profile = await EmployeeProfile.findOne({ userId: actor.id }).select('_id').lean();
    if (!profile) {
      return {
        actor,
        result: { available: false, reason: NSK_BOT_MESSAGES.NO_EMPLOYEE_PROFILE },
        source: null,
      };
    }
  }
  const { result, source } = await definition.run({ actor, profile, input: validation.sanitizedInput, now });
  return { actor, result, source };
}
