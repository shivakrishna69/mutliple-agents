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
