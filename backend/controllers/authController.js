/**
 * Authentication controllers: login, current session, logout and password change. Signup with
 * email confirmation and password reset are in controllers/accountEmailController.js.
 *
 * Session model (see utils/authToken.js and utils/authCookies.js):
 *   - Login and email confirmation put the session JWT and its CSRF token in HttpOnly, SameSite=Strict
 *     cookies. The JWT itself is never returned in a response body, so frontend JavaScript
 *     (and therefore any XSS payload) never has access to it.
 *   - The CSRF token is also returned in the response body. The frontend keeps it in memory and
 *     sends it in the X-CSRF-Token header on state-changing requests.
 *
 * Error handling contract (applies to every handler in this file):
 *   - Expected failures (invalid input, duplicate email, wrong credentials, broken session) are
 *     answered directly with `sendError` and a 4xx status.
 *   - Anything unexpected (database unavailable, signing failure) is passed to `next(error)`.
 *     The central error handler in server.js logs it with its stack trace and request id and
 *     returns a 500 without exposing internals in production.
 *
 * No handler logs email addresses, passwords, or tokens. Logs identify users by `userId` only.
 */

import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import User, { ACCOUNT_STATUSES, BCRYPT_SALT_ROUNDS } from '../models/User.js';
import RevokedSession from '../models/RevokedSession.js';
import {
  ACCOUNT_EMAIL_MESSAGES,
  ACCOUNT_MESSAGES,
  AUTH_MESSAGES,
  GENDER_LABELS,
  SESSION_MESSAGES,
  VALIDATION_MESSAGES,
} from '../constants/messages.js';
import { HTTP_STATUS } from '../constants/httpStatus.js';
import { sendCodedError, sendError, sendSuccess } from '../utils/apiResponse.js';
import {
  clearSessionCookies,
  readRequestCookie,
  resolveCsrfTokenCookieName,
  setSessionCookies,
} from '../utils/authCookies.js';
import { isCsrfTokenValid, issueSessionTokens } from '../utils/authToken.js';
import { toPublicUserProfile } from '../utils/userProfile.js';
import { SOCKET_ERROR_CODES, disconnectSessionSockets, disconnectUserSockets } from '../utils/socketManager.js';
import { logger } from '../utils/logger.js';
import { validateChangePasswordInput, validateLoginInput } from '../validators/authValidators.js';
import { isDuplicateKeyError } from '../utils/mongoErrors.js';
import { describePasswordPolicy } from '../services/passwordPolicy.js';
import { ACCOUNT_EMAIL_SETTINGS, PHONE_SETTINGS, SIGNUP_PROFILE_SETTINGS } from '../constants/validation.js';
import { listPhoneCountries } from '../utils/phoneNumbers.js';

/** Both answers change only with a deployment, so browsers may reuse them for a while. */
const PUBLIC_AUTH_SETTINGS_CACHE_SECONDS = 300;

/**
 * GET /api/auth/password-policy   (public)
 *
 * The password checklist and strength meter for the signup and reset screens, built from the rules
 * the server enforces (services/passwordPolicy.js).
 */
export function getPasswordPolicy(req, res) {
  res.set('Cache-Control', `public, max-age=${PUBLIC_AUTH_SETTINGS_CACHE_SECONDS}`);
  return sendSuccess(res, HTTP_STATUS.OK, AUTH_MESSAGES.PASSWORD_POLICY_RETRIEVED, describePasswordPolicy());
}

/**
 * GET /api/auth/options   (public)
 *
 * What the sign-in screens state or offer, as this server is configured: how long "remember this
 * device" lasts, how many digits the emailed codes have (confirmation and password reset), how long
 * a reset code and link work; at signup, whether date of birth and gender are required, the minimum
 * age, the gender choices (in order), and the phone country picker's countries and starting country.
 */
