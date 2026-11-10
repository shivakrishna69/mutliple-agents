/**
 * Asking department agents, their conversations and feedback. Every function returns the response's
 * `data` (and, for changes, the backend's `message`), and throws ApiError on failure
 * (api/httpClient.js). Changes take the CSRF token.
 *
 * Backend references (backend/controllers/agentChatController.js):
 *   GET    /api/departments/agents/available
 *   POST   /api/departments/:id/agent/chat                   { question, conversationId?, stream: true }
 *   GET    /api/departments/:id/agent/conversations[/:conversationId]
 *   DELETE /api/departments/:id/agent/conversations[/:conversationId]
 *   POST   /api/departments/:id/agent/feedback               { messageId, rating, comment? }
 */

import { sendApiRequest, streamApiRequest } from './httpClient.js';

const encode = encodeURIComponent;
const agentPath = (departmentId) => `/api/departments/${encode(departmentId)}/agent`;

async function getData(endpointPath, callerSignal) {
  const { responseData } = await sendApiRequest({ method: 'GET', endpointPath, callerSignal });
  return responseData;
}

async function change(method, endpointPath, requestPayload, csrfToken) {
  const { responseData, responseMessage } = await sendApiRequest({ method, endpointPath, requestPayload, csrfToken });
  return { ...responseData, message: responseMessage };
}

export const requestAvailableAgents = (callerSignal) => getData('/api/departments/agents/available', callerSignal);

export const requestAgentConversations = (departmentId, callerSignal) =>
  getData(`${agentPath(departmentId)}/conversations`, callerSignal);

export const requestAgentConversation = (departmentId, conversationId, callerSignal) =>
  getData(`${agentPath(departmentId)}/conversations/${encode(conversationId)}`, callerSignal);

export const requestAgentConversationDeletion = (departmentId, conversationId, csrfToken) =>
  change('DELETE', `${agentPath(departmentId)}/conversations/${encode(conversationId)}`, undefined, csrfToken);

export const requestAgentConversationsClear = (departmentId, csrfToken) =>
  change('DELETE', `${agentPath(departmentId)}/conversations`, undefined, csrfToken);

/**
 * Rates an answer. Resolves to { ratedMessage, escalated, notice }: the answer as stored now, whether
 * its question went to the department, and the backend's text to show.
 */
export async function requestAnswerFeedback(departmentId, feedback, csrfToken) {
  const { responseData, responseMessage } = await sendApiRequest({
    method: 'POST',
    endpointPath: `${agentPath(departmentId)}/feedback`,
    requestPayload: feedback,
    csrfToken,
  });
  return { ratedMessage: responseData.message, escalated: responseData.escalated, notice: responseMessage };
}

/**
 * Asks the agent, streamed: onEvent receives { type: started | delta | final | error, ... } as each
 * arrives (constants/agentChat.js STREAM_EVENTS). Refusals before the question is stored throw.
 */
export const streamAgentQuestion = ({ departmentId, question, conversationId, csrfToken, callerSignal, onEvent }) =>
  streamApiRequest({
    endpointPath: `${agentPath(departmentId)}/chat`,
    requestPayload: { question, ...(conversationId ? { conversationId } : {}), stream: true },
    csrfToken,
    callerSignal,
    onEvent,
  });
