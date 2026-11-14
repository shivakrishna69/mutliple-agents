/**
 * The NSK assistant (services/nskBot/nskBotService.js), mounted at /api/nsk-bot for anyone with
 * USE_NSK_ASSISTANT (checked by the router, and again here). What each turn may read is checked
 * again by every tool it calls (services/nskBot/nskTools.js).
 *
 *   GET    /sessions               their sessions, newest first, and `resume` (the latest one to pick
 *                                  up, with starter suggestions) or null
 *   GET    /sessions/:sessionId    one session with its messages
 *   DELETE /sessions/:sessionId    delete one, with its messages
 *   POST   /message                { message, sessionId? }: one turn. 200 { session, userMessage,
 *                                  message }: the reply with its outcome, citations, suggestions and
 *                                  (for an urgent, frustrated or sensitive message) an escalation hint
 *
 * Every turn and deletion is audited (category "nsk_bot") with ids, the intent, the sentiment, the
 * outcome and the tools used, never the text of a message.
 */

import { CAPABILITIES } from '../constants/accessRoles.js';
import { HTTP_STATUS } from '../constants/httpStatus.js';
import { NSK_BOT_MESSAGES } from '../constants/messages.js';
import { AiServiceError } from '../services/aiServiceClient.js';
import { deleteSession, getSession, listSessions, sendMessage } from '../services/nskBot/nskBotService.js';
import { ServiceError } from '../services/serviceError.js';
import { logger } from '../utils/logger.js';
import { sessionIdErrors, validateNskMessage } from '../validators/nskBotValidators.js';
import { createWorkforceHandlerFactory } from './workforceHandler.js';

export const NSK_BOT_AUDIT_CATEGORY = 'nsk_bot';

const nskHandler = createWorkforceHandlerFactory({
  auditCategory: NSK_BOT_AUDIT_CATEGORY,
  restrictedMessage: NSK_BOT_MESSAGES.ACCESS_DENIED,
  inputInvalidMessage: NSK_BOT_MESSAGES.INPUT_INVALID,
});
const USER_READ = Object.freeze({ capability: CAPABILITIES.USE_NSK_ASSISTANT, isWrite: false });
const USER_WRITE = Object.freeze({ capability: CAPABILITIES.USE_NSK_ASSISTANT, isWrite: true });

export const getNskSessions = nskHandler('list_nsk_sessions', USER_READ, async (req) => ({
  message: NSK_BOT_MESSAGES.SESSIONS_RETRIEVED,
  data: await listSessions(req.user),
}));

export const getNskSession = nskHandler('view_nsk_session', USER_READ, async (req) => {
  const validationErrors = sessionIdErrors(req.params);
  if (validationErrors) return { validationErrors };
  return { message: NSK_BOT_MESSAGES.SESSION_RETRIEVED, data: await getSession(req.user, req.params.sessionId) };
});

export const deleteNskSession = nskHandler('delete_nsk_session', USER_WRITE, async (req) => {
  const validationErrors = sessionIdErrors(req.params);
  if (validationErrors) return { validationErrors };
  const result = await deleteSession(req.user, req.params.sessionId);
  return {
    message: NSK_BOT_MESSAGES.SESSION_DELETED,
    data: result,
    auditDetails: { sessionId: req.params.sessionId, deletedMessages: result.deletedMessages },
  };
});

export const postNskMessage = nskHandler('send_nsk_message', USER_WRITE, async (req) => {
  const validation = validateNskMessage(req.body);
  if (!validation.isValid) return { validationErrors: validation.validationErrors };
  let result;
  try {
    result = await sendMessage(req.user, validation.sanitizedInput, {
      config: req.app.locals.config,
      requestId: req.id,
    });
  } catch (turnError) {
    if (!(turnError instanceof AiServiceError)) throw turnError;
    logger.warn('NSK could not answer', {
      requestId: req.id,
      failureKind: turnError.failureKind,
      httpStatus: turnError.httpStatus,
      durationMs: turnError.durationMs,
    });
    throw new ServiceError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'AI_UNAVAILABLE', NSK_BOT_MESSAGES.AI_UNAVAILABLE);
  }
  return {
    message: NSK_BOT_MESSAGES.REPLIED,
    data: { session: result.session, userMessage: result.userMessage, message: result.message },
    auditDetails: {
      sessionId: result.session.id,
      intent: result.classification.intent,
      sentiment: result.classification.sentiment,
      answerOutcome: result.outcome,
      toolsUsed: result.toolsUsed,
      citations: result.message.citations.length,
      durationMs: result.durationMs,
    },
  };
});
