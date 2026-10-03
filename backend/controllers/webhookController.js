/**
 * Inbound customer-message webhook: POST /api/webhooks/incoming.
 *
 * Data transformation lifecycle
 * =============================
 *
 *   1. INGESTED   Signed HTTP request (verified by middleware/webhookSignature.js)
 *                   { eventId, senderEmail, text }
 *                 -> validated and normalised (validators/webhookValidators.js)
 *                 -> senderEmail resolved to a customer User id.
 *
 *   2. SAVED      All further steps for one customer run one at a time (keyedSerialExecutor).
 *                 -> eventId already stored?  Yes: redelivery; return the original result
 *                    without saving or calling the AI again ("duplicate").
 *                 -> the customer's active Conversation is loaded, or created as `unassigned`.
 *                 -> the text is stored as a Message { senderType: customer, externalMessageId: eventId }.
 *                 -> if a human owns the conversation (escalated-to-human / assigned-agent) the flow
 *                    stops here: the message waits for the agent ("routed_to_human").
 *
 *   3. FORWARDED  Conversation moves unassigned -> processing-ai (worker: supervisor) if needed.
 *                 -> the last AI_HISTORY_MESSAGE_LIMIT earlier messages, oldest first, plus the new
 *                    message, are mapped to the ai-service request contract
 *                    (services/aiServiceClient.js) and POSTed to /ai/process.
 *
 *   4. REPLIED    The ai-service response is checked against the response contract, then:
 *                 -> the reply becomes a Message { senderType: ai_supervisor | ai_worker,
 *                    toolExecutionLogs } and is schema-validated before anything is written;
 *                 -> nextState is applied to the Conversation:
 *                      continue -> routeToWorker(activeWorker), status stays processing-ai
 *                      escalate -> transitionTo(escalated-to-human)
 *                 -> the reply Message is saved ("ai_replied").
 *
 *   FALLBACK      Any AI failure (timeout, unreachable, non-2xx, contract violation, reply that
 *                 fails schema validation) ends the flow the same way:
 *                 -> the conversation is escalated to a human, so the customer is never left
 *                    without an owner;
 *                 -> a fixed customer-facing reply (CUSTOMER_FACING_MESSAGES) is saved as
 *                    ai_supervisor, with a toolExecutionLogs entry recording the failure kind
 *                    and duration for audit ("ai_fallback").
 *                 The webhook still answers 200: the customer's message was stored, so the
 *                 sender must not retry it.
 *
 * Response (HTTP 200 for every processed or duplicate event):
 *   { message, data: { outcome, conversation: { id, status, currentActiveWorker },
 *                      customerMessageId, reply: { messageId, senderType, text } | null } }
 *   outcome: "ai_replied" | "ai_fallback" | "routed_to_human" | "duplicate"
 * Errors: 400 invalid body, 401 bad signature, 404 unknown sender, 500 database failure.
 *
 * Real-time: every committed write is published through utils/socketManager.js right after it
 * succeeds: NEW_MESSAGE for the customer message, the AI reply and the fallback reply;
 * CONVERSATION_STATUS_UPDATED for conversation creation and every state change.
 *
 * Logging: every stage logs one line with `stage` = ingested | saved | forwarded | replied |
 * fallback | routed_to_human | duplicate, plus requestId, eventId, conversationId and message ids.
 * Message text and email addresses are never logged; only text length is.
 */

import mongoose from 'mongoose';
import User, { ROLES } from '../models/User.js';
import Conversation, { CONVERSATION_STATUS, ACTIVE_WORKER, HUMAN_OWNED_STATUSES } from '../models/Conversation.js';
import Message, { SENDER_TYPE, TOOL_STEP_STATUS } from '../models/Message.js';
import { CUSTOMER_FACING_MESSAGES, VALIDATION_MESSAGES, WEBHOOK_MESSAGES } from '../constants/messages.js';
import { HTTP_STATUS } from '../constants/httpStatus.js';
import { AI_FAILURE_KIND, AI_NEXT_ACTION, AI_PROCESS_PATH, AiServiceError, requestAiProcessing } from '../services/aiServiceClient.js';
import { sendError, sendSuccess } from '../utils/apiResponse.js';
import { createKeyedSerialExecutor } from '../utils/keyedSerialExecutor.js';
import { logger } from '../utils/logger.js';
import { toStaffConversationStatusPayload, toStaffMessagePayload } from '../utils/realtimePayloads.js';
import { emitConversationStatusUpdate, emitNewMessage } from '../utils/socketManager.js';
import { validateIncomingMessagePayload } from '../validators/webhookValidators.js';

