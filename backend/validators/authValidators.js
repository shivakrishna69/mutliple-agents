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

import {
  ACCOUNT_EMAIL_SETTINGS,
  EMAIL_PATTERN,
  GENDERS,
  PASSWORD_STRENGTH_RULES,
  PHONE_SETTINGS,
  SIGNUP_PROFILE_SETTINGS,
  USER_FIELD_LIMITS,
} from '../constants/validation.js';
import { PASSWORD_RULE_MESSAGES, VALIDATION_MESSAGES } from '../constants/messages.js';
import { isSupportedPhoneCountry, normalizePhoneNumber } from '../utils/phoneNumbers.js';

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

/** An address someone gives to receive email: present, a string, not too long, well-formed. */
function checkEmailAddress(rawEmail) {
  const presenceError = checkRequiredString(
    rawEmail,
    VALIDATION_MESSAGES.EMAIL_REQUIRED,
    VALIDATION_MESSAGES.EMAIL_MUST_BE_STRING,
  );
  if (presenceError) return presenceError;
  const normalizedEmail = normalizeEmail(rawEmail);
  if (normalizedEmail.length > USER_FIELD_LIMITS.EMAIL_MAX_LENGTH) return VALIDATION_MESSAGES.EMAIL_TOO_LONG;
  if (!EMAIL_PATTERN.test(normalizedEmail)) return VALIDATION_MESSAGES.EMAIL_FORMAT_INVALID;
  return null;
}

const notAnObject = () => ({
  isValid: false,
  validationErrors: [{ field: 'body', message: VALIDATION_MESSAGES.REQUEST_BODY_MUST_BE_OBJECT }],
  sanitizedInput: null,
});

/**
 * The repeated password on forms that set a new one (signup, reset, invitation): present and
 * exactly the same as the password. Checked here, so the screens show the server's message.
 */
function checkPasswordConfirmation(password, confirmPassword) {
  if (typeof confirmPassword !== 'string' || confirmPassword.length === 0) {
    return VALIDATION_MESSAGES.CONFIRM_PASSWORD_REQUIRED;
  }
  return confirmPassword === password ? null : VALIDATION_MESSAGES.PASSWORDS_DO_NOT_MATCH;
}

/** A link token from the request body: present and a string. Its shape is checked by the service. */
function checkLinkToken(rawToken) {
  return checkRequiredString(rawToken, VALIDATION_MESSAGES.TOKEN_REQUIRED, VALIDATION_MESSAGES.TOKEN_MUST_BE_STRING);
}

/**
 * Every rule a newly chosen password must meet (signup and password change): present, at least
 * PASSWORD_MIN_LENGTH characters, at most PASSWORD_MAX_BYTES UTF-8 bytes, and each strength rule.
 * Returns the first failure's message, or null. Not trimmed: spaces are part of the password.
 */
export function checkNewPassword(rawPassword) {
  const presenceError = checkRequiredString(
    rawPassword,
    VALIDATION_MESSAGES.PASSWORD_REQUIRED,
    VALIDATION_MESSAGES.PASSWORD_MUST_BE_STRING,
  );
  if (presenceError) return presenceError;
  if (rawPassword.length < USER_FIELD_LIMITS.PASSWORD_MIN_LENGTH) return VALIDATION_MESSAGES.PASSWORD_TOO_SHORT;
  if (Buffer.byteLength(rawPassword, 'utf8') > USER_FIELD_LIMITS.PASSWORD_MAX_BYTES)
    return VALIDATION_MESSAGES.PASSWORD_TOO_LONG;
  // The first unmet strength rule; one message per field keeps the response shape uniform.
  const firstUnmetRule = PASSWORD_STRENGTH_RULES.find((strengthRule) => !strengthRule.pattern.test(rawPassword));
  return firstUnmetRule ? PASSWORD_RULE_MESSAGES[firstUnmetRule.ruleId] : null;
}

/**
 * Validates POST /api/auth/password: { currentPassword, newPassword }. The current password is only
 * checked for presence (the controller verifies it against the stored hash); the new one must meet
 * every signup rule and differ from the current one.
 */
