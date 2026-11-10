/**
 * Questions to department agents (services/agentChat/agentChatService.js), for employees.
 *
 *   GET    /api/departments/agents/available            the agents this person may ask
 *   POST   /api/departments/:departmentId/agent/chat    { question, conversationId?, stream? }
 *            stream false: 200 { conversation, userMessage, message, question }
 *            stream true:  200 application/x-ndjson, one event per line:
 *                            { type: "started", conversation, userMessage }   the question is stored
 *                            { type: "delta", text }                          part of the answer
 *                            { type: "final", conversation, message, question }
 *                                       the stored answer; its content replaces the deltas
 *                            { type: "error", code, message }                 instead of final
 *            Refusals found before the question is stored (input, quota, a conversation that is not
 *            theirs) are ordinary JSON errors either way.
 *   GET    /:departmentId/agent/conversations                    their conversations with this agent
 *   GET    /:departmentId/agent/conversations/:conversationId    one, with its messages
 *   DELETE /:departmentId/agent/conversations/:conversationId    delete one
 *   DELETE /:departmentId/agent/conversations                    delete all of theirs with this agent
 *   POST   /:departmentId/agent/feedback    { messageId, rating: UP|DOWN, comment? }
 *
 * Who may ask is settled by middleware/departmentAgentAskScope.js; conversations are their owner's
 * only. Every question and change is audited (category "agent_chat") with ids and outcomes, never
 * the text of a question or answer.
 */

import { CAPABILITIES } from '../constants/accessRoles.js';
import { HTTP_STATUS } from '../constants/httpStatus.js';
import { AGENT_CHAT_MESSAGES } from '../constants/messages.js';
import { AGENT_CHAT_AUDIT_CATEGORY } from '../middleware/departmentAgentAskScope.js';
import { AiServiceError } from '../services/aiServiceClient.js';
import {
  askAgent,
  clearConversations,
  deleteConversation,
  getConversation,
  listAvailableAgents,
  listConversations,
  rateAnswer,
} from '../services/agentChat/agentChatService.js';
import { ServiceError } from '../services/serviceError.js';
import { sendCodedError, sendError, sendSuccess } from '../utils/apiResponse.js';
import { AUDIT_OUTCOMES, recordAuditEvent } from '../utils/auditLogger.js';
import { logger } from '../utils/logger.js';
import { validateAgentFeedback, validateAgentQuestion } from '../validators/agentChatValidators.js';
import { createWorkforceHandlerFactory, idParamErrors } from './workforceHandler.js';

const agentChatHandler = createWorkforceHandlerFactory({
  auditCategory: AGENT_CHAT_AUDIT_CATEGORY,
  restrictedMessage: AGENT_CHAT_MESSAGES.ASK_NOT_ALLOWED,
  inputInvalidMessage: AGENT_CHAT_MESSAGES.INPUT_INVALID,
});
const ASKER_READ = Object.freeze({ capability: CAPABILITIES.ASK_DEPARTMENT_AGENTS, isWrite: false });
const ASKER_WRITE = Object.freeze({ capability: CAPABILITIES.ASK_DEPARTMENT_AGENTS, isWrite: true });
const NDJSON_HEADERS = Object.freeze({
  'Content-Type': 'application/x-ndjson; charset=utf-8',
  'Cache-Control': 'no-store',
  // Tells nginx not to buffer the stream, so each piece reaches the browser as it is written.
  'X-Accel-Buffering': 'no',
});

const AI_UNAVAILABLE = Object.freeze({
  httpStatus: HTTP_STATUS.SERVICE_UNAVAILABLE,
  code: 'AI_UNAVAILABLE',
  message: AGENT_CHAT_MESSAGES.AI_UNAVAILABLE,
});

/** How a failed question is answered: its status, a stable code and a message safe to show. */
function describeAskFailure(askError) {
  if (askError instanceof ServiceError) {
    return { httpStatus: askError.httpStatus, code: askError.code, message: askError.message };
  }
  if (askError instanceof AiServiceError) {
    logger.warn('Department agent could not answer', {
      failureKind: askError.failureKind,
      httpStatus: askError.httpStatus,
      durationMs: askError.durationMs,
    });
    return AI_UNAVAILABLE;
  }
  return null;
}

