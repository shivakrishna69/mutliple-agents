/**
 * Input validation for the conversation routes. Each validator returns
 * `{ isValid, validationErrors, sanitizedInput }` like the auth and webhook validators.
 */

import { MESSAGE_FIELD_LIMITS } from '../constants/validation.js';
import { CONVERSATION_MESSAGES, VALIDATION_MESSAGES } from '../constants/messages.js';

/** MongoDB ObjectId as 24 hex characters (mongoose.isValidObjectId also accepts any 12-char string). */
const OBJECT_ID_PATTERN = /^[a-f0-9]{24}$/i;

export function isValidObjectIdString(candidateValue) {
  return typeof candidateValue === 'string' && OBJECT_ID_PATTERN.test(candidateValue);
}

/** Validates POST /api/conversations/:conversationId/messages: { text }. */
export function validateAgentReplyInput(requestBody) {
  const isPlainObject = typeof requestBody === 'object' && requestBody !== null && !Array.isArray(requestBody);
  if (!isPlainObject) {
    return {
      isValid: false,
      validationErrors: [{ field: 'body', message: VALIDATION_MESSAGES.REQUEST_BODY_MUST_BE_OBJECT }],
      sanitizedInput: null,
    };
  }

  const { text: rawText } = requestBody;
  let validationError = null;
  if (rawText === undefined || rawText === null) {
    validationError = CONVERSATION_MESSAGES.REPLY_TEXT_REQUIRED;
  } else if (typeof rawText !== 'string') {
    validationError = CONVERSATION_MESSAGES.REPLY_TEXT_MUST_BE_STRING;
  } else if (rawText.trim().length === 0) {
    validationError = CONVERSATION_MESSAGES.REPLY_TEXT_REQUIRED;
  } else if (rawText.trim().length > MESSAGE_FIELD_LIMITS.TEXT_MAX_LENGTH) {
    validationError = CONVERSATION_MESSAGES.REPLY_TEXT_TOO_LONG;
  }

  if (validationError) {
    return { isValid: false, validationErrors: [{ field: 'text', message: validationError }], sanitizedInput: null };
  }
  return { isValid: true, validationErrors: [], sanitizedInput: { text: rawText.trim() } };
}
