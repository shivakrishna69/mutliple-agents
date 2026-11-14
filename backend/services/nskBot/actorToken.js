/**
 * The NSK actor token: who a turn's tool calls act for. The backend issues one per turn, for the
 * signed-in person and their session, and sends it to the ai-service with the turn; every tool call
 * the ai-service makes back (/api/internal/nsk/tools/:tool) carries it. The ai-service never names a
 * person itself, so a confused or manipulated model cannot read for someone else, and a token is
 * useless once the turn is over.
 *
 *   form     "v1.<payload>.<signature>", both base64url; payload JSON { u: userId, s: sessionId,
 *            exp: epoch seconds }; signature HMAC-SHA256 over "v1.<payload>" with config.nskActorTokenKey
 *            (derived from JWT_SECRET for this purpose only, config/environment.js)
 *   lifetime NSK_BOT_SETTINGS.ACTOR_TOKEN_TTL_SECONDS, the length of a turn
 *
 * The token carries no role: what the person may do is read from the database on every tool call,
 * so a role changed mid-turn applies at once.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

const VERSION = 'v1';
const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/;
const TOKEN_PATTERN = /^v1\.[A-Za-z0-9_-]{1,512}\.[A-Za-z0-9_-]{43}$/;

const sign = (key, signedPart) => createHmac('sha256', key).update(signedPart, 'utf8').digest('base64url');

/**
 * @param {{ key: Buffer, userId: string, sessionId: string, ttlSeconds: number, now?: Date }} input
 * @returns {string}
 */
export function issueActorToken({ key, userId, sessionId, ttlSeconds, now = new Date() }) {
  const payload = Buffer.from(
    JSON.stringify({ u: String(userId), s: String(sessionId), exp: Math.floor(now.getTime() / 1000) + ttlSeconds }),
    'utf8',
  ).toString('base64url');
  const signedPart = `${VERSION}.${payload}`;
  return `${signedPart}.${sign(key, signedPart)}`;
}

/**
 * @param {{ key: Buffer, token: unknown, now?: Date }} input
 * @returns {{ userId: string, sessionId: string }|null}  null for anything malformed, forged or expired
 */
export function verifyActorToken({ key, token, now = new Date() }) {
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return null;
  const lastDot = token.lastIndexOf('.');
  const signedPart = token.slice(0, lastDot);
  const given = Buffer.from(token.slice(lastDot + 1), 'base64url');
  const expected = Buffer.from(sign(key, signedPart), 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(signedPart.slice(VERSION.length + 1), 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const isValid =
    payload !== null &&
    typeof payload === 'object' &&
    OBJECT_ID_PATTERN.test(payload.u) &&
    OBJECT_ID_PATTERN.test(payload.s) &&
    Number.isInteger(payload.exp) &&
    payload.exp > Math.floor(now.getTime() / 1000);
  return isValid ? { userId: payload.u, sessionId: payload.s } : null;
}