export function validateChangePasswordInput(requestBody) {
  if (!isPlainObject(requestBody)) {
    return {
      isValid: false,
      validationErrors: [{ field: 'body', message: VALIDATION_MESSAGES.REQUEST_BODY_MUST_BE_OBJECT }],
      sanitizedInput: null,
    };
  }
  const { currentPassword: rawCurrentPassword, newPassword: rawNewPassword } = requestBody;
  const validationErrors = [];

  const currentPasswordError = checkRequiredString(
    rawCurrentPassword,
    VALIDATION_MESSAGES.PASSWORD_REQUIRED,
    VALIDATION_MESSAGES.PASSWORD_MUST_BE_STRING,
  );
  if (currentPasswordError) validationErrors.push({ field: 'currentPassword', message: currentPasswordError });

  const newPasswordError = checkNewPassword(rawNewPassword);
  if (newPasswordError) {
    validationErrors.push({ field: 'newPassword', message: newPasswordError });
  } else if (!currentPasswordError && rawNewPassword === rawCurrentPassword) {
    validationErrors.push({ field: 'newPassword', message: VALIDATION_MESSAGES.NEW_PASSWORD_SAME_AS_CURRENT });
  }

  if (validationErrors.length > 0) {
    return { isValid: false, validationErrors, sanitizedInput: null };
  }
  return {
    isValid: true,
    validationErrors: [],
    sanitizedInput: { currentPassword: rawCurrentPassword, newPassword: rawNewPassword },
  };
}

/** A first or last name: present, a string, and within `maxLength` once trimmed. */
function checkNamePart(rawValue, maxLength, messages) {
  const presenceError = checkRequiredString(rawValue, messages.required, messages.notString);
  if (presenceError) return presenceError;
  return rawValue.trim().length > maxLength ? messages.tooLong : null;
}

const GENDER_VALUES = new Set(Object.values(GENDERS));

/** "YYYY-MM-DD" years before `now`'s calendar date (UTC); 29 February falls back to 28 February. */
function yearsBefore(now, years) {
  const date = new Date(Date.UTC(now.getUTCFullYear() - years, now.getUTCMonth(), now.getUTCDate()));
  if (date.getUTCMonth() !== now.getUTCMonth()) date.setUTCDate(0);
  return date;
}

/**
 * A date of birth sent as "YYYY-MM-DD": a real calendar date, at least MINIMUM_AGE_YEARS and at
 * most MAXIMUM_AGE_YEARS before today (UTC).
 * @returns {{ error: string|null, date: Date|null }}  the date at midnight UTC
 */
function readBirthDate(rawValue, isRequired, now) {
  if (rawValue === undefined || rawValue === null || rawValue === '') {
    return { error: isRequired ? VALIDATION_MESSAGES.BIRTH_DATE_REQUIRED : null, date: null };
  }
  if (typeof rawValue !== 'string' || !SIGNUP_PROFILE_SETTINGS.BIRTH_DATE_PATTERN.test(rawValue)) {
    return { error: VALIDATION_MESSAGES.BIRTH_DATE_INVALID, date: null };
  }
  const date = new Date(`${rawValue}T00:00:00.000Z`);
  // "2001-02-30" parses as 2 March; a real date reads back as itself.
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== rawValue) {
    return { error: VALIDATION_MESSAGES.BIRTH_DATE_INVALID, date: null };
  }
  if (date > yearsBefore(now, SIGNUP_PROFILE_SETTINGS.MINIMUM_AGE_YEARS)) {
    return { error: VALIDATION_MESSAGES.BIRTH_DATE_TOO_YOUNG, date: null };
  }
  if (date < yearsBefore(now, SIGNUP_PROFILE_SETTINGS.MAXIMUM_AGE_YEARS)) {
    return { error: VALIDATION_MESSAGES.BIRTH_DATE_TOO_OLD, date: null };
  }
  return { error: null, date };
}

/** @returns {{ error: string|null, gender: string|null }} one of GENDERS, or null when not given */
function readGender(rawValue, isRequired) {
  if (rawValue === undefined || rawValue === null || rawValue === '') {
    return { error: isRequired ? VALIDATION_MESSAGES.GENDER_REQUIRED : null, gender: null };
  }
  return GENDER_VALUES.has(rawValue)
    ? { error: null, gender: rawValue }
    : { error: VALIDATION_MESSAGES.GENDER_INVALID, gender: null };
}

/**
 * Validates POST /signup: { firstName, lastName, email, phoneCountry, phoneNumber, dateOfBirth,
 * gender, password, confirmPassword, acceptTerms }, with the same limits as the User model, the
 * password strength rules, a phone number that can exist in the picked country (phoneCountry, an
 * ISO code; PHONE_SETTINGS.DEFAULT_COUNTRY when left out; utils/phoneNumbers.js), a date of birth
 * and gender (required once SIGNUP_PROFILE_SETTINGS.BIRTH_DATE_AND_GENDER_REQUIRED is on; checked
 * whenever sent) and the terms accepted (acceptTerms must be exactly true).
 * The password is not trimmed: leading or trailing spaces are part of what the user typed.
 *
 * This is the authoritative check for password strength. The User model cannot enforce it,
 * because after the first save the field holds a bcrypt hash rather than the password, so any
 * code path that creates users must pass its input through this validator first.
 */
