/**
 * Conversation endpoints (backend/routes/conversationRoutes.js). Responses use the same payload
 * shapes as the Socket.IO events, so the console merges HTTP results and live updates directly.
 * Transport, CSRF header, and error mapping live in api/httpClient.js; failures reject with
 * ApiError.
 */

import { API_MESSAGES } from '../constants/messages.js';
import { ApiError, sendApiRequest } from './httpClient.js';

const CONVERSATIONS_PATH = '/api/conversations';

function conversationPath(conversationId, suffix = '') {
  return `${CONVERSATIONS_PATH}/${encodeURIComponent(conversationId)}${suffix}`;
}

/** Returns `responseData[fieldName]` after checking it has the expected type. */
function requireField({ responseData, httpStatus }, fieldName, isExpectedShape) {
  const fieldValue = responseData?.[fieldName];
  if (!isExpectedShape(fieldValue)) {
    throw new ApiError({ message: API_MESSAGES.UNEXPECTED_RESPONSE, status: httpStatus });
  }
  return fieldValue;
}

const isObject = (candidateValue) => typeof candidateValue === 'object' && candidateValue !== null && !Array.isArray(candidateValue);

/** Conversations visible to the signed-in user, most recent activity first. */
export async function requestConversationList({ signal } = {}) {
  const apiResponse = await sendApiRequest({ method: 'GET', endpointPath: CONVERSATIONS_PATH, callerSignal: signal });
  return requireField(apiResponse, 'conversations', Array.isArray);
}

/** One conversation's details, including the customer's public profile for staff. */
export async function requestConversationDetails(conversationId, { signal } = {}) {
  const apiResponse = await sendApiRequest({ method: 'GET', endpointPath: conversationPath(conversationId), callerSignal: signal });
  return requireField(apiResponse, 'conversation', isObject);
}

/** The conversation's most recent messages, oldest first. */
export async function requestConversationMessages(conversationId, { signal } = {}) {
  const apiResponse = await sendApiRequest({ method: 'GET', endpointPath: conversationPath(conversationId, '/messages'), callerSignal: signal });
  return requireField(apiResponse, 'messages', Array.isArray);
}

/** Staff: assign a waiting conversation to the caller. Resolves to the updated details. */
export async function requestClaimConversation(conversationId, csrfToken) {
  const apiResponse = await sendApiRequest({ method: 'POST', endpointPath: conversationPath(conversationId, '/claim'), requestPayload: {}, csrfToken });
  return requireField(apiResponse, 'conversation', isObject);
}

/** Staff: hand the conversation back to the human queue. Resolves to the updated details. */
export async function requestReleaseConversation(conversationId, csrfToken) {
  const apiResponse = await sendApiRequest({ method: 'POST', endpointPath: conversationPath(conversationId, '/release'), requestPayload: {}, csrfToken });
  return requireField(apiResponse, 'conversation', isObject);
}

/** Staff: send a reply as the assigned human agent. Resolves to the stored message payload. */
export async function requestSendAgentMessage(conversationId, messageText, csrfToken) {
  const apiResponse = await sendApiRequest({
    method: 'POST',
    endpointPath: conversationPath(conversationId, '/messages'),
    requestPayload: { text: messageText },
    csrfToken,
  });
  return requireField(apiResponse, 'message', isObject);
}
