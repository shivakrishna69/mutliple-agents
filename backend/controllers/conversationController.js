/**
 * Conversation routes for the support console and the customer-facing app.
 *
 *   GET  /api/conversations                         list conversations visible to the caller
 *   GET  /api/conversations/:conversationId         one conversation's details
 *   GET  /api/conversations/:conversationId/messages  its messages, oldest first
 *   POST /api/conversations/:conversationId/claim   (staff) take an escalated conversation
 *   POST /api/conversations/:conversationId/release (staff) hand it back to the human queue
 *   POST /api/conversations/:conversationId/messages  (staff) send a reply as a human agent
 *
 * Visibility follows services/conversationAccess.js, the same rules the Socket.IO layer uses:
 *   admin     every conversation
 *   agent     conversations assigned to them, plus the queue (escalated-to-human, unassigned)
 *   customer  their own conversations
 * A conversation the caller may not see is reported exactly like one that does not exist (404),
 * so ids cannot be probed.
 *
 * Payloads: staff receive the full shapes from utils/realtimePayloads.js (the same objects the
 * socket events carry, so the console can merge HTTP and live data without conversion); customers
 * receive the customer-safe projections.
 *
 * State changes go through services/conversationState.js, which saves with optimistic concurrency
 * and publishes CONVERSATION_STATUS_UPDATED / NEW_MESSAGE after each committed write.
 */

import Conversation, { CONVERSATION_STATUS } from '../models/Conversation.js';
import Message, { SENDER_TYPE } from '../models/Message.js';
import User, { ROLES } from '../models/User.js';
import { CONVERSATION_MESSAGES, VALIDATION_MESSAGES } from '../constants/messages.js';
import { HTTP_STATUS } from '../constants/httpStatus.js';
import { canUserAccessConversation, isStaffRole } from '../services/conversationAccess.js';
import { publishMessage, touchConversation, updateConversationWithRetry } from '../services/conversationState.js';
import { sendError, sendSuccess } from '../utils/apiResponse.js';
import { logger } from '../utils/logger.js';
import {
  toCustomerConversationStatusPayload,
  toCustomerMessagePayload,
  toStaffConversationStatusPayload,
  toStaffMessagePayload,
} from '../utils/realtimePayloads.js';
import { isValidObjectIdString, validateAgentReplyInput } from '../validators/conversationValidators.js';

/** Most conversations returned by one list call, newest activity first. */
const CONVERSATION_LIST_LIMIT = 100;
/** Most recent messages returned for one conversation. */
const MESSAGE_HISTORY_LIMIT = 200;
/** Characters of the latest message shown in the list. */
const MESSAGE_PREVIEW_LENGTH = 140;

const CONVERSATION_ACCESS_FIELDS = '_id customerId assignedAgentId status currentActiveWorker createdAt updatedAt';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** MongoDB filter for the conversations a user may list (mirrors canUserAccessConversation). */
function buildVisibleConversationFilter(user) {
  if (user.role === ROLES.ADMIN) return {};
  if (user.role === ROLES.AGENT) {
    return {
      $or: [
        { assignedAgentId: user.id },
        { status: CONVERSATION_STATUS.ESCALATED_TO_HUMAN, assignedAgentId: null },
      ],
    };
  }
  return { customerId: user.id };
}

function toCustomerSummary(customerRecord) {
  return customerRecord ? { id: customerRecord._id.toString(), name: customerRecord.name, email: customerRecord.email } : null;
}

/**
 * Loads a conversation and checks the caller may see it. Sends 400/404 itself and returns null
 * when the request should stop.
 */
async function loadAccessibleConversation(req, res) {
  const { conversationId } = req.params;
  if (!isValidObjectIdString(conversationId)) {
    sendError(req, res, HTTP_STATUS.BAD_REQUEST, CONVERSATION_MESSAGES.INVALID_CONVERSATION_ID);
    return null;
  }
  const conversationRecord = await Conversation.findById(conversationId).select(CONVERSATION_ACCESS_FIELDS).lean();
  if (!conversationRecord || !canUserAccessConversation(req.user, conversationRecord)) {
    logger.warn('Conversation access denied', {
      requestId: req.id,
      userId: req.user.id,
      conversationId,
      conversationExists: Boolean(conversationRecord),
    });
    sendError(req, res, HTTP_STATUS.NOT_FOUND, CONVERSATION_MESSAGES.NOT_ACCESSIBLE);
    return null;
  }
  return conversationRecord;
}

/** Status payload for the caller's role, with createdAt and the customer's public details. */
function toConversationDetailsPayload(conversationRecord, customerRecord, viewerIsStaff) {
  const staffStatusPayload = toStaffConversationStatusPayload(conversationRecord);
  const createdAt = conversationRecord.createdAt instanceof Date ? conversationRecord.createdAt.toISOString() : conversationRecord.createdAt;
  if (!viewerIsStaff) {
    return { ...toCustomerConversationStatusPayload(staffStatusPayload), createdAt };
  }
  return { ...staffStatusPayload, createdAt, customer: toCustomerSummary(customerRecord) };
}

