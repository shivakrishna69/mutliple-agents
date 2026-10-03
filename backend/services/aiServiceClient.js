/**
 * HTTP client for the Python ai-service: POST {AI_SERVICE_URL}/ai/process.
 *
 * Request contract (sent by this backend):
 *   {
 *     "conversation": { "id": string, "status": "processing-ai", "currentActiveWorker": string },
 *     "customer":     { "id": string },
 *     "history":      [ { "messageId", "senderType", "text", "createdAt" } ],  // oldest first,
 *                                                                              // excludes newMessage
 *     "newMessage":   { "messageId", "senderType": "customer", "text", "createdAt" }
 *   }
 *   Headers: X-Internal-Api-Key (AI_SERVICE_API_KEY), X-Request-Id (for cross-service tracing).
 *
 * Response contract (expected from the ai-service, HTTP 200):
 *   {
 *     "reply":     { "text": string (1–20,000 chars), "senderType": "ai_supervisor" | "ai_worker" },
 *     "nextState": { "action": "continue", "activeWorker": "supervisor" | "billing_agent" | "tech_agent" }
 *                | { "action": "escalate" },
 *     "toolExecutionLogs": [ ... ]   // optional; same shape as Message.toolExecutionLogs
 *   }
 *
 * Failure classification (thrown as AiServiceError, `failureKind`):
 *   timeout           no complete response within AI_SERVICE_TIMEOUT_MS (hard total deadline,
 *                     not just socket idle time, so a slowly trickling response is cut off too)
 *   unavailable       connection refused, DNS failure, connection reset
 *   error_response    the service answered with a non-2xx status
 *   invalid_response  2xx, but the body does not match the response contract
 * The caller turns every kind into the same customer-safe fallback.
 */

import axios from 'axios';
import { AI_WORKERS } from '../models/Conversation.js';
import { SENDER_TYPE } from '../models/Message.js';
import { MESSAGE_FIELD_LIMITS } from '../constants/validation.js';

export const AI_PROCESS_PATH = '/ai/process';

export const AI_FAILURE_KIND = Object.freeze({
  TIMEOUT: 'timeout',
  UNAVAILABLE: 'unavailable',
  ERROR_RESPONSE: 'error_response',
  INVALID_RESPONSE: 'invalid_response',
});

export const AI_NEXT_ACTION = Object.freeze({
  CONTINUE: 'continue',
  ESCALATE: 'escalate',
});

/** Upper bounds that keep a misbehaving ai-service from exhausting backend memory. */
const MAX_AI_RESPONSE_BYTES = 1024 * 1024;
const MAX_TOOL_EXECUTION_LOG_ENTRIES = 100;

const AI_REPLY_SENDER_TYPES = Object.freeze([SENDER_TYPE.AI_SUPERVISOR, SENDER_TYPE.AI_WORKER]);

/** A failed call to the ai-service. `detail` is for logs only and is never shown to customers. */
export class AiServiceError extends Error {
  constructor(failureKind, detail, { httpStatus = null, durationMs = null } = {}) {
    super(`AI service ${failureKind}: ${detail}`);
    this.name = 'AiServiceError';
    this.failureKind = failureKind;
    this.detail = detail;
    this.httpStatus = httpStatus;
    this.durationMs = durationMs;
  }
}

function isPlainObject(candidateValue) {
  return typeof candidateValue === 'object' && candidateValue !== null && !Array.isArray(candidateValue);
}

/**
 * Checks a response body against the response contract and returns a normalised copy that
 * contains only the contract's fields. Throws AiServiceError(invalid_response) on any deviation,
 * naming the first offending field.
 */