export const WEBHOOK_OUTCOME = Object.freeze({
  AI_REPLIED: 'ai_replied',
  AI_FALLBACK: 'ai_fallback',
  ROUTED_TO_HUMAN: 'routed_to_human',
  DUPLICATE: 'duplicate',
});

/**
 * Statuses that count as an active conversation. The model has no terminal state yet, so
 * every status is active and each customer has one ongoing thread. When a "closed" status is
 * added, leave it out of this list and closed threads will no longer be reused.
 */
const ACTIVE_CONVERSATION_STATUSES = Object.freeze(Object.values(CONVERSATION_STATUS));

/** Earlier messages sent to the AI as context. Bounds request size and LLM token usage. */
const AI_HISTORY_MESSAGE_LIMIT = 50;

/** Attempts for a conversation state update that loses an optimistic-concurrency race. */
const MAX_STATE_UPDATE_ATTEMPTS = 3;

const DUPLICATE_KEY_ERROR_CODE = 11000;

/** Graph node name recorded in toolExecutionLogs when the backend, not the AI, produced a reply. */
const FALLBACK_NODE_NAME = 'backend_gateway';

const runExclusivelyPerCustomer = createKeyedSerialExecutor();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toConversationSummary(conversationRecord) {
  return {
    id: conversationRecord._id.toString(),
    status: conversationRecord.status,
    currentActiveWorker: conversationRecord.currentActiveWorker,
  };
}

function toReplySummary(replyMessage) {
  return { messageId: replyMessage._id.toString(), senderType: replyMessage.senderType, text: replyMessage.text };
}

/**
 * Real-time publishing. Called only after the corresponding write has been committed, so a
 * subscriber never sees an event for data that is not in the database. Both emit helpers
 * never throw: a socket problem cannot fail the webhook. Status updates are awaited so that
 * consecutive changes to one conversation reach clients in the order they were written.
 */
function publishMessage(messageRecord) {
  emitNewMessage(messageRecord.conversationId, toStaffMessagePayload(messageRecord));
}

async function publishConversationState(conversationRecord) {
  await emitConversationStatusUpdate(conversationRecord._id, toStaffConversationStatusPayload(conversationRecord));
}

function isDuplicateExternalMessageIdError(error) {
  return error?.code === DUPLICATE_KEY_ERROR_CODE && Boolean(error?.keyPattern?.externalMessageId);
}

/**
 * Loads a conversation, lets `applyChange` modify it, and saves it, reloading and retrying if
 * another writer saved first (VersionError from optimisticConcurrency). `applyChange` returns
 * false when the current state needs no change, in which case nothing is written.
 * Returns the conversation as stored after the update, or null if it no longer exists.
 */
async function updateConversationWithRetry(conversationId, applyChange) {
  for (let attemptNumber = 1; attemptNumber <= MAX_STATE_UPDATE_ATTEMPTS; attemptNumber += 1) {
    const conversationRecord = await Conversation.findById(conversationId);
    if (!conversationRecord) return null;
    if (!applyChange(conversationRecord)) return conversationRecord;
    try {
      await conversationRecord.save();
      await publishConversationState(conversationRecord);
      return conversationRecord;
    } catch (saveError) {
      const isLastAttempt = attemptNumber === MAX_STATE_UPDATE_ATTEMPTS;
      if (!(saveError instanceof mongoose.Error.VersionError) || isLastAttempt) throw saveError;
    }
  }
  return null;
}

/** Returns the customer's active conversation, creating a new `unassigned` one if there is none. */
async function findOrCreateActiveConversation(customerId, logContext) {
  const existingConversation = await Conversation.findOne({
    customerId,
    status: { $in: ACTIVE_CONVERSATION_STATUSES },
  }).sort({ updatedAt: -1 });
  if (existingConversation) return existingConversation;

  const newConversation = await new Conversation({ customerId }).save();
  logger.info('Conversation created', { ...logContext, conversationId: newConversation._id.toString() });
  await publishConversationState(newConversation);
  return newConversation;
}

