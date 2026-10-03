/**
 * HTTP client for the Python ai-service: POST {AI_SERVICE_URL}/ai/process.
 * The contract is defined by ai-service/app/schemas.py; this module is its backend counterpart.
 *
 * Request (ConversationInput), built by `buildConversationInput`:
 *   {
 *     "conversation_id": string,
 *     "thread_id":       string,             // = conversation_id: one checkpointer thread per conversation
 *     "messages": [ { "message_id": string, "role": "user" | "assistant", "content": string } ]
 *   }
 *   Oldest first; the last entry is the customer message being answered. Roles: customer -> user;
 *   AI workers and human agents (everyone answering for the company) -> assistant. `message_id` is
 *   the MongoDB message id, which lets the ai-service merge re-sent history instead of duplicating it.
 *   Headers: X-Internal-Api-Key (AI_SERVICE_API_KEY), X-Request-Id (for cross-service tracing).
 *
 * Response (AIProcessResponse, HTTP 200):
 *   {
 *     "conversation_id":  string,   // must equal the request's
 *     "response_content": string,   // 1–20,000 chars, the reply shown to the customer
 *     "next_worker":      "supervisor" | "billing_agent" | "tech_agent" | "human",
 *     "internal_logs":    [ string ]   // this turn's audit trail, entries "<node>: <event>"
 *   }
 *
 * Translation into this backend's domain (returned by `requestAiProcessing`):
 *   next_worker "human"                -> nextState { action: escalate }
 *   any other next_worker              -> nextState { action: continue, activeWorker: next_worker }
 *   billing_agent / tech_agent replies -> senderType ai_worker; supervisor / human -> ai_supervisor
 *   internal_logs[i] "<node>: <event>" -> toolExecutionLogs[i] { step: i+1, node, output: event,
 *                                          status: success, startedAt: request start }
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
import { SENDER_TYPE, TOOL_STEP_STATUS } from '../models/Message.js';
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
const MAX_INTERNAL_LOG_ENTRIES = 200;
const MAX_INTERNAL_LOG_ENTRY_LENGTH = 2_000;

/** Worker value that means "hand the conversation to a human agent". */
const HUMAN_WORKER = 'human';
const RESPONSE_NEXT_WORKERS = Object.freeze([...AI_WORKERS, HUMAN_WORKER]);
const WORKERS_REPLYING_AS_SPECIALIST = Object.freeze(['billing_agent', 'tech_agent']);

/** "<node>: <event>" — node is a lowercase identifier such as supervisor or tech_agent. */
const INTERNAL_LOG_ENTRY_PATTERN = /^([a-z_]{1,64}): ([\s\S]+)$/;
const UNATTRIBUTED_LOG_NODE = 'ai_service';

/** Who the AI is answering on behalf of: the customer is "user", everyone else "assistant". */
const CHAT_ROLE_BY_SENDER_TYPE = Object.freeze({
  [SENDER_TYPE.CUSTOMER]: 'user',
  [SENDER_TYPE.AI_SUPERVISOR]: 'assistant',
  [SENDER_TYPE.AI_WORKER]: 'assistant',
  [SENDER_TYPE.HUMAN_AGENT]: 'assistant',
});

/**
 * Builds the ConversationInput body from stored messages (oldest first, ending with the customer
 * message to answer). Messages with empty text (AI audit entries without a reply) are skipped,
 * because the ai-service requires non-empty content.
 * @param {string} conversationId
 * @param {Array<{ _id: unknown, senderType: string, text: string }>} transcriptMessages
 */
export function buildConversationInput(conversationId, transcriptMessages) {
  return {
    conversation_id: conversationId,
    thread_id: conversationId,
    messages: transcriptMessages
      .filter((transcriptMessage) => typeof transcriptMessage.text === 'string' && transcriptMessage.text.trim().length > 0)
      .map((transcriptMessage) => ({
        message_id: transcriptMessage._id.toString(),
        role: CHAT_ROLE_BY_SENDER_TYPE[transcriptMessage.senderType],
        content: transcriptMessage.text,
      })),
  };
}

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
 * Checks a response body against AIProcessResponse and translates it into this backend's domain
 * (see the module comment). Throws AiServiceError(invalid_response) on any deviation, naming the
 * first offending field.
 * @param {unknown} responseBody
 * @param {string} expectedConversationId  The conversation_id that was sent.
 * @param {Date} requestStartedAt  Used as startedAt for the audit entries.
 */
function parseAiServiceResponse(responseBody, expectedConversationId, requestStartedAt) {
  const rejectResponse = (detail) => {
    throw new AiServiceError(AI_FAILURE_KIND.INVALID_RESPONSE, detail);
  };

  if (!isPlainObject(responseBody)) rejectResponse('body is not a JSON object');
  const {
    conversation_id: responseConversationId,
    response_content: rawResponseContent,
    next_worker: nextWorker,
    internal_logs: rawInternalLogs,
  } = responseBody;

  if (responseConversationId !== expectedConversationId) rejectResponse('conversation_id does not match the request');

  if (typeof rawResponseContent !== 'string') rejectResponse('response_content is not a string');
  const replyText = rawResponseContent.trim();
  if (replyText.length === 0) rejectResponse('response_content is empty');
  if (replyText.length > MESSAGE_FIELD_LIMITS.TEXT_MAX_LENGTH) rejectResponse('response_content is too long');

  if (!RESPONSE_NEXT_WORKERS.includes(nextWorker)) rejectResponse('next_worker is not a known worker');

  if (!Array.isArray(rawInternalLogs)) rejectResponse('internal_logs is not an array');
  if (rawInternalLogs.length > MAX_INTERNAL_LOG_ENTRIES) rejectResponse('internal_logs has too many entries');
  if (!rawInternalLogs.every((logEntry) => typeof logEntry === 'string' && logEntry.length > 0 && logEntry.length <= MAX_INTERNAL_LOG_ENTRY_LENGTH)) {
    rejectResponse('internal_logs contains an entry that is not a non-empty string of at most 2000 characters');
  }

  const toolExecutionLogs = rawInternalLogs.map((logEntry, entryIndex) => {
    const attributedEntry = INTERNAL_LOG_ENTRY_PATTERN.exec(logEntry);
    return {
      step: entryIndex + 1,
      node: attributedEntry ? attributedEntry[1] : UNATTRIBUTED_LOG_NODE,
      toolName: null,
      output: attributedEntry ? attributedEntry[2] : logEntry,
      status: TOOL_STEP_STATUS.SUCCESS,
      startedAt: requestStartedAt,
      durationMs: null,
    };
  });

  const nextState =
    nextWorker === HUMAN_WORKER
      ? { action: AI_NEXT_ACTION.ESCALATE }
      : { action: AI_NEXT_ACTION.CONTINUE, activeWorker: nextWorker };
  const replySenderType = WORKERS_REPLYING_AS_SPECIALIST.includes(nextWorker) ? SENDER_TYPE.AI_WORKER : SENDER_TYPE.AI_SUPERVISOR;

  return { reply: { text: replyText, senderType: replySenderType }, nextState, toolExecutionLogs };
}

/**
 * Sends a conversation to the ai-service and returns its decision, translated into this backend's domain.
 * @param {ReturnType<typeof buildConversationInput>} aiProcessRequest  ConversationInput body.
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
    return {
      ...parseAiServiceResponse(aiServiceResponse.data, aiProcessRequest.conversation_id, new Date(startedAtMs)),
      durationMs,
    };
  } catch (parseError) {
    if (parseError instanceof AiServiceError) parseError.durationMs = durationMs;
    throw parseError;
  }
}