function parseAiServiceResponse(responseBody) {
  const rejectResponse = (detail) => {
    throw new AiServiceError(AI_FAILURE_KIND.INVALID_RESPONSE, detail);
  };

  if (!isPlainObject(responseBody)) rejectResponse('body is not a JSON object');

  const { reply: rawReply, nextState: rawNextState, toolExecutionLogs: rawToolExecutionLogs } = responseBody;

  if (!isPlainObject(rawReply)) rejectResponse('reply is missing or not an object');
  if (typeof rawReply.text !== 'string') rejectResponse('reply.text is not a string');
  const replyText = rawReply.text.trim();
  if (replyText.length === 0) rejectResponse('reply.text is empty');
  if (replyText.length > MESSAGE_FIELD_LIMITS.TEXT_MAX_LENGTH) rejectResponse('reply.text is too long');
  if (!AI_REPLY_SENDER_TYPES.includes(rawReply.senderType)) rejectResponse('reply.senderType is not an AI sender type');

  if (!isPlainObject(rawNextState)) rejectResponse('nextState is missing or not an object');
  let nextState;
  if (rawNextState.action === AI_NEXT_ACTION.ESCALATE) {
    nextState = { action: AI_NEXT_ACTION.ESCALATE };
  } else if (rawNextState.action === AI_NEXT_ACTION.CONTINUE) {
    if (!AI_WORKERS.includes(rawNextState.activeWorker)) rejectResponse('nextState.activeWorker is not an AI worker');
    nextState = { action: AI_NEXT_ACTION.CONTINUE, activeWorker: rawNextState.activeWorker };
  } else {
    rejectResponse('nextState.action is not "continue" or "escalate"');
  }

  let toolExecutionLogs = [];
  if (rawToolExecutionLogs !== undefined && rawToolExecutionLogs !== null) {
    if (!Array.isArray(rawToolExecutionLogs)) rejectResponse('toolExecutionLogs is not an array');
    if (rawToolExecutionLogs.length > MAX_TOOL_EXECUTION_LOG_ENTRIES) rejectResponse('toolExecutionLogs has too many entries');
    if (!rawToolExecutionLogs.every(isPlainObject)) rejectResponse('toolExecutionLogs contains a non-object entry');
    // Field-level checks (types, enums, required fields) are applied by the Message schema
    // when the reply is validated before saving.
    toolExecutionLogs = rawToolExecutionLogs;
  }

  return { reply: { text: replyText, senderType: rawReply.senderType }, nextState, toolExecutionLogs };
}

/**
 * Sends a conversation to the ai-service and returns its parsed decision.
 * @param {object} aiProcessRequest  Body as described in the request contract above.
 * @param {object} callContext
 * @param {{ aiServiceUrl: string, aiServiceTimeoutMs: number, aiServiceApiKey: string }} callContext.config
 * @param {string} callContext.requestId  Propagated as X-Request-Id.
 * @returns {Promise<{ reply: { text: string, senderType: string },
 *                     nextState: { action: string, activeWorker?: string },
 *                     toolExecutionLogs: object[], durationMs: number }>}
 * @throws {AiServiceError}
 */
export async function requestAiProcessing(aiProcessRequest, { config, requestId }) {
  const startedAtMs = Date.now();
  // AbortSignal.timeout is a hard deadline for the whole exchange; axios's own `timeout` only
  // measures socket inactivity in Node, which a slowly trickling response would never trip.
  const deadlineSignal = AbortSignal.timeout(config.aiServiceTimeoutMs);

  let aiServiceResponse;
  try {
    aiServiceResponse = await axios.post(`${config.aiServiceUrl}${AI_PROCESS_PATH}`, aiProcessRequest, {
      timeout: config.aiServiceTimeoutMs,
      signal: deadlineSignal,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Internal-Api-Key': config.aiServiceApiKey,
        'X-Request-Id': requestId,
      },
      responseType: 'json',
      maxContentLength: MAX_AI_RESPONSE_BYTES,
      maxBodyLength: MAX_AI_RESPONSE_BYTES,
      // An internal service never needs to redirect; following one could leak the API key.
      maxRedirects: 0,
      transitional: { clarifyTimeoutError: true },
    });
  } catch (requestError) {
    const durationMs = Date.now() - startedAtMs;
    if (deadlineSignal.aborted || requestError.code === 'ETIMEDOUT' || requestError.code === 'ECONNABORTED') {
      throw new AiServiceError(AI_FAILURE_KIND.TIMEOUT, `no response within ${config.aiServiceTimeoutMs} ms`, { durationMs });
    }
    if (requestError.response) {
      throw new AiServiceError(AI_FAILURE_KIND.ERROR_RESPONSE, `HTTP ${requestError.response.status}`, {
        httpStatus: requestError.response.status,
        durationMs,
      });
    }
    throw new AiServiceError(AI_FAILURE_KIND.UNAVAILABLE, requestError.code ?? requestError.message, { durationMs });
  }

  const durationMs = Date.now() - startedAtMs;
  try {
    return { ...parseAiServiceResponse(aiServiceResponse.data), durationMs };
  } catch (parseError) {
    if (parseError instanceof AiServiceError) parseError.durationMs = durationMs;
    throw parseError;
  }
}
