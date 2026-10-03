/**
 * Authentication controllers: registration, login, current session, and logout.
 *
 * Session model (see utils/authToken.js and utils/authCookies.js):
 *   - Signup and login put the session JWT and its CSRF token in HttpOnly, SameSite=Strict
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
import User, { BCRYPT_SALT_ROUNDS, ROLES } from '../models/User.js';
import RevokedSession from '../models/RevokedSession.js';
import { ACCOUNT_MESSAGES, AUTH_MESSAGES, SESSION_MESSAGES, VALIDATION_MESSAGES } from '../constants/messages.js';
import { HTTP_STATUS } from '../constants/httpStatus.js';
import { sendError, sendSuccess } from '../utils/apiResponse.js';
import { clearSessionCookies, readRequestCookie, resolveCsrfTokenCookieName, setSessionCookies } from '../utils/authCookies.js';
import { isCsrfTokenValid, issueSessionTokens } from '../utils/authToken.js';
import { toPublicUserProfile } from '../utils/userProfile.js';
import { SOCKET_ERROR_CODES, disconnectSessionSockets, disconnectUserSockets } from '../utils/socketManager.js';
import { logger } from '../utils/logger.js';
import { validateChangePasswordInput, validateLoginInput, validateRegistrationInput } from '../validators/authValidators.js';

/** MongoDB's error code for a unique-index violation. */
const DUPLICATE_KEY_ERROR_CODE = 11000;

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
 * that the response body hands to the frontend.
 */
function startSession(res, authConfig, userId) {
  const sessionTokens = issueSessionTokens(userId, authConfig);
  setSessionCookies(res, authConfig, sessionTokens);
  return sessionTokens.csrfToken;
}

/**
 * POST /api/auth/signup
 *
 * Request body: { name: string, email: string, password: string }
 * Responses:
 *   201 { message, data: { user, csrfToken } } + session cookies   Account created and signed in.
 *   400 { error: { message, requestId, details? } }  Invalid fields (including a weak password),
 *                                                     or the email is already registered.
 *   429                                               Signup rate limit reached (middleware).
 *   500                                               Unexpected failure, via the central error handler.
 *
 * Security decisions:
 *   - The role is always `customer`. Any `role` in the request body is ignored, because the
 *     validator only passes through name, email, and password; otherwise anyone could sign
 *     themselves up as an admin.
 *   - Password strength (length, upper, lower, digit, special) is enforced by the validator,
 *     independently of what the frontend checked.
 *   - The password is hashed by the User model's pre-save hook (bcrypt, BCRYPT_SALT_ROUNDS),
 *     the single place hashing happens. Hashing here as well would store a hash of a hash.
 */
export async function registerUser(req, res, next) {
  try {
    const registrationValidation = validateRegistrationInput(req.body);
    if (!registrationValidation.isValid) {
      return sendError(
        req,
        res,
        HTTP_STATUS.BAD_REQUEST,
        VALIDATION_MESSAGES.REQUEST_VALIDATION_FAILED,
        registrationValidation.validationErrors,
      );
    }

    const { name, email, password } = registrationValidation.sanitizedInput;

    // Fast path for the common duplicate case. It is not sufficient on its own: two concurrent
    // signups with the same email can both pass this check, so the unique index on `email`
    // is the real guarantee and its error is handled in the catch block below.
    const existingAccount = await User.exists({ email });
    if (existingAccount) {
      return sendError(req, res, HTTP_STATUS.BAD_REQUEST, AUTH_MESSAGES.EMAIL_ALREADY_REGISTERED);
    }

    // Every self-registered account is a customer, except the deployment's configured first admin
    // (BOOTSTRAP_ADMIN_EMAIL), so a fresh deployment can be administered without database access.
    const bootstrapAdminEmail = req.app.locals.config.bootstrapAdminEmail;
    const assignedRole = bootstrapAdminEmail && email === bootstrapAdminEmail ? ROLES.ADMIN : ROLES.CUSTOMER;
    const newUserRecord = new User({ name, email, password, role: assignedRole });
    await newUserRecord.save();

    const csrfToken = startSession(res, req.app.locals.config, newUserRecord._id);

    logger.info('User registered', { requestId: req.id, userId: newUserRecord._id.toString() });

    return sendSuccess(res, HTTP_STATUS.CREATED, AUTH_MESSAGES.REGISTRATION_SUCCESSFUL, {
      user: toPublicUserProfile(newUserRecord),
      csrfToken,
    });
  } catch (error) {
    // The concurrent-signup race described above: the unique index rejected the second insert.
    if (error?.code === DUPLICATE_KEY_ERROR_CODE && error?.keyPattern?.email) {
      return sendError(req, res, HTTP_STATUS.BAD_REQUEST, AUTH_MESSAGES.EMAIL_ALREADY_REGISTERED);
    }
    return next(error);
  }
}

/**
 * POST /api/auth/login
 *
 * Request body: { email: string, password: string }
 * Responses:
 *   200 { message, data: { user, csrfToken } } + session cookies   Credentials are correct.
 *   400 { error: { message, requestId, details } }  Email or password missing or not a string.
 *   401 { error: { message, requestId } }         Unknown email or wrong password (same message for both).
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

    const { email, password } = loginValidation.sanitizedInput;

    const userRecord = await User.findOne({ email }).select('+password');

    if (!userRecord) {
      // Spend the same bcrypt work as a real comparison before answering; the result is discarded.
      await bcrypt.compare(password, TIMING_EQUALIZATION_HASH);
      logger.warn('Login failed', { requestId: req.id, reason: 'unknown_email' });
      return sendError(req, res, HTTP_STATUS.UNAUTHORIZED, AUTH_MESSAGES.INVALID_CREDENTIALS);
    }

    const isPasswordValid = await userRecord.comparePassword(password);
    if (!isPasswordValid) {
      logger.warn('Login failed', { requestId: req.id, reason: 'wrong_password', userId: userRecord._id.toString() });
      return sendError(req, res, HTTP_STATUS.UNAUTHORIZED, AUTH_MESSAGES.INVALID_CREDENTIALS);
    }

    const csrfToken = startSession(res, req.app.locals.config, userRecord._id);

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
      if (revocationError?.code !== DUPLICATE_KEY_ERROR_CODE) throw revocationError;
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
      return sendError(req, res, HTTP_STATUS.BAD_REQUEST, VALIDATION_MESSAGES.REQUEST_VALIDATION_FAILED, changeValidation.validationErrors);
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
      await RevokedSession.create({ sessionId: previousSessionId, userId: req.user.id, expiresAt: new Date(previousExpiresAtMs) });
    } catch (revocationError) {
      if (revocationError?.code !== DUPLICATE_KEY_ERROR_CODE) throw revocationError;
    }
    disconnectUserSockets(req.user.id, SOCKET_ERROR_CODES.PASSWORD_CHANGED);

    const csrfToken = startSession(res, req.app.locals.config, userRecord._id);
    logger.info('Password changed', { requestId: req.id, userId: req.user.id });
    return sendSuccess(res, HTTP_STATUS.OK, ACCOUNT_MESSAGES.PASSWORD_CHANGED, { user: toPublicUserProfile(userRecord), csrfToken });
  } catch (error) {
    return next(error);
  }
}
