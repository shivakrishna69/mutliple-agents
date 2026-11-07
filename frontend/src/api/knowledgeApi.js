/**
 * Department knowledge bases: the list a user manages, and one department's agent settings, lead
 * picker and documents. Every function returns the response's `data` (and, for changes, the
 * backend's `message` to show) and throws ApiError on failure (api/httpClient.js). Changes take the
 * CSRF token.
 *
 * Backend references:
 *   GET    /api/knowledge-bases                              the knowledge bases this user manages
 *   GET    /api/departments/:id/agent/settings               PATCH it with { ...changes, version }
 *   GET    /api/departments/:id/agent/lead-candidates?search=
 *   GET    /api/departments/:id/agent/documents              POST a file (multipart "file")
 *   DELETE /api/departments/:id/agent/documents/:docId
 */

import { sendApiRequest } from './httpClient.js';
import { toQueryString } from './queryString.js';

const encode = encodeURIComponent;
const agentPath = (departmentId) => `/api/departments/${encode(departmentId)}/agent`;

async function getData(endpointPath, callerSignal) {
  const { responseData } = await sendApiRequest({ method: 'GET', endpointPath, callerSignal });
  return responseData;
}

export const requestKnowledgeBases = (callerSignal) => getData('/api/knowledge-bases', callerSignal);

export const requestKnowledgeSettings = (departmentId, callerSignal) =>
  getData(`${agentPath(departmentId)}/settings`, callerSignal);

export async function requestKnowledgeSettingsUpdate(departmentId, changesWithVersion, csrfToken) {
  const { responseData, responseMessage } = await sendApiRequest({
    method: 'PATCH',
    endpointPath: `${agentPath(departmentId)}/settings`,
    requestPayload: changesWithVersion,
    csrfToken,
  });
  return { ...responseData, message: responseMessage };
}

export const requestLeadCandidates = (departmentId, search, callerSignal) =>
  getData(`${agentPath(departmentId)}/lead-candidates${toQueryString({ search })}`, callerSignal);

export const requestKnowledgeDocuments = (departmentId, callerSignal) =>
  getData(`${agentPath(departmentId)}/documents`, callerSignal);

export async function requestKnowledgeDocumentUpload(departmentId, file, csrfToken) {
  const formData = new FormData();
  formData.append('file', file);
  const { responseData, responseMessage } = await sendApiRequest({
    method: 'POST',
    endpointPath: `${agentPath(departmentId)}/documents`,
    formData,
    csrfToken,
  });
  return { ...responseData, message: responseMessage };
}

export async function requestKnowledgeDocumentDeletion(departmentId, documentId, csrfToken) {
  const { responseData, responseMessage } = await sendApiRequest({
    method: 'DELETE',
    endpointPath: `${agentPath(departmentId)}/documents/${encode(documentId)}`,
    csrfToken,
  });
  return { ...responseData, message: responseMessage };
}