export function getAuthOptions(req, res) {
  res.set('Cache-Control', `public, max-age=${PUBLIC_AUTH_SETTINGS_CACHE_SECONDS}`);
  return sendSuccess(res, HTTP_STATUS.OK, AUTH_MESSAGES.AUTH_OPTIONS_RETRIEVED, {
    rememberedSessionDays: req.app.locals.config.rememberedSessionDays,
    verificationCodeDigits: ACCOUNT_EMAIL_SETTINGS.VERIFICATION_CODE_DIGITS,
    passwordResetLinkMinutes: ACCOUNT_EMAIL_SETTINGS.PASSWORD_RESET_VALIDITY_MS / 60_000,
    birthDateAndGenderRequired: SIGNUP_PROFILE_SETTINGS.BIRTH_DATE_AND_GENDER_REQUIRED,
    minimumSignupAgeYears: SIGNUP_PROFILE_SETTINGS.MINIMUM_AGE_YEARS,
    genders: Object.entries(GENDER_LABELS).map(([value, label]) => ({ value, label })),
    defaultPhoneCountry: PHONE_SETTINGS.DEFAULT_COUNTRY,
    phoneCountries: listPhoneCountries(),
  });
}

/** Code of the 403 a correct password gets while the account's email is still unconfirmed. */
export const EMAIL_NOT_VERIFIED_CODE = 'EMAIL_NOT_VERIFIED';

/**
 * A bcrypt hash of a random value nobody knows, computed once at startup at the same cost
 * as real password hashes. When a login names an email that has no account, the password is
 * still compared against this hash, so the response takes as long as a real wrong-password
 * attempt. Without it, the fast "no such user" path would reveal which emails are registered,
 * even though the response message is identical.
 */
const TIMING_EQUALIZATION_HASH = bcrypt.hashSync(randomBytes(32).toString('hex'), BCRYPT_SALT_ROUNDS);

/**
 * Issues a new session for `userId`, writes the session cookies, and returns the CSRF token
 * that the response body hands to the frontend. Also used when an email is confirmed.
 */
export function startSession(res, authConfig, userId, { remember = false } = {}) {
  const sessionTokens = issueSessionTokens(userId, authConfig, { remember });
  setSessionCookies(res, authConfig, sessionTokens);
  return sessionTokens.csrfToken;
}

/**
 * POST /api/auth/login
 *
 * Request body: { email: string, password: string, rememberDevice?: boolean }
 *   rememberDevice: stay signed in on this device for REMEMBERED_SESSION_DAYS; otherwise the session
 *   ends when the browser closes.
 * Responses:
 *   200 { message, data: { user, csrfToken } } + session cookies   Credentials are correct.
 *   400 { error: { message, requestId, details } }  Email or password missing or not a string.
 *   401 { error: { message, requestId } }         Unknown email or wrong password (same message for both).
 *   403 { error: { message, code: EMAIL_NOT_VERIFIED, requestId } }
 *                                                 Right password, but the email is not confirmed yet.
 *   429                                           Login rate limit reached (middleware).
 *   500                                           Unexpected failure, via the central error handler.
 *
 * Security decisions:
 *   - Unknown email and wrong password return the same status, the same message, and take the
 *     same time (see TIMING_EQUALIZATION_HASH), so the endpoint cannot be used to discover
 *     which emails are registered.
 *   - Strength rules are not applied to login input: rejecting a password as "too weak" here
 *     would reveal the policy on every attempt and lock out accounts created under older rules.
 *   - The password hash is loaded with `.select('+password')` only here.
 *   - Each login issues a brand-new session (new jti and CSRF token), so a session identifier
 *     planted before login can never become authenticated (session fixation).
 */