export function validateRegistrationInput(
  requestBody,
  { now = new Date(), requireBirthDateAndGender = SIGNUP_PROFILE_SETTINGS.BIRTH_DATE_AND_GENDER_REQUIRED } = {},
) {
  if (!isPlainObject(requestBody)) return notAnObject();

  const { firstName, lastName, email, phoneNumber, password, confirmPassword, acceptTerms } = requestBody;
  const { phoneCountry = PHONE_SETTINGS.DEFAULT_COUNTRY, dateOfBirth, gender } = requestBody;
  const validationErrors = [];
  const fail = (field, message) => validationErrors.push({ field, message });

  const firstNameError = checkNamePart(firstName, USER_FIELD_LIMITS.GIVEN_NAME_MAX_LENGTH, {
    required: VALIDATION_MESSAGES.FIRST_NAME_REQUIRED,
    notString: VALIDATION_MESSAGES.FIRST_NAME_MUST_BE_STRING,
    tooLong: VALIDATION_MESSAGES.FIRST_NAME_TOO_LONG,
  });
  if (firstNameError) fail('firstName', firstNameError);
  const lastNameError = checkNamePart(lastName, USER_FIELD_LIMITS.FAMILY_NAME_MAX_LENGTH, {
    required: VALIDATION_MESSAGES.LAST_NAME_REQUIRED,
    notString: VALIDATION_MESSAGES.LAST_NAME_MUST_BE_STRING,
    tooLong: VALIDATION_MESSAGES.LAST_NAME_TOO_LONG,
  });
  if (lastNameError) fail('lastName', lastNameError);

  const emailError = checkEmailAddress(email);
  if (emailError) fail('email', emailError);

  const phoneError = checkRequiredString(
    phoneNumber,
    VALIDATION_MESSAGES.PHONE_REQUIRED,
    VALIDATION_MESSAGES.PHONE_MUST_BE_STRING,
  );
  const countryIsKnown = isSupportedPhoneCountry(phoneCountry);
  if (!countryIsKnown) fail('phoneCountry', VALIDATION_MESSAGES.PHONE_COUNTRY_INVALID);
  const normalizedPhone = phoneError || !countryIsKnown ? null : normalizePhoneNumber(phoneNumber, phoneCountry);
  if (phoneError) fail('phoneNumber', phoneError);
  else if (countryIsKnown && !normalizedPhone) fail('phoneNumber', VALIDATION_MESSAGES.PHONE_INVALID);

  const birthDate = readBirthDate(dateOfBirth, requireBirthDateAndGender, now);
  if (birthDate.error) fail('dateOfBirth', birthDate.error);
  const genderChoice = readGender(gender, requireBirthDateAndGender);
  if (genderChoice.error) fail('gender', genderChoice.error);

  const passwordError = checkNewPassword(password);
  if (passwordError) fail('password', passwordError);
  const confirmationError = checkPasswordConfirmation(password, confirmPassword);
  if (confirmationError) fail('confirmPassword', confirmationError);

  if (acceptTerms !== true) fail('acceptTerms', VALIDATION_MESSAGES.TERMS_NOT_ACCEPTED);

  if (validationErrors.length > 0) return { isValid: false, validationErrors, sanitizedInput: null };

  const trimmedFirstName = firstName.trim();
  const trimmedLastName = lastName.trim();
  return {
    isValid: true,
    validationErrors: [],
    sanitizedInput: {
      firstName: trimmedFirstName,
      lastName: trimmedLastName,
      name: `${trimmedFirstName} ${trimmedLastName}`,
      email: normalizeEmail(email),
      phoneNumber: normalizedPhone,
      dateOfBirth: birthDate.date,
      gender: genderChoice.gender,
      password,
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

  const { email: rawEmail, password: rawPassword, rememberDevice = false } = requestBody;
  const validationErrors = [];

  const emailError = checkRequiredString(
    rawEmail,
    VALIDATION_MESSAGES.EMAIL_REQUIRED,
    VALIDATION_MESSAGES.EMAIL_MUST_BE_STRING,
  );
  if (emailError) validationErrors.push({ field: 'email', message: emailError });

  const passwordError = checkRequiredString(
    rawPassword,
    VALIDATION_MESSAGES.PASSWORD_REQUIRED,
    VALIDATION_MESSAGES.PASSWORD_MUST_BE_STRING,
  );
  if (passwordError) validationErrors.push({ field: 'password', message: passwordError });

  // Optional; only a real boolean counts, so "false" (a string) is not read as yes.
  if (typeof rememberDevice !== 'boolean') {
    validationErrors.push({ field: 'rememberDevice', message: VALIDATION_MESSAGES.REMEMBER_DEVICE_MUST_BE_BOOLEAN });
  }

  if (validationErrors.length > 0) {
    return { isValid: false, validationErrors, sanitizedInput: null };
  }

  return {
    isValid: true,
    validationErrors: [],
    sanitizedInput: { email: normalizeEmail(rawEmail), password: rawPassword, rememberDevice },
  };
}

/**
 * Validates POST /verify-email/resend and POST /password/forgot: { email }. The address must be
 * well-formed (the request asks for an email to be sent to it); whether it has an account is never
 * part of the answer.
 */
export function validateEmailRequestInput(requestBody) {
  if (!isPlainObject(requestBody)) return notAnObject();
  const emailError = checkEmailAddress(requestBody.email);
  if (emailError) {
    return { isValid: false, validationErrors: [{ field: 'email', message: emailError }], sanitizedInput: null };
  }
  return { isValid: true, validationErrors: [], sanitizedInput: { email: normalizeEmail(requestBody.email) } };
}

const VERIFICATION_CODE_PATTERN = new RegExp(`^\\d{${ACCOUNT_EMAIL_SETTINGS.VERIFICATION_CODE_DIGITS}}$`);

/**
 * Validates POST /verify-email: either { token } (the emailed link) or { email, code } (the code from
 * the same email, typed in). Without a token, both email and code are required.
 * @returns sanitizedInput `{ token }` or `{ email, code }`
 */
export function validateVerifyEmailInput(requestBody) {
  if (!isPlainObject(requestBody)) return notAnObject();
  const { token, email, code } = requestBody;
  if (token !== undefined || (email === undefined && code === undefined)) {
    const tokenError = checkLinkToken(token);
    if (tokenError) {
      return { isValid: false, validationErrors: [{ field: 'token', message: tokenError }], sanitizedInput: null };
    }
    return { isValid: true, validationErrors: [], sanitizedInput: { token } };
  }

  const validationErrors = [];
  const emailError = checkEmailAddress(email);
  if (emailError) validationErrors.push({ field: 'email', message: emailError });
  const trimmedCode = typeof code === 'string' ? code.trim() : null;
  if (trimmedCode === null || !VERIFICATION_CODE_PATTERN.test(trimmedCode)) {
    validationErrors.push({ field: 'code', message: VALIDATION_MESSAGES.VERIFICATION_CODE_FORMAT });
  }
  if (validationErrors.length > 0) return { isValid: false, validationErrors, sanitizedInput: null };
  return { isValid: true, validationErrors: [], sanitizedInput: { email: normalizeEmail(email), code: trimmedCode } };
}

/**
 * Validates POST /password/reset: { token, password, confirmPassword }. The new password must meet
 * every signup rule; it is checked before the link is used up, so a weak password does not waste
 * the link.
 */
export function validatePasswordResetInput(requestBody) {
  if (!isPlainObject(requestBody)) return notAnObject();
  const validationErrors = [];
  const tokenError = checkLinkToken(requestBody.token);
  if (tokenError) validationErrors.push({ field: 'token', message: tokenError });
  const passwordError = checkNewPassword(requestBody.password);
  if (passwordError) validationErrors.push({ field: 'password', message: passwordError });
  const confirmationError = checkPasswordConfirmation(requestBody.password, requestBody.confirmPassword);
  if (confirmationError) validationErrors.push({ field: 'confirmPassword', message: confirmationError });
  if (validationErrors.length > 0) return { isValid: false, validationErrors, sanitizedInput: null };
  return {
    isValid: true,
    validationErrors: [],
    sanitizedInput: { token: requestBody.token, password: requestBody.password },
  };
}

/**
 * Validates POST /api/invitations/:token/accept: { password, confirmPassword, acceptTerms }. The
 * password must meet every signup rule, and the person must agree to the terms and privacy policy,
 * as at signup.
 */
export function validateInvitationAcceptance(requestBody) {
  if (!isPlainObject(requestBody)) return notAnObject();
  const validationErrors = [];
  const passwordError = checkNewPassword(requestBody.password);
  if (passwordError) validationErrors.push({ field: 'password', message: passwordError });
  const confirmationError = checkPasswordConfirmation(requestBody.password, requestBody.confirmPassword);
  if (confirmationError) validationErrors.push({ field: 'confirmPassword', message: confirmationError });
  if (requestBody.acceptTerms !== true) {
    validationErrors.push({ field: 'acceptTerms', message: VALIDATION_MESSAGES.TERMS_NOT_ACCEPTED });
  }
  if (validationErrors.length > 0) return { isValid: false, validationErrors, sanitizedInput: null };
  return { isValid: true, validationErrors: [], sanitizedInput: { password: requestBody.password } };
}
