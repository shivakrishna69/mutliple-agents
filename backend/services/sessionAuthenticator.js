/**
 * Session verification shared by every entry point that accepts a session: the HTTP `protect`
 * middleware and the Socket.IO handshake. Keeping one implementation guarantees that a session
 * rejected over HTTP is rejected over WebSocket for exactly the same reasons.
 *
 * Verification is split in two so callers can do cheap checks before database work:
 *
 *   verifySessionToken(accessToken)   synchronous, no I/O
 *     1. a token is present
 *     2. it has the JWT shape header.payload.signature
 *     3. signature, algorithm (HS256 only), `nbf` and `exp` verify
 *     4. the claims this backend always issues are present: `sub` (ObjectId), `jti`, `csrf`
 *
 *   loadSessionUser(sessionClaims)    two MongoDB reads, in parallel
 *     5. the session was not revoked by logout
 *     6. the account still exists; returns its public profile
 *
 * Both return either `{ isValid: true, ... }` or a failure
 * `{ isValid: false, failureReason, clientMessage, shouldClearCookies }`:
 *   failureReason       stable machine-readable code, for logs and socket error payloads
 *   clientMessage       from constants/messages.js, safe to show
 *   shouldClearCookies  true when the browser holds a cookie that can never succeed again
 * Errors that are not session problems (database down, unexpected library errors) are thrown,
 * so callers report them as server faults rather than as "please sign in again".
 */

import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import RevokedSession from '../models/RevokedSession.js';
import { SESSION_MESSAGES } from '../constants/messages.js';
import { isWellFormedCsrfHash, verifyAccessToken } from '../utils/authToken.js';
import { PUBLIC_USER_PROFILE_FIELDS, toPublicUserProfile } from '../utils/userProfile.js';

/** Three base64url segments separated by dots: header.payload.signature. */
const JWT_SHAPE_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export const SESSION_FAILURE_REASON = Object.freeze({
  NOT_AUTHENTICATED: 'not_authenticated',
  MALFORMED_TOKEN: 'malformed_token',
  TOKEN_EXPIRED: 'token_expired',
  TOKEN_NOT_YET_VALID: 'token_not_yet_valid',
  TOKEN_INVALID: 'token_invalid',
  MISSING_CLAIMS: 'missing_claims',
  SESSION_REVOKED: 'session_revoked',
  ACCOUNT_NOT_FOUND: 'account_not_found',
});

function sessionFailure(failureReason, clientMessage, shouldClearCookies) {
  return { isValid: false, failureReason, clientMessage, shouldClearCookies };
}

/**
 * Steps 1–4. Returns `{ isValid: true, sessionClaims: { userId, sessionId, csrfTokenHash, expiresAtMs } }`
 * or a failure. Throws only for errors that are not about the token itself.
 * @param {string|null|undefined} accessToken
 * @param {{ jwtSecret: string }} authConfig
 */
export function verifySessionToken(accessToken, authConfig) {
  if (!accessToken) {
    // Nothing stored in the browser, so there is nothing to clear.
    return sessionFailure(SESSION_FAILURE_REASON.NOT_AUTHENTICATED, SESSION_MESSAGES.NOT_AUTHENTICATED, false);
  }
  if (!JWT_SHAPE_PATTERN.test(accessToken)) {
    return sessionFailure(SESSION_FAILURE_REASON.MALFORMED_TOKEN, SESSION_MESSAGES.SESSION_INVALID, true);
  }

  let decodedTokenPayload;
  try {
    decodedTokenPayload = verifyAccessToken(accessToken, authConfig);
  } catch (verificationError) {
    // TokenExpiredError and NotBeforeError extend JsonWebTokenError, so they are checked first.
    if (verificationError instanceof jwt.TokenExpiredError) {
      return sessionFailure(SESSION_FAILURE_REASON.TOKEN_EXPIRED, SESSION_MESSAGES.SESSION_EXPIRED, true);
    }
    if (verificationError instanceof jwt.NotBeforeError) {
      return sessionFailure(SESSION_FAILURE_REASON.TOKEN_NOT_YET_VALID, SESSION_MESSAGES.SESSION_NOT_YET_VALID, true);
    }
    if (verificationError instanceof jwt.JsonWebTokenError) {
      return sessionFailure(SESSION_FAILURE_REASON.TOKEN_INVALID, SESSION_MESSAGES.SESSION_INVALID, true);
    }
    throw verificationError;
  }

  const { sub: userId, jti: sessionId, csrf: csrfTokenHash, exp: expiresAtSeconds } = decodedTokenPayload;
  const hasExpectedClaims =
    typeof userId === 'string' &&
    mongoose.isValidObjectId(userId) &&
    typeof sessionId === 'string' &&
    sessionId.length > 0 &&
    isWellFormedCsrfHash(csrfTokenHash) &&
    typeof expiresAtSeconds === 'number';
  if (!hasExpectedClaims) {
    return sessionFailure(SESSION_FAILURE_REASON.MISSING_CLAIMS, SESSION_MESSAGES.SESSION_INVALID, true);
  }

  return {
    isValid: true,
    sessionClaims: { userId, sessionId, csrfTokenHash, expiresAtMs: expiresAtSeconds * 1000 },
  };
}

/**
 * Steps 5–6. Returns `{ isValid: true, user }` with the public profile, or a failure.
 * Database errors are thrown.
 * @param {{ userId: string, sessionId: string }} sessionClaims
 */
export async function loadSessionUser({ userId, sessionId }) {
  const [userRecord, isSessionRevoked] = await Promise.all([
    User.findById(userId).select(PUBLIC_USER_PROFILE_FIELDS).lean(),
    RevokedSession.exists({ sessionId }),
  ]);

  if (isSessionRevoked) {
    return sessionFailure(SESSION_FAILURE_REASON.SESSION_REVOKED, SESSION_MESSAGES.SESSION_REVOKED, true);
  }
  if (!userRecord) {
    return sessionFailure(SESSION_FAILURE_REASON.ACCOUNT_NOT_FOUND, SESSION_MESSAGES.ACCOUNT_NOT_FOUND, true);
  }
  return { isValid: true, user: toPublicUserProfile(userRecord) };
}