/** Builds the result for a redelivered eventId from what was stored the first time. */
async function buildDuplicateResult(existingCustomerMessage, logContext) {
  const conversationRecord = await Conversation.findById(existingCustomerMessage.conversationId).lean();
  logger.info('Duplicate webhook event ignored', {
    ...logContext,
    stage: 'duplicate',
    conversationId: existingCustomerMessage.conversationId.toString(),
    customerMessageId: existingCustomerMessage._id.toString(),
  });
  return {
    outcome: WEBHOOK_OUTCOME.DUPLICATE,
    conversation: conversationRecord ? toConversationSummary(conversationRecord) : null,
    customerMessageId: existingCustomerMessage._id.toString(),
    reply: null,
  };
}

/** Maps stored messages to the ai-service request contract. */
function toAiMessage(messageRecord) {
  return {
    messageId: messageRecord._id.toString(),
    senderType: messageRecord.senderType,
    text: messageRecord.text,
    createdAt: messageRecord.createdAt.toISOString(),
  };
}

/**
 * Fallback for every AI failure: escalate to a human, then save the fixed customer-facing
 * reply with an audit entry describing the failure. Escalation is written first because it is
 * the part that guarantees the customer is not stranded.
 */
async function applyAiFallback({ conversationId, aiServiceError, logContext }) {
  const escalatedConversation = await updateConversationWithRetry(conversationId, (conversationRecord) => {
    if (HUMAN_OWNED_STATUSES.includes(conversationRecord.status)) return false;
    conversationRecord.transitionTo(CONVERSATION_STATUS.ESCALATED_TO_HUMAN);
    return true;
  });

  const failureDurationMs = aiServiceError.durationMs ?? 0;
  const fallbackReplyMessage = await Message.create({
    conversationId,
    senderType: SENDER_TYPE.AI_SUPERVISOR,
    text: CUSTOMER_FACING_MESSAGES.AI_UNAVAILABLE_FALLBACK_REPLY,
    toolExecutionLogs: [
      {
        step: 1,
        node: FALLBACK_NODE_NAME,
        toolName: `ai_service${AI_PROCESS_PATH.replaceAll('/', '.')}`,
        status: TOOL_STEP_STATUS.ERROR,
        error: `${aiServiceError.failureKind}: ${aiServiceError.detail}`,
        startedAt: new Date(Date.now() - failureDurationMs),
        durationMs: failureDurationMs,
      },
    ],
  });
  publishMessage(fallbackReplyMessage);

  logger.warn('AI service failed; fallback reply saved and conversation escalated', {
    ...logContext,
    stage: 'fallback',
    conversationId: conversationId.toString(),
    failureKind: aiServiceError.failureKind,
    failureDetail: aiServiceError.detail,
    aiHttpStatus: aiServiceError.httpStatus,
    durationMs: failureDurationMs,
    replyMessageId: fallbackReplyMessage._id.toString(),
    status: escalatedConversation?.status,
  });

  return {
    outcome: WEBHOOK_OUTCOME.AI_FALLBACK,
    conversation: escalatedConversation ? toConversationSummary(escalatedConversation) : null,
    reply: toReplySummary(fallbackReplyMessage),
  };
}

// ---------------------------------------------------------------------------
// Pipeline (stages 2–4), run with the customer's lock held
// ---------------------------------------------------------------------------