export async function loginUser(req, res, next) {
  try {
    const loginValidation = validateLoginInput(req.body);
    if (!loginValidation.isValid) {
      return sendError(
        req,
        res,
        HTTP_STATUS.BAD_REQUEST,
        VALIDATION_MESSAGES.REQUEST_VALIDATION_FAILED,
        loginValidation.validationErrors,
      );
    }

    const { email, password, rememberDevice } = loginValidation.sanitizedInput;

    const userRecord = await User.findOne({ email }).select('+password');

    if (!userRecord) {
      // Spend the same bcrypt work as a real comparison before answering; the result is discarded.
      await bcrypt.compare(password, TIMING_EQUALIZATION_HASH);
      logger.warn('Login failed', { requestId: req.id, reason: 'unknown_email' });
      return sendError(req, res, HTTP_STATUS.UNAUTHORIZED, AUTH_MESSAGES.INVALID_CREDENTIALS);
    }

    // A signup whose email is not confirmed yet: told so only with the right password (the same bcrypt
    // work either way), so the answer reveals nothing to someone who does not know it.
    if (userRecord.status === ACCOUNT_STATUSES.UNVERIFIED) {
      if (!(await userRecord.comparePassword(password))) {
        logger.warn('Login failed', { requestId: req.id, reason: 'wrong_password', userId: userRecord._id.toString() });
        return sendError(req, res, HTTP_STATUS.UNAUTHORIZED, AUTH_MESSAGES.INVALID_CREDENTIALS);
      }
      logger.warn('Login refused', {
        requestId: req.id,
        reason: 'email_not_verified',
        userId: userRecord._id.toString(),
      });
      return sendCodedError(req, res, HTTP_STATUS.FORBIDDEN, {
        code: EMAIL_NOT_VERIFIED_CODE,
        message: ACCOUNT_EMAIL_MESSAGES.EMAIL_NOT_VERIFIED,
      });
    }

    // Invited (no password yet) and disabled accounts cannot sign in. Same answer and the same
    // bcrypt work as a wrong password, so the response does not reveal that the account exists.
    if ((userRecord.status ?? ACCOUNT_STATUSES.ACTIVE) !== ACCOUNT_STATUSES.ACTIVE) {
      await bcrypt.compare(password, TIMING_EQUALIZATION_HASH);
      logger.warn('Login failed', {
        requestId: req.id,
        reason: 'account_not_active',
        userId: userRecord._id.toString(),
      });
      return sendError(req, res, HTTP_STATUS.UNAUTHORIZED, AUTH_MESSAGES.INVALID_CREDENTIALS);
    }

    const isPasswordValid = await userRecord.comparePassword(password);
    if (!isPasswordValid) {
      logger.warn('Login failed', { requestId: req.id, reason: 'wrong_password', userId: userRecord._id.toString() });
      return sendError(req, res, HTTP_STATUS.UNAUTHORIZED, AUTH_MESSAGES.INVALID_CREDENTIALS);
    }

    const csrfToken = startSession(res, req.app.locals.config, userRecord._id, { remember: rememberDevice });

    logger.info('User logged in', { requestId: req.id, userId: userRecord._id.toString() });

    return sendSuccess(res, HTTP_STATUS.OK, AUTH_MESSAGES.LOGIN_SUCCESSFUL, {
      user: toPublicUserProfile(userRecord),
      csrfToken,
    });
  } catch (error) {
    return next(error);
  }
}

/**
 * GET /api/auth/me   (requires `protect`)
 *
 * Lets the frontend restore a session after a page reload: it cannot read the HttpOnly cookies,
 * so it asks the server who is signed in and receives the CSRF token again.
 *
 * Responses:
 *   200 { message, data: { user, csrfToken } }   Session is valid.
 *   401                                          No valid session (from `protect`), or the CSRF
 *                                                cookie is missing or does not belong to this
 *                                                session; cookies are cleared so the user signs in again.
 *
 * Returning the CSRF token from a GET is safe: SameSite=Strict keeps the cookies off
 * cross-site requests, and CORS stops other origins from reading the response.
 */
export async function getCurrentUser(req, res, next) {
  try {
    const authConfig = req.app.locals.config;
    const csrfTokenFromCookie = readRequestCookie(req, resolveCsrfTokenCookieName(authConfig));

    if (!isCsrfTokenValid(csrfTokenFromCookie, req.authSession.csrfTokenHash)) {
      logger.warn('Session rejected', { requestId: req.id, reason: 'csrf_cookie_mismatch', userId: req.user.id });
      clearSessionCookies(res, authConfig);
      return sendError(req, res, HTTP_STATUS.UNAUTHORIZED, SESSION_MESSAGES.SESSION_INVALID);
    }

    return sendSuccess(res, HTTP_STATUS.OK, AUTH_MESSAGES.CURRENT_USER_RETRIEVED, {
      user: req.user,
      csrfToken: csrfTokenFromCookie,
    });
  } catch (error) {
    return next(error);
  }
}

/**
 * POST /api/auth/logout   (requires `protect`, including its CSRF check)
 *
 * Ends the current session on the server, not just in the browser: the token's `jti` is added
 * to the RevokedSession list, so the token is rejected even if a copy of it still exists
 * somewhere. The cookies are then cleared and the session's open sockets are disconnected.
 *
 * Responses:
 *   200 { message, data: {} }   Session revoked and cookies cleared.
 *   401 / 403                   From `protect` (no valid session / missing CSRF token).
 *   500                         Unexpected failure, via the central error handler.
 */