/** POST /api/departments/:departmentId/agent/chat */
export async function postAgentChat(req, res, next) {
  const { department, agent } = req.agentScope;
  const audit = (outcome, details = {}) =>
    recordAuditEvent(req, {
      category: AGENT_CHAT_AUDIT_CATEGORY,
      action: 'ask_department_agent',
      outcome,
      departmentId: department._id.toString(),
      agentId: agent._id.toString(),
      ...details,
    });

  const validation = validateAgentQuestion(req.body);
  if (!validation.isValid) {
    return sendError(req, res, HTTP_STATUS.BAD_REQUEST, AGENT_CHAT_MESSAGES.INPUT_INVALID, validation.validationErrors);
  }
  const { question, conversationId, stream } = validation.sanitizedInput;
  const context = { config: req.app.locals.config, requestId: req.id };

  let streamStarted = false;
  const writeEvent = (event) => {
    if (!res.writableEnded && !res.destroyed) res.write(`${JSON.stringify(event)}\n`);
  };
  if (stream) {
    context.onStarted = (started) => {
      res.status(HTTP_STATUS.OK).set(NDJSON_HEADERS);
      res.flushHeaders();
      streamStarted = true;
      writeEvent({ type: 'started', ...started });
    };
    context.onDelta = (text) => writeEvent({ type: 'delta', text });
  }

  try {
    const result = await askAgent({ department, agent }, req.user, { question, conversationId }, context);
    audit(AUDIT_OUTCOMES.ALLOWED, {
      conversationId: result.conversation.id,
      answerOutcome: result.outcome,
      escalated: Boolean(result.question),
      durationMs: result.durationMs,
    });
    const payload = { conversation: result.conversation, message: result.message, question: result.question };
    if (!stream) {
      return sendSuccess(res, HTTP_STATUS.OK, AGENT_CHAT_MESSAGES.ANSWERED, {
        ...payload,
        userMessage: result.userMessage,
      });
    }
    writeEvent({ type: 'final', ...payload });
    return res.end();
  } catch (askError) {
    const failure = describeAskFailure(askError);
    audit(failure && failure.httpStatus < 500 ? AUDIT_OUTCOMES.REJECTED : AUDIT_OUTCOMES.FAILED, {
      reason: failure?.code ?? 'internal_error',
    });
    if (!streamStarted) {
      if (!failure) return next(askError);
      return sendCodedError(req, res, failure.httpStatus, { code: failure.code, message: failure.message });
    }
    if (!failure) {
      logger.error('Department agent stream failed', {
        requestId: req.id,
        error: { name: askError.name, message: askError.message, stack: askError.stack },
      });
    }
    writeEvent({
      type: 'error',
      code: failure?.code ?? 'INTERNAL_ERROR',
      message: failure?.message ?? AGENT_CHAT_MESSAGES.STREAM_FAILED,
    });
    return res.end();
  }
}

export const getAvailableAgents = agentChatHandler('list_department_agents', ASKER_READ, async (req) => ({
  message: AGENT_CHAT_MESSAGES.AGENTS_RETRIEVED,
  data: { agents: await listAvailableAgents(req.user) },
}));

export const getAgentConversations = agentChatHandler('list_agent_conversations', ASKER_READ, async (req) => {
  const invalid = idParamErrors(req.params, 'departmentId');
  if (invalid) return { validationErrors: invalid };
  return {
    message: AGENT_CHAT_MESSAGES.CONVERSATIONS_RETRIEVED,
    data: { conversations: await listConversations(req.user, req.params.departmentId) },
  };
});

export const getAgentConversation = agentChatHandler('view_agent_conversation', ASKER_READ, async (req) => {
  const invalid = idParamErrors(req.params, 'departmentId') ?? idParamErrors(req.params, 'conversationId');
  if (invalid) return { validationErrors: invalid };
  return {
    message: AGENT_CHAT_MESSAGES.CONVERSATION_RETRIEVED,
    data: await getConversation(req.user, req.params.departmentId, req.params.conversationId),
  };
});

export const deleteAgentConversation = agentChatHandler('delete_agent_conversation', ASKER_WRITE, async (req) => {
  const invalid = idParamErrors(req.params, 'departmentId') ?? idParamErrors(req.params, 'conversationId');
  if (invalid) return { validationErrors: invalid };
  const deleted = await deleteConversation(req.user, req.params.departmentId, req.params.conversationId);
  return {
    message: AGENT_CHAT_MESSAGES.CONVERSATION_DELETED,
    data: deleted,
    auditDetails: { departmentId: req.params.departmentId, conversationId: req.params.conversationId },
  };
});

export const clearAgentConversations = agentChatHandler('clear_agent_conversations', ASKER_WRITE, async (req) => {
  const invalid = idParamErrors(req.params, 'departmentId');
  if (invalid) return { validationErrors: invalid };
  const cleared = await clearConversations(req.user, req.params.departmentId);
  return {
    message: AGENT_CHAT_MESSAGES.CONVERSATIONS_CLEARED,
    data: cleared,
    auditDetails: { departmentId: req.params.departmentId, ...cleared },
  };
});

export const postAgentFeedback = agentChatHandler('rate_agent_answer', ASKER_WRITE, async (req) => {
  const invalid = idParamErrors(req.params, 'departmentId');
  if (invalid) return { validationErrors: invalid };
  const validation = validateAgentFeedback(req.body);
  if (!validation.isValid) return { validationErrors: validation.validationErrors };
  const { message, escalated } = await rateAnswer(req.user, req.params.departmentId, validation.sanitizedInput);
  return {
    message: escalated ? AGENT_CHAT_MESSAGES.FEEDBACK_ESCALATED : AGENT_CHAT_MESSAGES.FEEDBACK_SAVED,
    data: { message, escalated },
    auditDetails: {
      departmentId: req.params.departmentId,
      messageId: validation.sanitizedInput.messageId,
      rating: validation.sanitizedInput.rating,
      escalated,
    },
  };
});
