/**
 * Form 16 endpoints (backend/routes/taxRoutes.js, /api/tax). Every function returns the response's
 * `data` object and throws ApiError on failure (api/httpClient.js); the upload takes the session's
 * CSRF token.
 *
 *   GET  /years                              financial years offered, newest first
 *   GET  /ca/employees?fy=&search=&status=   counts and eligible employees (MANAGE_FORM16)
 *   GET  /ca/employees/:employeeId?fy=       CTC, its split, the year's TDS, Form 16 history
 *   POST /ca/employees/:employeeId/form16    multipart: file, financialYear, partType, computationSummary
 *   GET  /my-form16?fy=                      { eligible, documents }
 *   GET  /form16/:documentId/download        a 60-second download link
 */

import { sendApiRequest } from './httpClient.js';
import { toQueryString } from './queryString.js';

async function getData(endpointPath, callerSignal) {
  const { responseData } = await sendApiRequest({ method: 'GET', endpointPath, callerSignal });
  return responseData;
}

const encode = encodeURIComponent;

export const requestForm16Years = (callerSignal) => getData('/api/tax/years', callerSignal);

export const requestCaEmployees = ({ financialYear, search, status }, callerSignal) =>
  getData(`/api/tax/ca/employees${toQueryString({ fy: financialYear, search, status })}`, callerSignal);

export const requestCaEmployee = (employeeId, financialYear, callerSignal) =>
  getData(`/api/tax/ca/employees/${encode(employeeId)}${toQueryString({ fy: financialYear })}`, callerSignal);

/** `computationSummary` is sent only when it has at least one field. */
export async function requestForm16Upload(
  { employeeId, financialYear, partType, computationSummary, file },
  csrfToken,
) {
  const formData = new FormData();
  formData.append('financialYear', financialYear);
  formData.append('partType', partType);
  if (computationSummary && Object.keys(computationSummary).length > 0) {
    formData.append('computationSummary', JSON.stringify(computationSummary));
  }
  formData.append('file', file);
  const { responseData } = await sendApiRequest({
    method: 'POST',
    endpointPath: `/api/tax/ca/employees/${encode(employeeId)}/form16`,
    formData,
    csrfToken,
  });
  return responseData;
}

export const requestMyForm16 = (financialYear, callerSignal) =>
  getData(`/api/tax/my-form16${toQueryString({ fy: financialYear })}`, callerSignal);

export const requestForm16Download = (documentId) => getData(`/api/tax/form16/${encode(documentId)}/download`);
