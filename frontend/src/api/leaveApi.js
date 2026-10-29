/**
 * Leave endpoints (backend routes/leaveRoutes.js). Every function returns the response's `data`
 * object and throws ApiError on failure (api/httpClient.js). State-changing calls take the CSRF
 * token. Amounts are in days.
 *
 *   settings, types           everyone reads; HR and admins change (send the version loaded)
 *   balances, ledger          own (employees) or any employee's (HR and admins)
 *   adjustments, encashments  HR and admins, never on their own balance
 *   jobs                      HR and admins: accruals and year ends now; reconciliation
 *   payroll export            HR and admins: unpaid and encashed days for a month
 *   requests                  employees price, ask for, cancel and change their own leave; the
 *                             reporting manager or HR decides (queues under /approvals)
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

// --- Settings and types ---------------------------------------------------------------------------
export const requestLeaveSettings = (callerSignal) => getData('/api/leave/settings', callerSignal);
export const requestLeaveSettingsUpdate = (changesWithVersion, csrfToken) =>
  sendData('PATCH', '/api/leave/settings', changesWithVersion, csrfToken);
export const requestLeaveTypes = ({ includeInactive = false } = {}, callerSignal) =>
  getData(`/api/leave/types${toQueryString({ includeInactive: includeInactive || undefined })}`, callerSignal);
export const requestLeaveTypeCreation = (leaveTypeInput, csrfToken) =>
  sendData('POST', '/api/leave/types', leaveTypeInput, csrfToken);
export const requestLeaveTypeUpdate = (leaveTypeId, changesWithVersion, csrfToken) =>
  sendData('PATCH', `/api/leave/types/${encode(leaveTypeId)}`, changesWithVersion, csrfToken);

// --- Balances and ledger --------------------------------------------------------------------------
export const requestEmployeeLeaveBalances = ({ employeeId, leaveYear }, callerSignal) =>
  getData(`/api/leave/employees/${encode(employeeId)}/balances${toQueryString({ leaveYear })}`, callerSignal);
export const requestEmployeeLeaveLedger = ({ employeeId, leaveYear, leaveTypeId }, callerSignal) =>
  getData(
    `/api/leave/employees/${encode(employeeId)}/ledger${toQueryString({ leaveYear, leaveTypeId })}`,
    callerSignal,
  );

// --- HR movements ---------------------------------------------------------------------------------
export const requestLeaveAdjustment = (adjustmentInput, csrfToken) =>
  sendData('POST', '/api/leave/adjustments', adjustmentInput, csrfToken);
export const requestLeaveEncashment = (encashmentInput, csrfToken) =>
  sendData('POST', '/api/leave/encashments', encashmentInput, csrfToken);

// --- Jobs and payroll -----------------------------------------------------------------------------
export const requestLeaveJobRun = (asOfDate, csrfToken) =>
  sendData('POST', '/api/leave/jobs/accrual', asOfDate ? { asOfDate } : {}, csrfToken);
export const requestLeaveReconciliation = (csrfToken) => sendData('POST', '/api/leave/jobs/reconcile', {}, csrfToken);
export const requestLeavePayrollExport = ({ month, changedSince }, callerSignal) =>
  getData(`/api/leave/payroll-export${toQueryString({ month, changedSince })}`, callerSignal);

// --- Own leave ------------------------------------------------------------------------------------
const requestPath = (requestId, action = '') => `/api/leave/requests/${encode(requestId)}${action}`;

export const requestOwnLeaveBalances = (leaveYear, callerSignal) =>
  getData(`/api/leave/balances${toQueryString({ leaveYear })}`, callerSignal);
export const requestOwnLeaveRequests = ({ leaveYear, status } = {}, callerSignal) =>
  getData(`/api/leave/requests${toQueryString({ leaveYear, status })}`, callerSignal);
/** Prices a leave without saving it; a POST, so it carries the CSRF token, and can be aborted. */
export async function requestLeavePreview(requestInput, csrfToken, callerSignal) {
  const { responseData } = await sendApiRequest({
    method: 'POST',
    endpointPath: '/api/leave/requests/preview',
    requestPayload: requestInput,
    csrfToken,
    callerSignal,
  });
  return responseData;
}
export const requestLeaveSubmission = (requestInput, csrfToken) =>
  sendData('POST', '/api/leave/requests', requestInput, csrfToken);
export const requestLeaveCancellation = (requestId, csrfToken) =>
  sendData('POST', requestPath(requestId, '/cancel'), {}, csrfToken);
export const requestLeaveChange = (requestId, changeInput, csrfToken) =>
  sendData('POST', requestPath(requestId, '/change'), changeInput, csrfToken);

// --- Decisions ------------------------------------------------------------------------------------
export const requestApprovalQueue = (queue, callerSignal) =>
  getData(`/api/leave/approvals${toQueryString({ queue })}`, callerSignal);
// `step` names the approval step being decided, so a step someone has just decided is refused.
export const requestLeaveApproval = (requestId, { note, step }, csrfToken) =>
  sendData(
    'POST',
    requestPath(requestId, '/approve'),
    { ...(note ? { note } : {}), ...(step ? { step } : {}) },
    csrfToken,
  );
export const requestLeaveRejection = (requestId, { note, step }, csrfToken) =>
  sendData('POST', requestPath(requestId, '/reject'), { note, ...(step ? { step } : {}) }, csrfToken);
export const requestLeaveChangeDecision = (requestId, { isApproved, note }, csrfToken) =>
  sendData(
    'POST',
    requestPath(requestId, '/change/decision'),
    note ? { approve: isApproved, note } : { approve: isApproved },
    csrfToken,
  );

// --- Leave assistant ------------------------------------------------------------------------------
/** One question with the recent conversation; answers { reply, draft } (a draft is never sent). */
export const requestLeaveAssistant = ({ message, history }, csrfToken) =>
  sendData('POST', '/api/leave/assistant', { message, history }, csrfToken);
