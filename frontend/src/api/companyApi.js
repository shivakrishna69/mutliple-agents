/**
 * The company and its departments. Every function returns the response's `data` object and throws
 * ApiError on failure (api/httpClient.js). State-changing calls take the CSRF token.
 *
 * Backend references (backend/routes/*):
 *   /api/company/settings  name, short code, mail domain, colours, time zone (HR reads, admins change)
 *   /api/departments       departments with head counts (HR, admins)
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

// --- Company settings -----------------------------------------------------------------------------
// Public: name, logo, support email and terms links for the sign-in pages.
export const requestCompanyBranding = (callerSignal) => getData('/api/company/branding', callerSignal);
export const requestCompanySettings = (callerSignal) => getData('/api/company/settings', callerSignal);
export const requestCompanySettingsUpdate = (changesWithVersion, csrfToken) =>
  sendData('PATCH', '/api/company/settings', changesWithVersion, csrfToken);

// --- Departments ----------------------------------------------------------------------------------
export const requestDepartments = ({ includeInactive = false } = {}, callerSignal) =>
  getData(`/api/departments${toQueryString({ includeInactive: includeInactive || undefined })}`, callerSignal);
export const requestDepartmentCreation = (departmentInput, csrfToken) =>
  sendData('POST', '/api/departments', departmentInput, csrfToken);
export const requestDepartmentUpdate = (departmentId, changesWithVersion, csrfToken) =>
  sendData('PATCH', `/api/departments/${encode(departmentId)}`, changesWithVersion, csrfToken);
export const requestDepartmentDeletion = (departmentId, csrfToken) =>
  sendData('DELETE', `/api/departments/${encode(departmentId)}`, undefined, csrfToken);
