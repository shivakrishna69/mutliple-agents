/**
 * Work calendar endpoints (routes/workCalendarRoutes.js). Offices and their weekly offs are
 * managed through controllers/officeController.js.
 *
 * Who may do what:
 *   HR and admins     change holidays, and read any office's calendar
 *   employees         read the calendar and holidays of their own base office
 *   anyone else       nothing (no employee profile means no work calendar)
 * Every change is audited with ids and outcomes.
 */

import { HTTP_STATUS } from '../constants/httpStatus.js';
import { WORK_CALENDAR_MESSAGES } from '../constants/messages.js';
import { ServiceError } from '../services/serviceError.js';
import {
  createHoliday,
  deleteHoliday,
  findOwnOfficeAssignment,
  listHolidays,
  loadOfficeCalendar,
  updateHoliday,
} from '../services/workCalendar.js';
import { classifyCalendarRange } from '../services/workingDays.js';
import { isWorkforceAdmin } from '../services/workforceAccess.js';
import {
  validateCalendarRangeQuery,
  validateHolidayChanges,
  validateHolidayCreation,
  validateHolidayListQuery,
} from '../validators/workCalendarValidators.js';
import { createWorkforceHandlerFactory, idParamErrors } from './workforceHandler.js';

const workCalendarHandler = createWorkforceHandlerFactory({
  auditCategory: 'work_calendar',
  restrictedMessage: WORK_CALENDAR_MESSAGES.RESTRICTED,
  inputInvalidMessage: WORK_CALENDAR_MESSAGES.INPUT_INVALID,
});

/**
 * Which office's calendar the caller may read. HR and admins may name any office (or default to
 * their own); employees always read their own and may not ask for another.
 * @returns {Promise<string|null>} office id, or null for HR asking for "all offices"
 */
async function resolveReadableOffice(req, requestedOfficeId, { allowAllOffices }) {
  const isAdmin = isWorkforceAdmin(req.user.role);
  if (isAdmin && (requestedOfficeId || allowAllOffices)) return requestedOfficeId;
  const { hasEmployeeProfile, officeLocationId } = await findOwnOfficeAssignment(req.user.id);
  if (isAdmin) {
    if (!officeLocationId) {
      throw new ServiceError(HTTP_STATUS.BAD_REQUEST, 'OFFICE_REQUIRED', WORK_CALENDAR_MESSAGES.OFFICE_REQUIRED);
    }
    return officeLocationId;
  }
  if (!hasEmployeeProfile) {
    throw new ServiceError(HTTP_STATUS.FORBIDDEN, 'EMPLOYEES_ONLY', WORK_CALENDAR_MESSAGES.EMPLOYEES_ONLY);
  }
  if (!officeLocationId) {
    throw new ServiceError(HTTP_STATUS.CONFLICT, 'OFFICE_NOT_ASSIGNED', WORK_CALENDAR_MESSAGES.OFFICE_NOT_ASSIGNED);
  }
  if (requestedOfficeId && requestedOfficeId !== officeLocationId) {
    throw new ServiceError(HTTP_STATUS.FORBIDDEN, 'OTHER_OFFICE', WORK_CALENDAR_MESSAGES.EMPLOYEES_ONLY);
  }
  return officeLocationId;
}

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
    const invalidParams = idParamErrors(req.params, 'holidayId');
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
    const invalidParams = idParamErrors(req.params, 'holidayId');
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
