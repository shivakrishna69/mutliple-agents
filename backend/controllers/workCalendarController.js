/**
 * Work calendar endpoints (routes/workCalendarRoutes.js).
 *
 * Who may do what:
 *   HR and admins     change weekly offs and holidays, and read any office's calendar
 *   employees         read the calendar and holidays of their own base office
 *   anyone else       nothing (no employee profile means no work calendar)
 * Every change is audited with ids and outcomes.
 */

import { HTTP_STATUS } from '../constants/httpStatus.js';
import { WORK_CALENDAR_MESSAGES } from '../constants/messages.js';
import {
  WorkCalendarError,
  createHoliday,
  deleteHoliday,
  findOwnOfficeLocationId,
  listHolidays,
  listOfficeCalendars,
  loadOfficeCalendar,
  updateHoliday,
  updateOfficeWeeklyOffs,
} from '../services/workCalendar.js';
import { classifyCalendarRange } from '../services/workingDays.js';
import { isWorkforceAdmin } from '../services/workforceAccess.js';
import { sendCodedError, sendError, sendSuccess } from '../utils/apiResponse.js';
import { AUDIT_OUTCOMES, recordAuditEvent } from '../utils/auditLogger.js';
import { isValidObjectIdString } from '../validators/conversationValidators.js';
import {
  validateCalendarRangeQuery,
  validateHolidayChanges,
  validateHolidayCreation,
  validateHolidayListQuery,
  validateWeeklyOffRulesInput,
} from '../validators/workCalendarValidators.js';

const AUDIT_CATEGORY = 'work_calendar';

function audit(req, action, outcome, details = {}) {
  recordAuditEvent(req, { category: AUDIT_CATEGORY, action, outcome, ...details });
}

/**
 * Runs a work calendar handler: HR-only gate for changes, validation errors as 400, and
 * WorkCalendarError mapped to its status and code. Changes are audited whatever the outcome.
 * @param {string} action  audit action name
 * @param {{ requiresWorkforceAdmin: boolean, isWrite: boolean }} options
 * @param {(req) => Promise<{ validationErrors?: object[], httpStatus?: number, message?: string, data?: object, auditDetails?: object }>} handlerBody
 */
function workCalendarHandler(action, { requiresWorkforceAdmin, isWrite }, handlerBody) {
  return async (req, res, next) => {
    try {
      if (requiresWorkforceAdmin && !isWorkforceAdmin(req.user.role)) {
        if (isWrite) audit(req, action, AUDIT_OUTCOMES.DENIED);
        return sendError(req, res, HTTP_STATUS.FORBIDDEN, WORK_CALENDAR_MESSAGES.RESTRICTED);
      }
      try {
        const handlerResult = await handlerBody(req);
        if (handlerResult.validationErrors) {
          return sendError(
            req,
            res,
            HTTP_STATUS.BAD_REQUEST,
            WORK_CALENDAR_MESSAGES.INPUT_INVALID,
            handlerResult.validationErrors,
          );
        }
        if (isWrite) audit(req, action, AUDIT_OUTCOMES.ALLOWED, handlerResult.auditDetails);
        return sendSuccess(res, handlerResult.httpStatus ?? HTTP_STATUS.OK, handlerResult.message, handlerResult.data);
      } catch (calendarError) {
        if (!(calendarError instanceof WorkCalendarError)) throw calendarError;
        if (isWrite) {
          const outcome =
            calendarError.httpStatus === HTTP_STATUS.FORBIDDEN ? AUDIT_OUTCOMES.DENIED : AUDIT_OUTCOMES.REJECTED;
          audit(req, action, outcome, { reason: calendarError.code });
        }
        return sendCodedError(req, res, calendarError.httpStatus, {
          code: calendarError.code,
          message: calendarError.message,
        });
      }
    } catch (error) {
      return next(error);
    }
  };
}

function paramErrors(params, paramName) {
  return isValidObjectIdString(params[paramName]) ? null : [{ field: paramName, message: 'must be an id' }];
}

/**
 * Which office's calendar the caller may read. HR and admins may name any office (or default to
 * their own); employees always read their own and may not ask for another.
 * @returns {Promise<string|null>} office id, or null for HR asking for "all offices"
 */
async function resolveReadableOffice(req, requestedOfficeId, { allowAllOffices }) {
  if (isWorkforceAdmin(req.user.role)) {
    if (requestedOfficeId || allowAllOffices) return requestedOfficeId;
    const ownOfficeId = await findOwnOfficeLocationId(req.user.id);
    if (!ownOfficeId)
      throw new WorkCalendarError(HTTP_STATUS.BAD_REQUEST, 'OFFICE_REQUIRED', WORK_CALENDAR_MESSAGES.OFFICE_REQUIRED);
    return ownOfficeId;
  }
  const ownOfficeId = await findOwnOfficeLocationId(req.user.id);
  if (!ownOfficeId) {
    throw new WorkCalendarError(HTTP_STATUS.FORBIDDEN, 'EMPLOYEES_ONLY', WORK_CALENDAR_MESSAGES.EMPLOYEES_ONLY);
  }
  if (requestedOfficeId && requestedOfficeId !== ownOfficeId) {
    throw new WorkCalendarError(HTTP_STATUS.FORBIDDEN, 'OTHER_OFFICE', WORK_CALENDAR_MESSAGES.EMPLOYEES_ONLY);
  }
  return ownOfficeId;
}

