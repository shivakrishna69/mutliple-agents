/**
 * Every client-facing message the auth flow can return. Controllers, validators, and
 * middleware reference these constants instead of writing strings inline, so wording
 * is reviewed in one place and the frontend can rely on stable text.
 */

import { MESSAGE_FIELD_LIMITS, USER_FIELD_LIMITS, WEBHOOK_FIELD_LIMITS } from './validation.js';

export const AUTH_MESSAGES = Object.freeze({
  REGISTRATION_SUCCESSFUL: 'Account created successfully',
  LOGIN_SUCCESSFUL: 'Logged in successfully',
  LOGOUT_SUCCESSFUL: 'Logged out successfully',
  CURRENT_USER_RETRIEVED: 'Session is active',
  EMAIL_ALREADY_REGISTERED: 'An account with this email already exists',
  // Deliberately identical for "no such email" and "wrong password" so a caller
  // cannot use the login endpoint to discover which emails have accounts.
  INVALID_CREDENTIALS: 'Invalid email or password',
});

export const SESSION_MESSAGES = Object.freeze({
  NOT_AUTHENTICATED: 'You are not signed in',
  SESSION_EXPIRED: 'Your session has expired. Please sign in again',
  SESSION_NOT_YET_VALID: 'Your session is not valid yet. Please sign in again',
  SESSION_INVALID: 'Your session is invalid. Please sign in again',
  SESSION_REVOKED: 'Your session has ended. Please sign in again',
  ACCOUNT_NOT_FOUND: 'The account for this session no longer exists',
  CSRF_TOKEN_INVALID: 'Missing or invalid CSRF token',
});

export const RATE_LIMIT_MESSAGES = Object.freeze({
  TOO_MANY_LOGIN_ATTEMPTS: 'Too many sign-in attempts. Please wait a few minutes and try again',
  TOO_MANY_SIGNUP_ATTEMPTS: 'Too many accounts created from this network. Please try again later',
});

export const VALIDATION_MESSAGES = Object.freeze({
  REQUEST_VALIDATION_FAILED: 'Request validation failed',
  REQUEST_BODY_MUST_BE_OBJECT: 'Request body must be a JSON object',
  NAME_REQUIRED: 'Name is required',
  NAME_MUST_BE_STRING: 'Name must be a string',
  NAME_LENGTH_INVALID: `Name must be between ${USER_FIELD_LIMITS.NAME_MIN_LENGTH} and ${USER_FIELD_LIMITS.NAME_MAX_LENGTH} characters`,
  EMAIL_REQUIRED: 'Email is required',
  EMAIL_MUST_BE_STRING: 'Email must be a string',
  EMAIL_TOO_LONG: `Email must be at most ${USER_FIELD_LIMITS.EMAIL_MAX_LENGTH} characters`,
  EMAIL_FORMAT_INVALID: 'Email format is invalid',
  PASSWORD_REQUIRED: 'Password is required',
  PASSWORD_MUST_BE_STRING: 'Password must be a string',
  PASSWORD_TOO_SHORT: `Password must be at least ${USER_FIELD_LIMITS.PASSWORD_MIN_LENGTH} characters`,
  PASSWORD_TOO_LONG: `Password must be at most ${USER_FIELD_LIMITS.PASSWORD_MAX_BYTES} bytes`,
});

export const WEBHOOK_MESSAGES = Object.freeze({
  MESSAGE_PROCESSED: 'Message processed',
  DUPLICATE_EVENT: 'Event already processed',
  SIGNATURE_MISSING: 'Missing webhook signature headers',
  SIGNATURE_MALFORMED: 'Webhook signature headers are malformed',
  SIGNATURE_EXPIRED: 'Webhook timestamp is outside the allowed window',
  SIGNATURE_INVALID: 'Webhook signature is invalid',
  SENDER_NOT_FOUND: 'Sender is not a registered customer',
  EVENT_ID_REQUIRED: 'eventId is required',
  EVENT_ID_MUST_BE_STRING: 'eventId must be a string',
  EVENT_ID_INVALID: `eventId must be 1-${WEBHOOK_FIELD_LIMITS.EVENT_ID_MAX_LENGTH} printable characters without spaces`,
  SENDER_EMAIL_REQUIRED: 'senderEmail is required',
  SENDER_EMAIL_MUST_BE_STRING: 'senderEmail must be a string',
  SENDER_EMAIL_INVALID: 'senderEmail is not a valid email address',
  TEXT_REQUIRED: 'text is required',
  TEXT_MUST_BE_STRING: 'text must be a string',
  TEXT_TOO_LONG: `text must be at most ${MESSAGE_FIELD_LIMITS.TEXT_MAX_LENGTH} characters`,
});

/** Messages carried in Socket.IO error payloads and acknowledgements. */
export const SOCKET_MESSAGES = Object.freeze({
  ORIGIN_NOT_ALLOWED: 'Origin not allowed',
  INVALID_PAYLOAD: 'Payload must be an object with a valid conversationId',
  CONVERSATION_NOT_ACCESSIBLE: 'Conversation not found or not accessible',
  TOO_MANY_ROOMS: 'Too many conversations joined on this connection',
  RATE_LIMITED: 'Too many requests on this connection; slow down',
  ACCESS_REVOKED: 'You no longer have access to this conversation',
  SESSION_ENDED: 'Your session has ended. Please sign in again',
  SERVER_ERROR: 'Something went wrong. Please try again',
});

/**
 * Text saved as the assistant's reply when the AI service cannot answer. It is shown to the
 * customer, so it explains what happens next rather than what went wrong.
 */
export const CUSTOMER_FACING_MESSAGES = Object.freeze({
  AI_UNAVAILABLE_FALLBACK_REPLY:
    "Sorry, our assistant can't respond right now. We've passed your message to our support team, and a person will reply shortly.",
});

/** One message per PASSWORD_STRENGTH_RULES `ruleId` (constants/validation.js). */
export const PASSWORD_RULE_MESSAGES = Object.freeze({
  uppercaseLetter: 'Password must contain at least one uppercase letter (A-Z)',
  lowercaseLetter: 'Password must contain at least one lowercase letter (a-z)',
  digit: 'Password must contain at least one number (0-9)',
  specialCharacter: 'Password must contain at least one special character',
});