// ---------------------------------------------------------------------------
// Read routes
// ---------------------------------------------------------------------------

/** GET /api/conversations */
export async function listConversations(req, res, next) {
  try {
    const viewerIsStaff = isStaffRole(req.user.role);
    const conversationRecords = await Conversation.find(buildVisibleConversationFilter(req.user))
      .sort({ updatedAt: -1 })
      .limit(CONVERSATION_LIST_LIMIT)
      .select(CONVERSATION_ACCESS_FIELDS)
      .lean();

    const conversationIds = conversationRecords.map((conversationRecord) => conversationRecord._id);
    const [customerRecords, latestMessages] = await Promise.all([
      User.find({ _id: { $in: conversationRecords.map((conversationRecord) => conversationRecord.customerId) } })
        .select('_id name email')
        .lean(),
      // Latest message per conversation, served by the { conversationId, createdAt } index.
      Message.aggregate([
        { $match: { conversationId: { $in: conversationIds } } },
        { $sort: { conversationId: 1, createdAt: -1 } },
        { $group: { _id: '$conversationId', text: { $first: '$text' }, senderType: { $first: '$senderType' } } },
      ]),
    ]);
    const customerById = new Map(customerRecords.map((customerRecord) => [customerRecord._id.toString(), customerRecord]));
    const latestMessageByConversationId = new Map(latestMessages.map((latestMessage) => [latestMessage._id.toString(), latestMessage]));

    const conversations = conversationRecords.map((conversationRecord) => {
      const latestMessage = latestMessageByConversationId.get(conversationRecord._id.toString());
      const customerRecord = customerById.get(conversationRecord.customerId.toString());
      const statusPayload = viewerIsStaff
        ? toStaffConversationStatusPayload(conversationRecord)
        : toCustomerConversationStatusPayload(toStaffConversationStatusPayload(conversationRecord));
      return {
        ...statusPayload,
        ...(viewerIsStaff && { customerName: customerRecord?.name ?? null, customerEmail: customerRecord?.email ?? null }),
        lastMessagePreview: latestMessage?.text ? latestMessage.text.slice(0, MESSAGE_PREVIEW_LENGTH) : null,
        lastMessageSenderType: latestMessage?.senderType ?? null,
      };
    });

    return sendSuccess(res, HTTP_STATUS.OK, CONVERSATION_MESSAGES.LIST_RETRIEVED, { conversations });
  } catch (error) {
    return next(error);
  }
}

/** GET /api/conversations/:conversationId */
export async function getConversation(req, res, next) {
  try {
    const conversationRecord = await loadAccessibleConversation(req, res);
    if (!conversationRecord) return undefined;
    const customerRecord = await User.findById(conversationRecord.customerId).select('_id name email').lean();
    return sendSuccess(res, HTTP_STATUS.OK, CONVERSATION_MESSAGES.DETAILS_RETRIEVED, {
      conversation: toConversationDetailsPayload(conversationRecord, customerRecord, isStaffRole(req.user.role)),
    });
  } catch (error) {
    return next(error);
  }
}

/** GET /api/conversations/:conversationId/messages — the latest MESSAGE_HISTORY_LIMIT, oldest first. */
export async function listConversationMessages(req, res, next) {
  try {
    const conversationRecord = await loadAccessibleConversation(req, res);
    if (!conversationRecord) return undefined;

    const newestFirstMessages = await Message.find({ conversationId: conversationRecord._id })
      .sort({ createdAt: -1, _id: -1 })
      .limit(MESSAGE_HISTORY_LIMIT)
      .lean();
    const viewerIsStaff = isStaffRole(req.user.role);
    const messages = newestFirstMessages.reverse().map((messageRecord) => {
      const staffMessagePayload = toStaffMessagePayload(messageRecord);
      return viewerIsStaff ? staffMessagePayload : toCustomerMessagePayload(staffMessagePayload);
    });

    return sendSuccess(res, HTTP_STATUS.OK, CONVERSATION_MESSAGES.MESSAGES_RETRIEVED, { messages });
  } catch (error) {
    return next(error);
  }
}

// ---------------------------------------------------------------------------
// Staff actions
// ---------------------------------------------------------------------------

/**
 * POST /api/conversations/:conversationId/claim
 * Assigns a waiting conversation (escalated-to-human or unassigned) to the caller. Claiming one
 * you already hold succeeds again (idempotent); one held by someone else is 409.
 */
