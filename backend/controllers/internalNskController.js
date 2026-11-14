/**
 * POST /api/internal/nsk/tools/:tool { actor_token, arguments? }: one NSK assistant tool call from
 * the ai-service (services/nskBot/nskTools.js). Mounted under /api/internal behind
 * requireInternalApiKey; the actor token names the person the turn acts for, and what they may do
 * is read from the database on every call.
 *
 *   200 { data: { result, source } }   source: the citation label, or null
 *   400 invalid arguments (details)    401 ACTOR_INVALID    403 TOOL_FORBIDDEN    404 TOOL_NOT_FOUND
 *
 * A refused tool call is audited (category "nsk_bot", action "nsk_tool_call", outcome denied) with
 * the person and the tool, since it means the model asked for more than the person may read.
 */

import { HTTP_STATUS } from '../constants/httpStatus.js';
import { NSK_BOT_MESSAGES } from '../constants/messages.js';
import { runNskTool } from '../services/nskBot/nskTools.js';
import { ServiceError } from '../services/serviceError.js';
import { sendCodedError, sendError, sendSuccess } from '../utils/apiResponse.js';
import { AUDIT_OUTCOMES, recordAuditEvent } from '../utils/auditLogger.js';
import { validateNskToolCall } from '../validators/nskBotValidators.js';
import { NSK_BOT_AUDIT_CATEGORY } from './nskBotController.js';

export async function postNskToolCall(req, res, next) {
  const validation = validateNskToolCall(req.params, req.body);
  if (!validation.isValid) {
    return sendError(req, res, HTTP_STATUS.BAD_REQUEST, NSK_BOT_MESSAGES.INPUT_INVALID, validation.validationErrors);
  }
  const { toolName, actorToken, args } = validation.sanitizedInput;
  try {
    const outcome = await runNskTool({
      key: req.app.locals.config.nskActorTokenKey,
      token: actorToken,
      toolName,
      args,
    });
    if (outcome.validationErrors) {
      return sendError(req, res, HTTP_STATUS.BAD_REQUEST, NSK_BOT_MESSAGES.INPUT_INVALID, outcome.validationErrors);
    }
    return sendSuccess(res, HTTP_STATUS.OK, NSK_BOT_MESSAGES.TOOL_RESULT, {
      result: outcome.result,
      source: outcome.source,
    });
  } catch (toolError) {
    if (!(toolError instanceof ServiceError)) return next(toolError);
    if (toolError.httpStatus === HTTP_STATUS.FORBIDDEN && toolError.actor) {
      recordAuditEvent(req, {
        category: NSK_BOT_AUDIT_CATEGORY,
        action: 'nsk_tool_call',
        outcome: AUDIT_OUTCOMES.DENIED,
        tool: toolName,
        onBehalfOfUserId: toolError.actor.id,
        onBehalfOfRole: toolError.actor.role,
        sessionId: toolError.actor.sessionId,
      });
    }
    return sendCodedError(req, res, toolError.httpStatus, { code: toolError.code, message: toolError.message });
  }
}
