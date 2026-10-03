/**
 * Authentication middleware for protected HTTP routes.
 *
 * Usage:
 *   import { protect } from '../middleware/authMiddleware.js';
 *   router.get('/conversations', protect, listConversations);
 *
 * After `protect` succeeds:
 *   req.user         public profile of the caller { id, name, email, role, createdAt, updatedAt },
 *                    read fresh from the database; never contains the password hash.
 *   req.authSession  { sessionId, csrfTokenHash, expiresAtMs } for handlers that manage the
 *                    session itself (GET /me, POST /logout).
 *
 * The session is carried by the HttpOnly `access_token` cookie (see utils/authCookies.js).
 * Authorization headers are not accepted: a single transport keeps CSRF protection simple to
 * reason about, and nothing in the system currently needs header-based tokens.
 * The checks themselves live in services/sessionAuthenticator.js, shared with the Socket.IO
 * handshake so both transports accept and reject exactly the same sessions.
 *
 * Failure responses:
 *   401  not signed in, or the session is malformed, expired, revoked, or for a deleted account.
 *        The session cookies are cleared in the same response so the browser stops sending them.
 *   403  signed in, but a state-changing request lacks a valid X-CSRF-Token header.
 *   500  database failure, via the central error handler; never reported as a session problem.
 */

import { SESSION_MESSAGES } from '../constants/messages.js';
import { HTTP_STATUS } from '../constants/httpStatus.js';
import { loadSessionUser, verifySessionToken } from '../services/sessionAuthenticator.js';
import { sendError } from '../utils/apiResponse.js';
import { clearSessionCookies, readRequestCookie, resolveAccessTokenCookieName } from '../utils/authCookies.js';
import { isCsrfTokenValid } from '../utils/authToken.js';
import { logger } from '../utils/logger.js';

/** Methods that must not change state (RFC 9110 "safe" methods); they skip the CSRF check. */
const CSRF_EXEMPT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Header the frontend uses to send the CSRF token on state-changing requests. */
export const CSRF_HEADER_NAME = 'x-csrf-token';

/** Logs a session failure, clears the cookies when they can never succeed again, and sends 401. */
function rejectSession(req, res, sessionFailure, logContext = {}) {
  if (sessionFailure.shouldClearCookies) {
    logger.warn('Session rejected', {
      requestId: req.id,
      reason: sessionFailure.failureReason,
      path: req.originalUrl,
      ...logContext,
    });
    clearSessionCookies(res, req.app.locals.config);
  }
  return sendError(req, res, HTTP_STATUS.UNAUTHORIZED, sessionFailure.clientMessage);
}

/**
 * Requires a valid session and attaches the caller to `req.user`.
 *
 * Session verification lifecycle:
 *
 *   Step 1. Read the access_token cookie.
 *
 *   Step 2. Verify the token without I/O (verifySessionToken): present, JWT-shaped, signed
 *           with HS256 by JWT_SECRET, inside its nbf/exp window, carrying sub/jti/csrf claims.
 *           Missing -> 401 NOT_AUTHENTICATED; any other failure -> 401 with its specific message
 *           and the cookies cleared. Non-token errors -> central error handler (500).
 *
 *   Step 3. Check the CSRF token (state-changing methods only).
 *           For POST, PUT, PATCH, DELETE the X-CSRF-Token header must hash to the token's
 *           `csrf` claim. A cross-site form or script cannot read that token, so it cannot pass
 *           this step even if the browser attached the cookie. Failure -> 403 CSRF_TOKEN_INVALID;
 *           the session itself is left intact. Done before any database work.
 *
 *   Step 4. Load the session's user (loadSessionUser): the session must not be revoked and the
 *           account must still exist. Failure -> 401 and cookies cleared. A database error goes
 *           to the central error handler (500).
 *
 *   Step 5. Attach `req.user` and `req.authSession`, then `next()`.
 */
export async function protect(req, res, next) {
  const authConfig = req.app.locals.config;

  // Step 1
  const accessToken = readRequestCookie(req, resolveAccessTokenCookieName(authConfig));

  // Step 2
  let tokenVerification;
  try {
    tokenVerification = verifySessionToken(accessToken, authConfig);
  } catch (unexpectedVerificationError) {
    return next(unexpectedVerificationError);
  }
  if (!tokenVerification.isValid) {
    return rejectSession(req, res, tokenVerification);
  }
  const { sessionClaims } = tokenVerification;

  // Step 3
  if (!CSRF_EXEMPT_METHODS.has(req.method) && !isCsrfTokenValid(req.get(CSRF_HEADER_NAME), sessionClaims.csrfTokenHash)) {
    logger.warn('CSRF check failed', { requestId: req.id, userId: sessionClaims.userId, path: req.originalUrl });
    return sendError(req, res, HTTP_STATUS.FORBIDDEN, SESSION_MESSAGES.CSRF_TOKEN_INVALID);
  }

  // Step 4
  let userLookup;
  try {
    userLookup = await loadSessionUser(sessionClaims);
  } catch (databaseError) {
    return next(databaseError);
  }
  if (!userLookup.isValid) {
    return rejectSession(req, res, userLookup, { userId: sessionClaims.userId });
  }

  // Step 5
  req.user = userLookup.user;
  req.authSession = {
    sessionId: sessionClaims.sessionId,
    csrfTokenHash: sessionClaims.csrfTokenHash,
    expiresAtMs: sessionClaims.expiresAtMs,
  };
  return next();
}