async function processCustomerMessage({ customerId, eventId, text, config, logContext }) {
  // ---- Stage 2: SAVED ------------------------------------------------------
  const previouslyStoredMessage = await Message.findOne({ externalMessageId: eventId })
    .select('_id conversationId')
    .lean();
  if (previouslyStoredMessage) return buildDuplicateResult(previouslyStoredMessage, logContext);

  const activeConversation = await findOrCreateActiveConversation(customerId, logContext);
  const conversationId = activeConversation._id;

  let customerMessage;
  try {
    customerMessage = await Message.create({
      conversationId,
      senderType: SENDER_TYPE.CUSTOMER,
      text,
      externalMessageId: eventId,
    });
  } catch (createError) {
    // Same eventId delivered concurrently to another backend instance, which stored it first.
    if (isDuplicateExternalMessageIdError(createError)) {
      const concurrentlyStoredMessage = await Message.findOne({ externalMessageId: eventId })
        .select('_id conversationId')
        .lean();
      return buildDuplicateResult(concurrentlyStoredMessage, logContext);
    }
    throw createError;
  }
  publishMessage(customerMessage);

  const stageContext = {
    ...logContext,
    conversationId: conversationId.toString(),
    customerMessageId: customerMessage._id.toString(),
  };
  logger.info('Customer message saved', { ...stageContext, stage: 'saved', status: activeConversation.status });

  const routedToHumanResult = (conversationRecord) => {
    logger.info('Conversation is owned by a human; AI not called', {
      ...stageContext,
      stage: 'routed_to_human',
      status: conversationRecord.status,
    });
    return {
      outcome: WEBHOOK_OUTCOME.ROUTED_TO_HUMAN,
      conversation: toConversationSummary(conversationRecord),
      customerMessageId: customerMessage._id.toString(),
      reply: null,
    };
  };

  if (HUMAN_OWNED_STATUSES.includes(activeConversation.status)) {
    return routedToHumanResult(activeConversation);
  }

  // ---- Stage 3: FORWARDED --------------------------------------------------
  const aiReadyConversation = await updateConversationWithRetry(conversationId, (conversationRecord) => {
    if (conversationRecord.status !== CONVERSATION_STATUS.UNASSIGNED) return false;
    conversationRecord.transitionTo(CONVERSATION_STATUS.PROCESSING_AI, { worker: ACTIVE_WORKER.SUPERVISOR });
    return true;
  });
  if (!aiReadyConversation) {
    throw new Error(`Conversation ${conversationId} was deleted while its message was being processed`);
  }
  // An agent may have claimed the conversation between the load above and this update.
  if (HUMAN_OWNED_STATUSES.includes(aiReadyConversation.status)) {
    return routedToHumanResult(aiReadyConversation);
  }

  const earlierMessagesNewestFirst = await Message.find({ conversationId, _id: { $ne: customerMessage._id } })
    .sort({ createdAt: -1, _id: -1 })
    .limit(AI_HISTORY_MESSAGE_LIMIT)
    .select('_id senderType text createdAt')
    .lean();

  const aiProcessRequest = {
    conversation: toConversationSummary(aiReadyConversation),
    customer: { id: customerId },
    history: earlierMessagesNewestFirst.reverse().map(toAiMessage),
    newMessage: toAiMessage(customerMessage),
  };

  logger.info('Forwarded to AI service', {
    ...stageContext,
    stage: 'forwarded',
    historyMessageCount: aiProcessRequest.history.length,
    activeWorker: aiReadyConversation.currentActiveWorker,
    timeoutMs: config.aiServiceTimeoutMs,
  });

  // ---- Stage 4: REPLIED (or FALLBACK) ---------------------------------------
  let aiDecision;
  try {
    aiDecision = await requestAiProcessing(aiProcessRequest, { config, requestId: logContext.requestId });
  } catch (aiError) {
    if (!(aiError instanceof AiServiceError)) throw aiError;
    const fallbackResult = await applyAiFallback({ conversationId, aiServiceError: aiError, logContext: stageContext });
    return { ...fallbackResult, customerMessageId: customerMessage._id.toString() };
  }

  const aiReplyMessage = new Message({
    conversationId,
    senderType: aiDecision.reply.senderType,
    text: aiDecision.reply.text,
    toolExecutionLogs: aiDecision.toolExecutionLogs,
  });
  try {
    await aiReplyMessage.validate();
  } catch (validationError) {
    if (!(validationError instanceof mongoose.Error.ValidationError)) throw validationError;
    const invalidReplyError = new AiServiceError(
      AI_FAILURE_KIND.INVALID_RESPONSE,
      `reply failed schema validation on: ${Object.keys(validationError.errors).join(', ')}`,
      { durationMs: aiDecision.durationMs },
    );
    const fallbackResult = await applyAiFallback({ conversationId, aiServiceError: invalidReplyError, logContext: stageContext });
    return { ...fallbackResult, customerMessageId: customerMessage._id.toString() };
  }

  // Set on every attempt from the state actually loaded, so a retry after a concurrent write
  // reflects the latest state rather than an earlier one.
  let isAiDecisionApplicable = false;
  const updatedConversation = await updateConversationWithRetry(conversationId, (conversationRecord) => {
    // Only a conversation still in processing-ai accepts the AI's decision. Any other status
    // means a human took over while the AI was working; their state wins and is left untouched.
    isAiDecisionApplicable = conversationRecord.status === CONVERSATION_STATUS.PROCESSING_AI;
    if (!isAiDecisionApplicable) return false;
    if (aiDecision.nextState.action === AI_NEXT_ACTION.ESCALATE) {
      conversationRecord.transitionTo(CONVERSATION_STATUS.ESCALATED_TO_HUMAN);
      return true;
    }
    if (conversationRecord.currentActiveWorker === aiDecision.nextState.activeWorker) return false;
    conversationRecord.routeToWorker(aiDecision.nextState.activeWorker);
    return true;
  });
  if (!updatedConversation) {
    throw new Error(`Conversation ${conversationId} was deleted while its message was being processed`);
  }

  if (!isAiDecisionApplicable) {
    // The agent now owns the thread, so the AI's reply is not delivered: it could contradict
    // what the agent tells the customer.
    logger.warn('AI reply discarded: a human took over during processing', {
      ...stageContext,
      stage: 'routed_to_human',
      status: updatedConversation.status,
      durationMs: aiDecision.durationMs,
    });
    return routedToHumanResult(updatedConversation);
  }

  await aiReplyMessage.save();
  publishMessage(aiReplyMessage);

  logger.info('AI reply saved', {
    ...stageContext,
    stage: 'replied',
    replyMessageId: aiReplyMessage._id.toString(),
    replySenderType: aiReplyMessage.senderType,
    replyTextLength: aiReplyMessage.text.length,
    toolStepCount: aiReplyMessage.toolExecutionLogs.length,
    nextAction: aiDecision.nextState.action,
    status: updatedConversation.status,
    activeWorker: updatedConversation.currentActiveWorker,
    durationMs: aiDecision.durationMs,
  });

  return {
    outcome: WEBHOOK_OUTCOME.AI_REPLIED,
    conversation: toConversationSummary(updatedConversation),
    customerMessageId: customerMessage._id.toString(),
    reply: toReplySummary(aiReplyMessage),
  };
}