export async function logoutUser(req, res, next) {
  try {
    const { sessionId, expiresAtMs } = req.authSession;
    try {
      await RevokedSession.create({ sessionId, userId: req.user.id, expiresAt: new Date(expiresAtMs) });
    } catch (revocationError) {
      // Already revoked by a concurrent logout request; the outcome is the same.
      if (!isDuplicateKeyError(revocationError)) throw revocationError;
    }

    clearSessionCookies(res, req.app.locals.config);
    // Close real-time connections opened with this session; the revoked token would be
    // rejected on their next handshake anyway, but open sockets would keep receiving events.
    disconnectSessionSockets(sessionId);
    logger.info('User logged out', { requestId: req.id, userId: req.user.id });

    return sendSuccess(res, HTTP_STATUS.OK, AUTH_MESSAGES.LOGOUT_SUCCESSFUL, {});
  } catch (error) {
    return next(error);
  }
}

/**
 * POST /api/auth/password   (requires `protect`, including its CSRF check)
 *
 * Request body: { currentPassword: string, newPassword: string }
 * Responses:
 *   200 { message, data: { user, csrfToken } } + new session cookies   Password changed.
 *   400 { error: { message, requestId, details } }  New password fails the signup rules or equals the
 *                                                   current one, or the current password is wrong
 *                                                   (details field "currentPassword").
 *   401 { error }                                   No valid session.
 *
 * A wrong current password is a 400, not a 401: clients treat 401 as "session ended" and sign
 * the user out, which would be the wrong reaction to a typo.
 *
 * Security decisions:
 *   - The current password is required, so a hijacked session alone cannot lock the owner out.
 *   - passwordChangedAt is set; every session issued before it is rejected from then on
 *     (sessionAuthenticator.loadSessionUser), which signs out all other devices. Their open
 *     sockets are closed immediately.
 *   - This request's session is replaced with a fresh one issued after the change, so the person
 *     who changed the password stays signed in. The old session id is also revoked explicitly.
 */
export async function changePassword(req, res, next) {
  try {
    const changeValidation = validateChangePasswordInput(req.body);
    if (!changeValidation.isValid) {
      return sendError(
        req,
        res,
        HTTP_STATUS.BAD_REQUEST,
        VALIDATION_MESSAGES.REQUEST_VALIDATION_FAILED,
        changeValidation.validationErrors,
      );
    }
    const { currentPassword, newPassword } = changeValidation.sanitizedInput;

    const userRecord = await User.findById(req.user.id).select('+password');
    if (!userRecord) {
      return sendError(req, res, HTTP_STATUS.UNAUTHORIZED, SESSION_MESSAGES.ACCOUNT_NOT_FOUND);
    }
    if (!(await userRecord.comparePassword(currentPassword))) {
      logger.warn('Password change refused: wrong current password', { requestId: req.id, userId: req.user.id });
      return sendError(req, res, HTTP_STATUS.BAD_REQUEST, ACCOUNT_MESSAGES.CURRENT_PASSWORD_INCORRECT, [
        { field: 'currentPassword', message: ACCOUNT_MESSAGES.CURRENT_PASSWORD_INCORRECT },
      ]);
    }

    userRecord.password = newPassword;
    userRecord.passwordChangedAt = new Date();
    await userRecord.save();

    const { sessionId: previousSessionId, expiresAtMs: previousExpiresAtMs } = req.authSession;
    try {
      await RevokedSession.create({
        sessionId: previousSessionId,
        userId: req.user.id,
        expiresAt: new Date(previousExpiresAtMs),
      });
    } catch (revocationError) {
      if (!isDuplicateKeyError(revocationError)) throw revocationError;
    }
    disconnectUserSockets(req.user.id, SOCKET_ERROR_CODES.PASSWORD_CHANGED);

    // The renewed session keeps this one's "remember this device" choice.
    const csrfToken = startSession(res, req.app.locals.config, userRecord._id, {
      remember: req.authSession.remembered,
    });
    logger.info('Password changed', { requestId: req.id, userId: req.user.id });
    return sendSuccess(res, HTTP_STATUS.OK, ACCOUNT_MESSAGES.PASSWORD_CHANGED, {
      user: toPublicUserProfile(userRecord),
      csrfToken,
    });
  } catch (error) {
    return next(error);
  }
}
