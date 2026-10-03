/**
 * Workforce endpoints: attendance, organisation, payroll, analytics, OKRs and the document vault.
 * Every function returns the response's `data` object and throws ApiError on failure
 * (api/httpClient.js). State-changing calls take the session's CSRF token.
 *
 * Backend references (backend/routes/*):
 *   /api/attendance  punch-in, AI regularization, manager reviews
 *   /api/org         hierarchy and reporting lines (staff only)
 *   /api/payroll     tax rules and estimates, payslips, public payslip verification
 *   /api/analytics   workforce risk (HR and admins)
 *   /api/okrs        alignment canvas, objectives, key results, milestones
 *   /api/vault       employee documents (upload, list, signed download, verification)
 */

import { sendApiRequest } from './httpClient.js';

async function getData(endpointPath, callerSignal) {
  const { responseData } = await sendApiRequest({ method: 'GET', endpointPath, callerSignal });
  return responseData;
}

async function sendData(method, endpointPath, requestPayload, csrfToken) {
  const { responseData } = await sendApiRequest({ method, endpointPath, requestPayload, csrfToken });
  return responseData;
}

function toQueryString(queryParameters) {
  const searchParameters = new URLSearchParams();
  for (const [parameterName, parameterValue] of Object.entries(queryParameters)) {
    if (parameterValue !== undefined && parameterValue !== null && parameterValue !== '') searchParameters.set(parameterName, String(parameterValue));
  }
  const queryString = searchParameters.toString();
  return queryString ? `?${queryString}` : '';
}

const encode = encodeURIComponent;

// --- Attendance -----------------------------------------------------------------------------------
export const requestPunchIn = (punchInInput, csrfToken) => sendData('POST', '/api/attendance/punch-in', punchInInput, csrfToken);
export const requestRegularization = ({ message, startNew }, csrfToken) => sendData('POST', '/api/attendance/regularize', { message, startNew }, csrfToken);
export const requestRegularizationReviews = (status, callerSignal) => getData(`/api/attendance/regularization-reviews${toQueryString({ status })}`, callerSignal);
export const requestReviewDecision = (reviewId, decisionInput, csrfToken) =>
  sendData('POST', `/api/attendance/regularization-reviews/${encode(reviewId)}/decision`, decisionInput, csrfToken);

// --- Organisation ---------------------------------------------------------------------------------
export const requestOrgHierarchy = (callerSignal) => getData('/api/org/hierarchy', callerSignal);
export const requestManagerReports = (managerId, callerSignal) => getData(`/api/org/manager/${encode(managerId)}`, callerSignal);

// --- Payroll --------------------------------------------------------------------------------------
export const requestPayrollRules = (callerSignal) => getData('/api/payroll/rules', callerSignal);
export const requestTaxEstimate = (estimateInput, csrfToken) => sendData('POST', '/api/payroll/tax-estimate', estimateInput, csrfToken);
export const requestPayslipList = (filters, callerSignal) => getData(`/api/payroll/payslips${toQueryString(filters)}`, callerSignal);
export const requestPayslipGeneration = (payslipInput, csrfToken) => sendData('POST', '/api/payroll/payslips', payslipInput, csrfToken);
export const requestPayslipDownload = (payslipId) => getData(`/api/payroll/payslips/${encode(payslipId)}/download`);
export const requestPayslipVerification = (verificationId, callerSignal) => getData(`/api/payroll/payslips/verify/${encode(verificationId)}`, callerSignal);

// --- Workforce analytics --------------------------------------------------------------------------
export const requestWorkforceRisk = (filters, callerSignal) => getData(`/api/analytics/workforce-risk${toQueryString(filters)}`, callerSignal);

// --- OKRs -----------------------------------------------------------------------------------------
export const requestOkrAlignment = ({ year, quarter }, callerSignal) => getData(`/api/okrs/alignment${toQueryString({ year, quarter })}`, callerSignal);
export const requestObjectiveCreation = (objectiveInput, csrfToken) => sendData('POST', '/api/okrs/objectives', objectiveInput, csrfToken);
export const requestObjectiveUpdate = (objectiveId, changes, csrfToken) => sendData('PATCH', `/api/okrs/objectives/${encode(objectiveId)}`, changes, csrfToken);
export const requestKeyResultCreation = (objectiveId, keyResultInput, csrfToken) =>
  sendData('POST', `/api/okrs/objectives/${encode(objectiveId)}/key-results`, keyResultInput, csrfToken);
export const requestKeyResultProgress = (keyResultId, progressInput, csrfToken) =>
  sendData('PATCH', `/api/okrs/key-results/${encode(keyResultId)}/progress`, progressInput, csrfToken);
export const requestMilestoneCreation = (keyResultId, milestoneInput, csrfToken) =>
  sendData('POST', `/api/okrs/key-results/${encode(keyResultId)}/milestones`, milestoneInput, csrfToken);
export const requestMilestoneUpdate = (keyResultId, milestoneId, changes, csrfToken) =>
  sendData('PATCH', `/api/okrs/key-results/${encode(keyResultId)}/milestones/${encode(milestoneId)}`, changes, csrfToken);

// --- Document vault -------------------------------------------------------------------------------
/** `employeeId` may be "me" for the signed-in employee's own documents. */
export const requestEmployeeDocuments = (employeeId, callerSignal) => getData(`/api/vault/employees/${encode(employeeId)}/documents`, callerSignal);
export const requestDocumentDownload = (documentId) => getData(`/api/vault/download/${encode(documentId)}`);
export const requestDocumentVerification = (documentId, csrfToken) => sendData('PATCH', `/api/vault/documents/${encode(documentId)}/verify`, undefined, csrfToken);
export async function requestDocumentUpload({ file, employeeId, documentType, accessibleRoles }, csrfToken) {
  const formData = new FormData();
  formData.append('employeeId', employeeId);
  formData.append('documentType', documentType);
  if (accessibleRoles?.length) formData.append('accessibleRoles', accessibleRoles.join(','));
  formData.append('file', file);
  const { responseData } = await sendApiRequest({ method: 'POST', endpointPath: '/api/vault/documents', formData, csrfToken });
  return responseData;
}
