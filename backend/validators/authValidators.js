/**
 * Request-body validation for the auth endpoints.
 *
 * Each validator returns `{ isValid, validationErrors, sanitizedInput }`:
 *   - `validationErrors` lists every failing field at once (not just the first), so the
 *     client can show all problems in one round trip.
 *   - `sanitizedInput` contains only the expected fields, trimmed and normalised. Controllers
 *     use it instead of `req.body`, so unexpected fields (such as `role`) can never reach the
 *     database.
 *
 * Every field is checked to be a string before it is used. Without this, a body such as
 * `{"email": {"$ne": null}}` would pass an object into a MongoDB query (NoSQL injection).
 */

import { EMAIL_PATTERN, PASSWORD_STRENGTH_RULES, USER_FIELD_LIMITS } from '../constants/validation.js';
import { PASSWORD_RULE_MESSAGES, VALIDATION_MESSAGES } from '../constants/messages.js';

/** True when `requestBody` is a plain JSON object (not undefined, null, or an array). */
function isPlainObject(requestBody) {
  return typeof requestBody === 'object' && requestBody !== null && !Array.isArray(requestBody);
}

/**
 * Checks that a field is present and a string. Returns an error message, or null if it passes.
 * An empty or whitespace-only string counts as missing.
 */
function checkRequiredString(fieldValue, requiredMessage, typeMessage) {
  if (fieldValue === undefined || fieldValue === null) return requiredMessage;
  if (typeof fieldValue !== 'string') return typeMessage;
  if (fieldValue.trim().length === 0) return requiredMessage;
  return null;
}

/** Lowercases and trims an email, matching how the User model stores it. */
function normalizeEmail(rawEmail) {
  return rawEmail.trim().toLowerCase();
}

/**
 * Validates POST /signup: name, email, and password, with the same limits as the User model,
 * plus the password strength rules (uppercase, lowercase, digit, special character).
 * The password is not trimmed: leading or trailing spaces are part of what the user typed.
 *
 * This is the authoritative check for password strength. The User model cannot enforce it,
 * because after the first save the field holds a bcrypt hash rather than the password, so any
 * code path that creates users must pass its input through this validator first.
 */
export function validateRegistrationInput(requestBody) {
  if (!isPlainObject(requestBody)) {
    return {
      isValid: false,
      validationErrors: [{ field: 'body', message: VALIDATION_MESSAGES.REQUEST_BODY_MUST_BE_OBJECT }],
      sanitizedInput: null,
    };
  }

  const { name: rawName, email: rawEmail, password: rawPassword } = requestBody;
  const validationErrors = [];

  const nameError = checkRequiredString(rawName, VALIDATION_MESSAGES.NAME_REQUIRED, VALIDATION_MESSAGES.NAME_MUST_BE_STRING);
  if (nameError) {
    validationErrors.push({ field: 'name', message: nameError });
  } else {
    const trimmedNameLength = rawName.trim().length;
    if (
      trimmedNameLength < USER_FIELD_LIMITS.NAME_MIN_LENGTH ||
      trimmedNameLength > USER_FIELD_LIMITS.NAME_MAX_LENGTH
    ) {
      validationErrors.push({ field: 'name', message: VALIDATION_MESSAGES.NAME_LENGTH_INVALID });
    }
  }

  const emailError = checkRequiredString(rawEmail, VALIDATION_MESSAGES.EMAIL_REQUIRED, VALIDATION_MESSAGES.EMAIL_MUST_BE_STRING);
  if (emailError) {
    validationErrors.push({ field: 'email', message: emailError });
  } else {
    const normalizedEmail = normalizeEmail(rawEmail);
    if (normalizedEmail.length > USER_FIELD_LIMITS.EMAIL_MAX_LENGTH) {
      validationErrors.push({ field: 'email', message: VALIDATION_MESSAGES.EMAIL_TOO_LONG });
    } else if (!EMAIL_PATTERN.test(normalizedEmail)) {
      validationErrors.push({ field: 'email', message: VALIDATION_MESSAGES.EMAIL_FORMAT_INVALID });
    }
  }

  const passwordError = checkRequiredString(
    rawPassword,
    VALIDATION_MESSAGES.PASSWORD_REQUIRED,
    VALIDATION_MESSAGES.PASSWORD_MUST_BE_STRING,
  );
  if (passwordError) {
    validationErrors.push({ field: 'password', message: passwordError });
  } else if (rawPassword.length < USER_FIELD_LIMITS.PASSWORD_MIN_LENGTH) {
    validationErrors.push({ field: 'password', message: VALIDATION_MESSAGES.PASSWORD_TOO_SHORT });
  } else if (Buffer.byteLength(rawPassword, 'utf8') > USER_FIELD_LIMITS.PASSWORD_MAX_BYTES) {
    validationErrors.push({ field: 'password', message: VALIDATION_MESSAGES.PASSWORD_TOO_LONG });
  } else {
    // Report the first unmet strength rule; one message per field keeps the response shape
    // the same as every other field's.
    const firstUnmetRule = PASSWORD_STRENGTH_RULES.find((strengthRule) => !strengthRule.pattern.test(rawPassword));
    if (firstUnmetRule) {
      validationErrors.push({ field: 'password', message: PASSWORD_RULE_MESSAGES[firstUnmetRule.ruleId] });
    }
  }

  if (validationErrors.length > 0) {
    return { isValid: false, validationErrors, sanitizedInput: null };
  }

  return {
    isValid: true,
    validationErrors: [],
    sanitizedInput: {
      name: rawName.trim(),
      email: normalizeEmail(rawEmail),
      password: rawPassword,
    },
  };
}

/**
 * Validates POST /login: email and password must be present, non-empty strings.
 * Format and length rules are intentionally not applied here: telling a caller that a
 * password is "too short" would leak the password policy on every attempt, and a wrong
 * value is already rejected by the credential check with the generic message.
 */
export function validateLoginInput(requestBody) {
  if (!isPlainObject(requestBody)) {
    return {
      isValid: false,
      validationErrors: [{ field: 'body', message: VALIDATION_MESSAGES.REQUEST_BODY_MUST_BE_OBJECT }],
      sanitizedInput: null,
    };
  }

  const { email: rawEmail, password: rawPassword } = requestBody;
  const validationErrors = [];

  const emailError = checkRequiredString(rawEmail, VALIDATION_MESSAGES.EMAIL_REQUIRED, VALIDATION_MESSAGES.EMAIL_MUST_BE_STRING);
  if (emailError) validationErrors.push({ field: 'email', message: emailError });

  const passwordError = checkRequiredString(
    rawPassword,
    VALIDATION_MESSAGES.PASSWORD_REQUIRED,
    VALIDATION_MESSAGES.PASSWORD_MUST_BE_STRING,
  );
  if (passwordError) validationErrors.push({ field: 'password', message: passwordError });

  if (validationErrors.length > 0) {
    return { isValid: false, validationErrors, sanitizedInput: null };
  }

  return {
    isValid: true,
    validationErrors: [],
    sanitizedInput: { email: normalizeEmail(rawEmail), password: rawPassword },
  };
}
