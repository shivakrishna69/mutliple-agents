/**
 * Workplace endpoints: offices (with their weekly offs), holidays, the day-by-day work calendar,
 * and the employee list HR picks from. Every function returns the response's `data` object and
 * throws ApiError on failure (api/httpClient.js). State-changing calls take the CSRF token.
 *
 * Backend references (backend/routes/*):
 *   /api/offices        offices: location, time zone, shift, weekly offs (HR, admins)
 *   /api/employees      current employees; set an employee's base office (HR, admins)
 *   /api/work-calendar  holidays (HR, admins edit) and each day as working / weekly off / holiday
 */

import { sendApiRequest } from './httpClient.js';
import { toQueryString } from './queryString.js';

const encode = encodeURIComponent;

async function getData(endpointPath, callerSignal) {
  const { responseData } = await sendApiRequest({ method: 'GET', endpointPath, callerSignal });
  return responseData;
}

async function sendData(method, endpointPath, requestPayload, csrfToken) {
  const { responseData } = await sendApiRequest({ method, endpointPath, requestPayload, csrfToken });
  return responseData;
}

// --- Offices --------------------------------------------------------------------------------------
export const requestOffices = (callerSignal) => getData('/api/offices', callerSignal);
export const requestOfficeCreation = (officeInput, csrfToken) =>
  sendData('POST', '/api/offices', officeInput, csrfToken);
export const requestOfficeUpdate = (officeId, changesWithVersion, csrfToken) =>
  sendData('PATCH', `/api/offices/${encode(officeId)}`, changesWithVersion, csrfToken);
export const requestOfficeDeletion = (officeId, csrfToken) =>
  sendData('DELETE', `/api/offices/${encode(officeId)}`, undefined, csrfToken);

// --- Employees ------------------------------------------------------------------------------------
export const requestEmployees = (callerSignal) => getData('/api/employees', callerSignal);
export const requestEmployeeOfficeAssignment = (employeeId, officeLocationId, csrfToken) =>
  sendData('PUT', `/api/employees/${encode(employeeId)}/office`, { officeLocationId }, csrfToken);

// --- Work calendar --------------------------------------------------------------------------------
export const requestHolidays = ({ year, officeLocationId }, callerSignal) =>
  getData(`/api/work-calendar/holidays${toQueryString({ year, officeLocationId })}`, callerSignal);
export const requestHolidayCreation = (holidayInput, csrfToken) =>
  sendData('POST', '/api/work-calendar/holidays', holidayInput, csrfToken);
export const requestHolidayUpdate = (holidayId, changesWithVersion, csrfToken) =>
  sendData('PATCH', `/api/work-calendar/holidays/${encode(holidayId)}`, changesWithVersion, csrfToken);
export const requestHolidayDeletion = (holidayId, csrfToken) =>
  sendData('DELETE', `/api/work-calendar/holidays/${encode(holidayId)}`, undefined, csrfToken);
export const requestCalendarDays = ({ from, to, officeLocationId }, callerSignal) =>
  getData(`/api/work-calendar/days${toQueryString({ from, to, officeLocationId })}`, callerSignal);
