/**
 * Issuing and verifying session tokens (JWTs) and their paired CSRF tokens.
 *
 * Token format:
 *   - Algorithm: HS256 (HMAC-SHA256 with JWT_SECRET), pinned on both sign and verify so an
 *     attacker cannot present a token with a different algorithm (for example "none").
 *   - Claims:
 *       sub  the user's MongoDB _id (standard "subject" claim)
 *       jti  a random UUID identifying this session, used to revoke it on logout
 *       csrf SHA-256 hex digest of this session's CSRF token (see below)
 *       iat / exp  issued-at and expiry, from JWT_EXPIRES_IN
 *   - Role and email are not embedded: the auth middleware reloads the user on every request,
 *     so a role change or account deletion takes effect immediately.
 *
 * CSRF binding:
 *   The JWT travels in an HttpOnly cookie that browsers attach automatically, so a request
 *   forged by another site would carry it too. To prove a request came from our own frontend,
 *   every state-changing request must also send the CSRF token in the X-CSRF-Token header.
 *   A forging site cannot read that token, and the token only works with the JWT it was issued
 *   with, because the JWT carries its hash and the JWT is signed. Only the hash is embedded,
 *   so decoding the JWT does not reveal the token.
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import jwt from 'jsonwebtoken';

export const ACCESS_TOKEN_ALGORITHM = 'HS256';

/** 32 random bytes = 256 bits of entropy, encoded as 43 base64url characters. */
const CSRF_TOKEN_BYTES = 32;

/** Shape of a SHA-256 hex digest; claims that do not match are rejected before comparing. */
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;

/** SHA-256 hex digest of a CSRF token, the form stored in the JWT `csrf` claim. */
export function hashCsrfToken(csrfToken) {
  return createHash('sha256').update(csrfToken, 'utf8').digest('hex');
}

/**
 * Creates a new session for a user: a signed JWT and its paired CSRF token.
 * @param {import('mongoose').Types.ObjectId|string} userId
 * @param {{ jwtSecret: string, jwtExpiresIn: string }} authConfig  From `req.app.locals.config`.
 * @returns {{ accessToken: string, csrfToken: string, sessionId: string, expiresAtMs: number }}
 */
export function issueSessionTokens(userId, authConfig) {
  const csrfToken = randomBytes(CSRF_TOKEN_BYTES).toString('base64url');
  const sessionId = randomUUID();

  const accessToken = jwt.sign({ csrf: hashCsrfToken(csrfToken) }, authConfig.jwtSecret, {
    algorithm: ACCESS_TOKEN_ALGORITHM,
    subject: String(userId),
    jwtid: sessionId,
    expiresIn: authConfig.jwtExpiresIn,
  });

  // Read `exp` back from the signed token so the cookie lifetime matches it exactly,
  // whatever format JWT_EXPIRES_IN uses ("15m", "1d", a number of seconds).
  const { exp: expiresAtSeconds } = jwt.decode(accessToken);
  return { accessToken, csrfToken, sessionId, expiresAtMs: expiresAtSeconds * 1000 };
}

/**
 * Verifies a token's signature, algorithm, and time claims and returns its payload.
 * Throws jsonwebtoken's `TokenExpiredError`, `NotBeforeError`, or `JsonWebTokenError`
 * on failure; the caller maps each to a response.
 * @param {string} accessToken
 * @param {{ jwtSecret: string }} authConfig
 * @returns {import('jsonwebtoken').JwtPayload}
 */
export function verifyAccessToken(accessToken, authConfig) {
  return jwt.verify(accessToken, authConfig.jwtSecret, {
    algorithms: [ACCESS_TOKEN_ALGORITHM],
  });
}

/** True when `csrfTokenHash` has the shape of a hash produced by `hashCsrfToken`. */
export function isWellFormedCsrfHash(csrfTokenHash) {
  return typeof csrfTokenHash === 'string' && SHA256_HEX_PATTERN.test(csrfTokenHash);
}

/**
 * Checks a CSRF token presented by the client against the hash stored in the session JWT.
 * The comparison is constant-time, so response timing reveals nothing about how many
 * characters matched.
 * @param {unknown} presentedCsrfToken  Value from the X-CSRF-Token header or the CSRF cookie.
 * @param {string} expectedCsrfTokenHash  The JWT's `csrf` claim.
 */
export function isCsrfTokenValid(presentedCsrfToken, expectedCsrfTokenHash) {
  if (typeof presentedCsrfToken !== 'string' || presentedCsrfToken.length === 0) return false;
  if (!isWellFormedCsrfHash(expectedCsrfTokenHash)) return false;
  const presentedHashBuffer = Buffer.from(hashCsrfToken(presentedCsrfToken), 'hex');
  const expectedHashBuffer = Buffer.from(expectedCsrfTokenHash, 'hex');
  return timingSafeEqual(presentedHashBuffer, expectedHashBuffer);
}
