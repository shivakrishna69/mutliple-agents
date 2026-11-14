/**
 * Request validation for the NSK assistant (routes/nskBotRoutes.js) and its internal tool calls
 * (routes/internalRoutes.js). Text is trimmed; ids must be ids; unknown fields are refused.
 */

import { NSK_BOT_SETTINGS } from '../constants/validation.js';
import { readOptionalId, readText, refuseUnknownFields } from './agentChatValidators.js';
import { isValidObjectIdString } from './conversationValidators.js';
import { bodyNotObjectResult, isPlainObject, validationResult } from './requestShape.js';

const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/** POST /api/nsk-bot/message: { message, sessionId? } */
export function validateNskMessage(requestBody) {
  if (!isPlainObject(requestBody)) return bodyNotObjectResult();
  const validationErrors = [];
  refuseUnknownFields(requestBody, ['message', 'sessionId'], validationErrors);
  const message = readText(requestBody.message, 'message', NSK_BOT_SETTINGS.MESSAGE_MAX_LENGTH, validationErrors);
  const sessionId = readOptionalId(requestBody.sessionId, 'sessionId', validationErrors);
  return validationResult(validationErrors, { message, sessionId });
}

/** [{ field, message }] when :sessionId is not an id, otherwise null. */
export function sessionIdErrors(params) {
  return isValidObjectIdString(params.sessionId) ? null : [{ field: 'sessionId', message: 'must be an id' }];
}

/** POST /api/internal/nsk/tools/:tool: { actor_token, arguments? } */
export function validateNskToolCall(params, requestBody) {
  if (!isPlainObject(requestBody)) return bodyNotObjectResult();
  const validationErrors = [];
  if (!TOOL_NAME_PATTERN.test(params.tool ?? ''))
    validationErrors.push({ field: 'tool', message: 'must be a tool name' });
  refuseUnknownFields(requestBody, ['actor_token', 'arguments'], validationErrors);
  if (typeof requestBody.actor_token !== 'string')
    validationErrors.push({ field: 'actor_token', message: 'is required' });
  const args = requestBody.arguments ?? {};
  if (!isPlainObject(args)) validationErrors.push({ field: 'arguments', message: 'must be an object' });
  return validationResult(validationErrors, { toolName: params.tool, actorToken: requestBody.actor_token, args });
}