/** GET /api/work-calendar/offices */
export const getOfficeCalendars = workCalendarHandler(
  'list_office_calendars',
  { requiresWorkforceAdmin: true, isWrite: false },
  async () => ({ message: WORK_CALENDAR_MESSAGES.OFFICES_RETRIEVED, data: { offices: await listOfficeCalendars() } }),
);

/** PATCH /api/work-calendar/offices/:officeLocationId/weekly-offs */
export const patchOfficeWeeklyOffs = workCalendarHandler(
  'update_weekly_offs',
  { requiresWorkforceAdmin: true, isWrite: true },
  async (req) => {
    const invalidParams = paramErrors(req.params, 'officeLocationId');
    if (invalidParams) return { validationErrors: invalidParams };
    const validation = validateWeeklyOffRulesInput(req.body);
    if (!validation.isValid) return validation;
    const office = await updateOfficeWeeklyOffs({
      officeLocationId: req.params.officeLocationId,
      ...validation.sanitizedInput,
    });
    return {
      message: WORK_CALENDAR_MESSAGES.WEEKLY_OFFS_UPDATED,
      data: { office },
      auditDetails: { officeLocationId: office.id },
    };
  },
);

/** GET /api/work-calendar/holidays?year=YYYY[&officeLocationId=] */
export const getHolidays = workCalendarHandler(
  'list_holidays',
  { requiresWorkforceAdmin: false, isWrite: false },
  async (req) => {
    const validation = validateHolidayListQuery(req.query);
    if (!validation.isValid) return validation;
    const { firstDate, lastDate, officeLocationId: requestedOfficeId } = validation.sanitizedInput;
    const officeLocationId = await resolveReadableOffice(req, requestedOfficeId, { allowAllOffices: true });
    const holidays = await listHolidays({ firstDate, lastDate, officeLocationId });
    return { message: WORK_CALENDAR_MESSAGES.HOLIDAYS_RETRIEVED, data: { holidays } };
  },
);

/** POST /api/work-calendar/holidays */
export const postHoliday = workCalendarHandler(
  'create_holiday',
  { requiresWorkforceAdmin: true, isWrite: true },
  async (req) => {
    const validation = validateHolidayCreation(req.body);
    if (!validation.isValid) return validation;
    const holiday = await createHoliday({ ...validation.sanitizedInput, actorUserId: req.user.id });
    return {
      httpStatus: HTTP_STATUS.CREATED,
      message: WORK_CALENDAR_MESSAGES.HOLIDAY_CREATED,
      data: { holiday },
      auditDetails: { holidayId: holiday.id, date: holiday.date },
    };
  },
);

/** PATCH /api/work-calendar/holidays/:holidayId */
export const patchHoliday = workCalendarHandler(
  'update_holiday',
  { requiresWorkforceAdmin: true, isWrite: true },
  async (req) => {
    const invalidParams = paramErrors(req.params, 'holidayId');
    if (invalidParams) return { validationErrors: invalidParams };
    const validation = validateHolidayChanges(req.body);
    if (!validation.isValid) return validation;
    const holiday = await updateHoliday({
      holidayId: req.params.holidayId,
      ...validation.sanitizedInput,
      actorUserId: req.user.id,
    });
    return {
      message: WORK_CALENDAR_MESSAGES.HOLIDAY_UPDATED,
      data: { holiday },
      auditDetails: { holidayId: holiday.id, date: holiday.date },
    };
  },
);

/** DELETE /api/work-calendar/holidays/:holidayId */
export const removeHoliday = workCalendarHandler(
  'delete_holiday',
  { requiresWorkforceAdmin: true, isWrite: true },
  async (req) => {
    const invalidParams = paramErrors(req.params, 'holidayId');
    if (invalidParams) return { validationErrors: invalidParams };
    const holiday = await deleteHoliday({ holidayId: req.params.holidayId });
    return {
      message: WORK_CALENDAR_MESSAGES.HOLIDAY_DELETED,
      data: { holiday },
      auditDetails: { holidayId: holiday.id, date: holiday.date },
    };
  },
);

/** GET /api/work-calendar/days?from=&to=[&officeLocationId=] : each day classified for one office. */
export const getCalendarDays = workCalendarHandler(
  'view_calendar_days',
  { requiresWorkforceAdmin: false, isWrite: false },
  async (req) => {
    const validation = validateCalendarRangeQuery(req.query);
    if (!validation.isValid) return validation;
    const { firstDate, lastDate, officeLocationId: requestedOfficeId } = validation.sanitizedInput;
    const officeLocationId = await resolveReadableOffice(req, requestedOfficeId, { allowAllOffices: false });
    const calendar = await loadOfficeCalendar(officeLocationId, firstDate, lastDate);
    return {
      message: WORK_CALENDAR_MESSAGES.DAYS_RETRIEVED,
      data: {
        office: { id: officeLocationId, name: calendar.office.name, timeZone: calendar.office.timeZone },
        days: classifyCalendarRange(firstDate, lastDate, calendar),
      },
    };
  },
);
