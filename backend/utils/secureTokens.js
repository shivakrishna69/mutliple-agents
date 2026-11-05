/**
 * Single-use secrets sent inside links (invitations, email verification, password reset).
 *
 *   - The raw token is 32 random bytes, base64url-encoded (43 characters), so it fits in a URL path
 *     and cannot be guessed.
 *   - Only its SHA-256 hash is stored. Someone who reads the database cannot use a stored value as a
 *     link, and a lookup by hash needs no constant-time comparison (the hash is the index key).
 *   - A malformed value is refused before any database lookup.
 */

import { createHash, randomBytes } from 'node:crypto';

export const SECURE_TOKEN_BYTES = 32;

// base64url of 32 bytes without padding: 43 characters from A-Z a-z 0-9 - _.
const SECURE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** The stored form of a raw token. */
export function hashSecureToken(rawToken) {
  return createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

/** A new token: `rawToken` goes in the link, `tokenHash` in the database. */
export function createSecureToken() {
  const rawToken = randomBytes(SECURE_TOKEN_BYTES).toString('base64url');
  return { rawToken, tokenHash: hashSecureToken(rawToken) };
}

/** True when the value has the shape of a token this module creates. */
export function isWellFormedSecureToken(rawToken) {
  return typeof rawToken === 'string' && SECURE_TOKEN_PATTERN.test(rawToken);
}
