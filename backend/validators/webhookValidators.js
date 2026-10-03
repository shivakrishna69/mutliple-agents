/**
 * Request-body validation for POST /api/webhooks/incoming.
 *
 * Expected body:
 *   {
 *     "eventId":     string, 1–200 printable characters, no whitespace. The sender's unique id
 *                    for this message; a repeated eventId is treated as a redelivery.
 *     "senderEmail": string, the registered customer's email (normalised like at signup).
 *     "text":        string, 1–20,000 characters after trimming.
 *   }
 *
 * Returns `{ isValid, validationErrors, sanitizedInput }` like the auth validators. Every field
 * is type-checked before use, so objects such as {"$ne": null} never reach a MongoDB query.
 * Unknown fields are dropped from `sanitizedInput`.
 */

import {
  EMAIL_PATTERN,
  MESSAGE_FIELD_LIMITS,
  USER_FIELD_LIMITS,
  WEBHOOK_EVENT_ID_PATTERN,
  WEBHOOK_FIELD_LIMITS,
} from '../constants/validation.js';
import { VALIDATION_MESSAGES, WEBHOOK_MESSAGES } from '../constants/messages.js';

function isPlainObject(requestBody) {
  return typeof requestBody === 'object' && requestBody !== null && !Array.isArray(requestBody);
}

export function validateIncomingMessagePayload(requestBody) {
  if (!isPlainObject(requestBody)) {
    return {
      isValid: false,
      validationErrors: [{ field: 'body', message: VALIDATION_MESSAGES.REQUEST_BODY_MUST_BE_OBJECT }],
      sanitizedInput: null,
    };
  }

  const { eventId: rawEventId, senderEmail: rawSenderEmail, text: rawText } = requestBody;
  const validationErrors = [];

  if (rawEventId === undefined || rawEventId === null || rawEventId === '') {
    validationErrors.push({ field: 'eventId', message: WEBHOOK_MESSAGES.EVENT_ID_REQUIRED });
  } else if (typeof rawEventId !== 'string') {
    validationErrors.push({ field: 'eventId', message: WEBHOOK_MESSAGES.EVENT_ID_MUST_BE_STRING });
  } else if (rawEventId.length > WEBHOOK_FIELD_LIMITS.EVENT_ID_MAX_LENGTH || !WEBHOOK_EVENT_ID_PATTERN.test(rawEventId)) {
    validationErrors.push({ field: 'eventId', message: WEBHOOK_MESSAGES.EVENT_ID_INVALID });
  }

  let normalizedSenderEmail = null;
  if (rawSenderEmail === undefined || rawSenderEmail === null) {
    validationErrors.push({ field: 'senderEmail', message: WEBHOOK_MESSAGES.SENDER_EMAIL_REQUIRED });
  } else if (typeof rawSenderEmail !== 'string') {
    validationErrors.push({ field: 'senderEmail', message: WEBHOOK_MESSAGES.SENDER_EMAIL_MUST_BE_STRING });
  } else {
    // Same normalisation as signup, so the lookup matches how the email was stored.
    normalizedSenderEmail = rawSenderEmail.trim().toLowerCase();
    if (normalizedSenderEmail.length === 0) {
      validationErrors.push({ field: 'senderEmail', message: WEBHOOK_MESSAGES.SENDER_EMAIL_REQUIRED });
    } else if (
      normalizedSenderEmail.length > USER_FIELD_LIMITS.EMAIL_MAX_LENGTH ||
      !EMAIL_PATTERN.test(normalizedSenderEmail)
    ) {
      validationErrors.push({ field: 'senderEmail', message: WEBHOOK_MESSAGES.SENDER_EMAIL_INVALID });
    }
  }

  let trimmedText = null;
  if (rawText === undefined || rawText === null) {
    validationErrors.push({ field: 'text', message: WEBHOOK_MESSAGES.TEXT_REQUIRED });
  } else if (typeof rawText !== 'string') {
    validationErrors.push({ field: 'text', message: WEBHOOK_MESSAGES.TEXT_MUST_BE_STRING });
  } else {
    // Trimmed here because the Message model trims on save; validating the same string it stores.
    trimmedText = rawText.trim();
    if (trimmedText.length === 0) {
      validationErrors.push({ field: 'text', message: WEBHOOK_MESSAGES.TEXT_REQUIRED });
    } else if (trimmedText.length > MESSAGE_FIELD_LIMITS.TEXT_MAX_LENGTH) {
      validationErrors.push({ field: 'text', message: WEBHOOK_MESSAGES.TEXT_TOO_LONG });
    }
  }

  if (validationErrors.length > 0) {
    return { isValid: false, validationErrors, sanitizedInput: null };
  }

  return {
    isValid: true,
    validationErrors: [],
    sanitizedInput: { eventId: rawEventId, senderEmail: normalizedSenderEmail, text: trimmedText },
  };
}
