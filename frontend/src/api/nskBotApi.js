/**
 * The NSK assistant and offboarding. Every function returns the response's `data` (and, for changes,
 * the backend's `message`), and throws ApiError on failure (api/httpClient.js). Changes take the CSRF
 * token.
 *
 * Backend references (backend/controllers/nskBotController.js, controllers/offboardingController.js):
 *   GET    /api/nsk-bot/sessions[/:sessionId]
 *   DELETE /api/nsk-bot/sessions/:sessionId
 *   POST   /api/nsk-bot/message                      { message, sessionId? }
 *   POST   /api/nsk-bot/offboarding/preview          { employeeId, separation, adjustments, version? }
 *   POST   /api/nsk-bot/offboarding/execute          { caseId, version }
 *   GET    /api/nsk-bot/offboarding/cases[/:caseId]
 *   DELETE /api/nsk-bot/offboarding/cases/:caseId?version=
 *   GET    /api/nsk-bot/offboarding/it-checklist
 *   GET    /api/nsk-bot/artifacts/:artifactId/download
 */

import { sendApiRequest } from './httpClient.js';

const encode = encodeURIComponent;

async function getData(endpointPath, callerSignal) {
  const { responseData } = await sendApiRequest({ method: 'GET', endpointPath, callerSignal });
  return responseData;
}

async function change(method, endpointPath, requestPayload, csrfToken) {
  const { responseData, responseMessage } = await sendApiRequest({ method, endpointPath, requestPayload, csrfToken });
  return { ...responseData, message: responseMessage };
}

export const requestNskSessions = (callerSignal) => getData('/api/nsk-bot/sessions', callerSignal);

export const requestNskSession = (sessionId, callerSignal) =>
  getData(`/api/nsk-bot/sessions/${encode(sessionId)}`, callerSignal);

export const requestNskSessionDeletion = (sessionId, csrfToken) =>
  change('DELETE', `/api/nsk-bot/sessions/${encode(sessionId)}`, undefined, csrfToken);

/**
 * One turn: resolves to { session, userMessage, message } as the backend sent them (`message` is the
 * reply, so the response's own status text is not merged in).
 */
export async function sendNskMessage({ message, sessionId }, csrfToken) {
  const { responseData } = await sendApiRequest({
    method: 'POST',
    endpointPath: '/api/nsk-bot/message',
    requestPayload: { message, ...(sessionId ? { sessionId } : {}) },
    csrfToken,
  });
  return responseData;
}

export const requestOffboardingPreview = (preview, csrfToken) =>
  change('POST', '/api/nsk-bot/offboarding/preview', preview, csrfToken);

export const requestOffboardingExecution = ({ caseId, version }, csrfToken) =>
  change('POST', '/api/nsk-bot/offboarding/execute', { caseId, version }, csrfToken);

export const requestOffboardingCases = (callerSignal) => getData('/api/nsk-bot/offboarding/cases', callerSignal);

export const requestOffboardingCase = (caseId, callerSignal) =>
  getData(`/api/nsk-bot/offboarding/cases/${encode(caseId)}`, callerSignal);

export const requestOffboardingCancellation = ({ caseId, version }, csrfToken) =>
  change('DELETE', `/api/nsk-bot/offboarding/cases/${encode(caseId)}?version=${encode(version)}`, undefined, csrfToken);

export const requestItChecklist = (callerSignal) => getData('/api/nsk-bot/offboarding/it-checklist', callerSignal);

/** A 60-second download link for one document: resolves to { download: { url, fileName, ... }, kind }. */
export const requestArtifactDownload = (artifactId) => getData(`/api/nsk-bot/artifacts/${encode(artifactId)}/download`);