export async function claimConversation(req, res, next) {
  try {
    const conversationRecord = await loadAccessibleConversation(req, res);
    if (!conversationRecord) return undefined;

    let claimOutcome = 'claimed';
    const claimedConversation = await updateConversationWithRetry(conversationRecord._id, (currentConversation) => {
      if (currentConversation.status === CONVERSATION_STATUS.ASSIGNED_AGENT) {
        claimOutcome = String(currentConversation.assignedAgentId) === req.user.id ? 'already_yours' : 'claimed_by_other';
        return false;
      }
      if (![CONVERSATION_STATUS.ESCALATED_TO_HUMAN, CONVERSATION_STATUS.UNASSIGNED].includes(currentConversation.status)) {
        claimOutcome = 'not_claimable';
        return false;
      }
      claimOutcome = 'claimed';
      currentConversation.transitionTo(CONVERSATION_STATUS.ASSIGNED_AGENT, { agentId: req.user.id });
      return true;
    });

    if (claimOutcome === 'claimed_by_other') {
      return sendError(req, res, HTTP_STATUS.CONFLICT, CONVERSATION_MESSAGES.ALREADY_CLAIMED);
    }
    if (claimOutcome === 'not_claimable') {
      return sendError(req, res, HTTP_STATUS.CONFLICT, CONVERSATION_MESSAGES.NOT_CLAIMABLE);
    }
    if (claimOutcome === 'claimed') {
      logger.info('Conversation claimed', { requestId: req.id, userId: req.user.id, conversationId: conversationRecord._id.toString() });
    }
    const customerRecord = await User.findById(claimedConversation.customerId).select('_id name email').lean();
    return sendSuccess(res, HTTP_STATUS.OK, CONVERSATION_MESSAGES.CLAIMED, {
      conversation: toConversationDetailsPayload(claimedConversation, customerRecord, true),
    });
  } catch (error) {
    return next(error);
  }
}

/**
 * POST /api/conversations/:conversationId/release
 * The assigned agent (or an admin) hands the conversation back to the human queue.
 */
export async function releaseConversation(req, res, next) {
  try {
    const conversationRecord = await loadAccessibleConversation(req, res);
    if (!conversationRecord) return undefined;

    let isReleaseAllowed = true;
    const releasedConversation = await updateConversationWithRetry(conversationRecord._id, (currentConversation) => {
      const isAssignedToCaller = String(currentConversation.assignedAgentId) === req.user.id;
      isReleaseAllowed =
        currentConversation.status === CONVERSATION_STATUS.ASSIGNED_AGENT && (isAssignedToCaller || req.user.role === ROLES.ADMIN);
      if (!isReleaseAllowed) return false;
      currentConversation.transitionTo(CONVERSATION_STATUS.ESCALATED_TO_HUMAN);
      return true;
    });

    if (!isReleaseAllowed) {
      return sendError(req, res, HTTP_STATUS.CONFLICT, CONVERSATION_MESSAGES.NOT_ASSIGNED_TO_YOU);
    }
    logger.info('Conversation released to queue', { requestId: req.id, userId: req.user.id, conversationId: conversationRecord._id.toString() });
    const customerRecord = await User.findById(releasedConversation.customerId).select('_id name email').lean();
    return sendSuccess(res, HTTP_STATUS.OK, CONVERSATION_MESSAGES.RELEASED, {
      conversation: toConversationDetailsPayload(releasedConversation, customerRecord, true),
    });
  } catch (error) {
    return next(error);
  }
}

/**
 * POST /api/conversations/:conversationId/messages  { text }
 * Sends a reply as a human agent. Only the agent the conversation is assigned to may reply, so two
 * people never answer the same customer at once. The message records the agent (senderUserId).
 */
export async function sendAgentMessage(req, res, next) {
  try {
    const replyValidation = validateAgentReplyInput(req.body);
    if (!replyValidation.isValid) {
      return sendError(req, res, HTTP_STATUS.BAD_REQUEST, VALIDATION_MESSAGES.REQUEST_VALIDATION_FAILED, replyValidation.validationErrors);
    }

    const conversationRecord = await loadAccessibleConversation(req, res);
    if (!conversationRecord) return undefined;
    const isAssignedToCaller =
      conversationRecord.status === CONVERSATION_STATUS.ASSIGNED_AGENT && String(conversationRecord.assignedAgentId) === req.user.id;
    if (!isAssignedToCaller) {
      return sendError(req, res, HTTP_STATUS.CONFLICT, CONVERSATION_MESSAGES.NOT_ASSIGNED_TO_YOU);
    }

    const agentMessage = await Message.create({
      conversationId: conversationRecord._id,
      senderType: SENDER_TYPE.HUMAN_AGENT,
      senderUserId: req.user.id,
      text: replyValidation.sanitizedInput.text,
    });
    publishMessage(agentMessage);
    await touchConversation(conversationRecord._id);

    logger.info('Agent reply sent', {
      requestId: req.id,
      userId: req.user.id,
      conversationId: conversationRecord._id.toString(),
      messageId: agentMessage._id.toString(),
      textLength: agentMessage.text.length,
    });
    return sendSuccess(res, HTTP_STATUS.CREATED, CONVERSATION_MESSAGES.REPLY_SENT, { message: toStaffMessagePayload(agentMessage) });
  } catch (error) {
    return next(error);
  }
}