// ---------------------------------------------------------------------------
// Route handler (stage 1)
// ---------------------------------------------------------------------------

/**
 * POST /api/webhooks/incoming   (behind verifyWebhookSignature)
 * See the lifecycle at the top of this file for what happens to the payload.
 */
export async function receiveIncomingMessage(req, res, next) {
  try {
    // ---- Stage 1: INGESTED ---------------------------------------------------
    const payloadValidation = validateIncomingMessagePayload(req.body);
    if (!payloadValidation.isValid) {
      logger.warn('Webhook payload rejected', {
        requestId: req.id,
        stage: 'ingested',
        invalidFields: payloadValidation.validationErrors.map((validationIssue) => validationIssue.field),
      });
      return sendError(
        req,
        res,
        HTTP_STATUS.BAD_REQUEST,
        VALIDATION_MESSAGES.REQUEST_VALIDATION_FAILED,
        payloadValidation.validationErrors,
      );
    }

    const { eventId, senderEmail, text } = payloadValidation.sanitizedInput;
    const logContext = { requestId: req.id, eventId };
    logger.info('Webhook ingested', { ...logContext, stage: 'ingested', textLength: text.length });

    const customerRecord = await User.findOne({ email: senderEmail, role: ROLES.CUSTOMER }).select('_id').lean();
    if (!customerRecord) {
      logger.warn('Webhook sender is not a registered customer', { ...logContext, stage: 'ingested' });
      return sendError(req, res, HTTP_STATUS.NOT_FOUND, WEBHOOK_MESSAGES.SENDER_NOT_FOUND);
    }
    const customerId = customerRecord._id.toString();

    const processingResult = await runExclusivelyPerCustomer(customerId, () =>
      processCustomerMessage({
        customerId,
        eventId,
        text,
        config: req.app.locals.config,
        logContext: { ...logContext, customerId },
      }),
    );

    const responseMessage =
      processingResult.outcome === WEBHOOK_OUTCOME.DUPLICATE ? WEBHOOK_MESSAGES.DUPLICATE_EVENT : WEBHOOK_MESSAGES.MESSAGE_PROCESSED;
    return sendSuccess(res, HTTP_STATUS.OK, responseMessage, processingResult);
  } catch (error) {
    return next(error);
  }
}
