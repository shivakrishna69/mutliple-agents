/**
 * Pure validation functions for the signup and login forms.
 *
 * Each returns `{ fieldName: message }` for the fields that fail, and accepts or rejects
 * exactly the values the backend validator (backend/validators/authValidators.js) accepts or
 * rejects, checking in the same order. They live outside the page components so they can be
 * tested against the backend validator directly.
 */

import { FORM_MESSAGES } from '../constants/messages.js';
import {
  EMAIL_PATTERN,
  PASSWORD_STRENGTH_RULES,
  USER_FIELD_LIMITS,
  measureUtf8ByteLength,
  normalizeEmail,
} from '../constants/validation.js';

/**
 * Evaluates each password strength rule (see constants/validation.js for the regex behind
 * each one) and returns `[{ ruleId, description, isSatisfied }]` for the live checklist.
 */
export function evaluatePasswordRules(candidatePassword) {
  return PASSWORD_STRENGTH_RULES.map((strengthRule) => ({
    ruleId: strengthRule.ruleId,
    description: strengthRule.description,
    isSatisfied: strengthRule.isSatisfiedBy(candidatePassword),
  }));
}

/** Email: required, at most 254 characters after normalising, and matching EMAIL_PATTERN. */
function validateEmailField(rawEmail) {
  const normalizedEmail = normalizeEmail(rawEmail);
  if (normalizedEmail.length === 0) return FORM_MESSAGES.EMAIL_REQUIRED;
  if (normalizedEmail.length > USER_FIELD_LIMITS.EMAIL_MAX_LENGTH) return FORM_MESSAGES.EMAIL_TOO_LONG;
  // EMAIL_PATTERN requires: non-empty local part, one "@", a domain containing a dot, and no
  // whitespace anywhere. "ada@example" and "ada example.com" both fail here.
  if (!EMAIL_PATTERN.test(normalizedEmail)) return FORM_MESSAGES.EMAIL_INVALID;
  return null;
}

/**
 * Validates every signup field. Order per field matches the backend:
 *   name      required (after trimming) -> 1..100 characters
 *   email     required -> length -> pattern
 *   password  required (whitespace-only counts as empty) -> minimum length -> 72-byte maximum
 *             -> strength rules
 *   confirmPassword  required -> identical to password (frontend-only; never sent to the API)
 */
export function validateSignupForm(formValues) {
  const fieldErrors = {};

  const trimmedName = formValues.name.trim();
  if (trimmedName.length === 0) {
    fieldErrors.name = FORM_MESSAGES.NAME_REQUIRED;
  } else if (trimmedName.length > USER_FIELD_LIMITS.NAME_MAX_LENGTH) {
    fieldErrors.name = FORM_MESSAGES.NAME_TOO_LONG;
  }

  const emailError = validateEmailField(formValues.email);
  if (emailError) fieldErrors.email = emailError;

  if (formValues.password.trim().length === 0) {
    fieldErrors.password = FORM_MESSAGES.PASSWORD_REQUIRED;
  } else if (formValues.password.length < USER_FIELD_LIMITS.PASSWORD_MIN_LENGTH) {
    fieldErrors.password = FORM_MESSAGES.PASSWORD_REQUIREMENTS_NOT_MET;
  } else if (measureUtf8ByteLength(formValues.password) > USER_FIELD_LIMITS.PASSWORD_MAX_BYTES) {
    fieldErrors.password = FORM_MESSAGES.PASSWORD_TOO_LONG;
  } else if (!evaluatePasswordRules(formValues.password).every((ruleResult) => ruleResult.isSatisfied)) {
    fieldErrors.password = FORM_MESSAGES.PASSWORD_REQUIREMENTS_NOT_MET;
  }

  if (formValues.confirmPassword.length === 0) {
    fieldErrors.confirmPassword = FORM_MESSAGES.CONFIRM_PASSWORD_REQUIRED;
  } else if (formValues.confirmPassword !== formValues.password) {
    // Exact comparison, no trimming: a trailing space is a real character in a password.
    fieldErrors.confirmPassword = FORM_MESSAGES.PASSWORDS_DO_NOT_MATCH;
  }

  return fieldErrors;
}

/**
 * Validates the login fields. The password is only checked for presence (whitespace-only
 * counts as empty, as on the backend); strength rules are never applied at login.
 * The email must be well-formed: an address that fails the signup rules cannot belong to an
 * account, so rejecting it locally saves a round trip without changing the outcome.
 */
export function validateLoginForm(formValues) {
  const fieldErrors = {};

  const emailError = validateEmailField(formValues.email);
  if (emailError) fieldErrors.email = emailError;

  if (formValues.password.trim().length === 0) {
    fieldErrors.password = FORM_MESSAGES.PASSWORD_REQUIRED;
  }

  return fieldErrors;
}
