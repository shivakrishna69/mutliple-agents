/**
 * Customer web chat endpoint (backend/routes/supportRoutes.js). Transport, CSRF header, and error
 * mapping live in api/httpClient.js; failures reject with ApiError.
 */

import { API_MESSAGES } from '../constants/messages.js';
import { ApiError, sendApiRequest } from './httpClient.js';

/**
 * Sends the customer's message into the support pipeline and waits for the AI's reply (if the AI
 * is handling the conversation). `clientMessageId` makes a retry of the same message safe.
 * Resolves to { outcome, conversation: { id, status } | null, customerMessageId, reply | null }.
 */
export async function requestSendSupportMessage(messageText, clientMessageId, csrfToken) {
  const { responseData, httpStatus } = await sendApiRequest({
    method: 'POST',
    endpointPath: '/api/support/messages',
    requestPayload: { text: messageText, clientMessageId },
    csrfToken,
  });
  if (typeof responseData?.customerMessageId !== 'string' || typeof responseData?.outcome !== 'string') {
    throw new ApiError({ message: API_MESSAGES.UNEXPECTED_RESPONSE, status: httpStatus });
  }
  return responseData;
}
