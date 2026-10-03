/**
 * Customer web chat: POST /api/support/messages.
 *
 * The signed-in customer sends a message from the website. It enters the same pipeline as the
 * inbound webhook (webhookController.ingestCustomerMessage): saved, routed by the AI supervisor,
 * answered by an AI worker or queued for a human, and published to the customer's and staff's open
 * sockets. The response carries the AI's reply when there is one, so the page can show it at once;
 * the same events also arrive over the socket, and the page de-duplicates by messageId.
 *
 * Request:  { text: string (1–20,000 chars), clientMessageId?: string (8–64 [A-Za-z0-9-]) }
 *   clientMessageId makes retries safe: the page generates one per message, and sending the same id
 *   again (e.g. after a network timeout) returns the original result instead of a duplicate message.
 *   It is namespaced by customer ("web:<customerId>:<clientMessageId>"), so one customer's ids can
 *   never collide with another's.
 * Response: 201 { message, data: { outcome, conversation: { id, status }, customerMessageId, reply } }
 *   reply: { messageId, senderType, text } or null (when a human owns the conversation)
 * Errors:   400 invalid body, 401 not signed in, 403 not a customer or missing CSRF token,
 *           429 rate limited, 500 via the central error handler.
 */

import { randomUUID } from 'node:crypto';
import { ROLES } from '../models/User.js';
import { HTTP_STATUS } from '../constants/httpStatus.js';
import { SUPPORT_MESSAGES, VALIDATION_MESSAGES } from '../constants/messages.js';
import { sendError, sendSuccess } from '../utils/apiResponse.js';
import { logger } from '../utils/logger.js';
import { validateAgentReplyInput } from '../validators/conversationValidators.js';
import { ingestCustomerMessage } from './webhookController.js';

const CLIENT_MESSAGE_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

export async function sendCustomerMessage(req, res, next) {
  try {
    if (req.user.role !== ROLES.CUSTOMER) {
      return sendError(req, res, HTTP_STATUS.FORBIDDEN, SUPPORT_MESSAGES.CUSTOMERS_ONLY);
    }

    // Same text rules as an agent reply: required, a string, at most 20,000 characters after trimming.
    const textValidation = validateAgentReplyInput(req.body);
    const rawClientMessageId = req.body?.clientMessageId;
    const validationErrors = [...textValidation.validationErrors];
    if (rawClientMessageId !== undefined && !(typeof rawClientMessageId === 'string' && CLIENT_MESSAGE_ID_PATTERN.test(rawClientMessageId))) {
      validationErrors.push({ field: 'clientMessageId', message: SUPPORT_MESSAGES.CLIENT_MESSAGE_ID_INVALID });
    }
    if (validationErrors.length > 0) {
      return sendError(req, res, HTTP_STATUS.BAD_REQUEST, VALIDATION_MESSAGES.REQUEST_VALIDATION_FAILED, validationErrors);
    }

    const eventId = `web:${req.user.id}:${rawClientMessageId ?? randomUUID()}`;
    const logContext = { requestId: req.id, eventId, customerId: req.user.id };
    logger.info('Web chat message received', { ...logContext, stage: 'ingested', textLength: textValidation.sanitizedInput.text.length });

    const processingResult = await ingestCustomerMessage({
      customerId: req.user.id,
      eventId,
      text: textValidation.sanitizedInput.text,
      config: req.app.locals.config,
      logContext,
    });

    // Customer-safe projection: no worker names, agent ids, or AI audit details.
    return sendSuccess(res, HTTP_STATUS.CREATED, SUPPORT_MESSAGES.MESSAGE_RECEIVED, {
      outcome: processingResult.outcome,
      conversation: processingResult.conversation
        ? { id: processingResult.conversation.id, status: processingResult.conversation.status }
        : null,
      customerMessageId: processingResult.customerMessageId,
      reply: processingResult.reply,
    });
  } catch (error) {
    return next(error);
  }
}
