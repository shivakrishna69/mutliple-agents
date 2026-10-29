/**
 * Internal leave endpoints for the ai-service's leave assistant (ai-service
 * app/nodes/leave_assistant/), mounted under /api/internal and authenticated by
 * requireInternalApiKey. They only read: the assistant drafts leave, and the employee sends it
 * through the normal form. Each one is scoped to the employee in the path, which the backend
 * itself chose when it called the assistant for the signed-in employee.
 *
 *   GET  /leave/types                                   the active leave types and their rules
 *   GET  /leave/employees/:employeeId/balances          balances (?leaveYear=, default current)
 *   GET  /leave/employees/:employeeId/requests          requests, newest first (?leaveYear=&status=)
 *   GET  /leave/employees/:employeeId/calendar          their office's days (?from=&to=, ≤ 366 days)
 *   POST /leave/employees/:employeeId/preview           what a leave would cost, with the same
 *                                                        policy checks as the form; nothing saved
 *
 * Errors carry the same stable codes as the public leave API (404 EMPLOYEE_NOT_FOUND,
 * 409 OFFICE_NOT_ASSIGNED, 422 TOO_FAR_BACK, ...), so the assistant can explain them.
 */

import { HTTP_STATUS } from '../constants/httpStatus.js';
import { LEAVE_MESSAGES, WORK_CALENDAR_MESSAGES } from '../constants/messages.js';
import { getEmployeeBalances } from '../services/leaveBalances.js';
import { listEmployeeLeaveRequests, previewLeaveRequest } from '../services/leaveRequests.js';
import { loadEmployeeLeaveContext } from '../services/leaveSettings.js';
import { listLeaveTypes } from '../services/leaveTypes.js';
import { ServiceError } from '../services/serviceError.js';
import { loadOfficeCalendar } from '../services/workCalendar.js';
import { classifyCalendarRange } from '../services/workingDays.js';
import { sendCodedError, sendError, sendSuccess } from '../utils/apiResponse.js';
import { validateLeaveRequestInput, validateRequestListQuery } from '../validators/leaveRequestValidators.js';
import { validateLeaveYearQuery } from '../validators/leaveValidators.js';
import { validateCalendarRangeQuery } from '../validators/workCalendarValidators.js';
import { idParamErrors } from './workforceHandler.js';

/** Runs a read for the ai-service: validation errors as 400, ServiceError as its status and code. */
function internalLeaveHandler(handlerBody) {
  return async (req, res, next) => {
    try {
      const invalidParams = req.params.employeeId === undefined ? null : idParamErrors(req.params, 'employeeId');
      if (invalidParams)
        return sendError(req, res, HTTP_STATUS.BAD_REQUEST, LEAVE_MESSAGES.INPUT_INVALID, invalidParams);
      const result = await handlerBody(req);
      if (result.validationErrors) {
        return sendError(req, res, HTTP_STATUS.BAD_REQUEST, LEAVE_MESSAGES.INPUT_INVALID, result.validationErrors);
      }
      return sendSuccess(res, HTTP_STATUS.OK, result.message, result.data);
    } catch (handlerError) {
      if (!(handlerError instanceof ServiceError)) return next(handlerError);
      return sendCodedError(req, res, handlerError.httpStatus, {
        code: handlerError.code,
        message: handlerError.message,
      });
    }
  };
}

/** GET /api/internal/leave/types */
export const getAssistantLeaveTypes = internalLeaveHandler(async () => ({
  message: LEAVE_MESSAGES.TYPES_RETRIEVED,
  data: { leaveTypes: await listLeaveTypes() },
}));

/** GET /api/internal/leave/employees/:employeeId/balances */
export const getAssistantBalances = internalLeaveHandler(async (req) => {
  const validation = validateLeaveYearQuery(req.query);
  if (!validation.isValid) return validation;
  return {
    message: LEAVE_MESSAGES.BALANCES_RETRIEVED,
    data: await getEmployeeBalances({
      employeeId: req.params.employeeId,
      leaveYear: validation.sanitizedInput.leaveYear,
    }),
  };
});

/** GET /api/internal/leave/employees/:employeeId/requests */
export const getAssistantRequests = internalLeaveHandler(async (req) => {
  const validation = validateRequestListQuery(req.query);
  if (!validation.isValid) return validation;
  // Confirms the employee exists, so an unknown id is a 404 rather than an empty list.
  await loadEmployeeLeaveContext(req.params.employeeId);
  return {
    message: LEAVE_MESSAGES.REQUESTS_RETRIEVED,
    data: {
      requests: await listEmployeeLeaveRequests({ employeeId: req.params.employeeId, ...validation.sanitizedInput }),
    },
  };
});

/** GET /api/internal/leave/employees/:employeeId/calendar?from=&to= */
export const getAssistantCalendar = internalLeaveHandler(async (req) => {
  const validation = validateCalendarRangeQuery({ from: req.query.from, to: req.query.to });
  if (!validation.isValid) return validation;
  const { employee } = await loadEmployeeLeaveContext(req.params.employeeId);
  const { officeLocationId } = employee.organizationData;
  if (!officeLocationId) {
    throw new ServiceError(HTTP_STATUS.CONFLICT, 'OFFICE_NOT_ASSIGNED', LEAVE_MESSAGES.OFFICE_NOT_ASSIGNED);
  }
  const { firstDate, lastDate } = validation.sanitizedInput;
  const calendar = await loadOfficeCalendar(officeLocationId, firstDate, lastDate);
  return {
    message: WORK_CALENDAR_MESSAGES.DAYS_RETRIEVED,
    data: {
      office: { name: calendar.office.name, timeZone: calendar.office.timeZone },
      days: classifyCalendarRange(firstDate, lastDate, calendar),
    },
  };
});

/** POST /api/internal/leave/employees/:employeeId/preview */
export const postAssistantPreview = internalLeaveHandler(async (req) => {
  const validation = validateLeaveRequestInput(req.body, { isPreview: true });
  if (!validation.isValid) return validation;
  return {
    message: LEAVE_MESSAGES.REQUEST_PREVIEWED,
    data: {
      preview: await previewLeaveRequest({ employeeId: req.params.employeeId, input: validation.sanitizedInput }),
    },
  };
});
