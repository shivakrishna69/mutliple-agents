/**
 * Issuing, checking, using up and revoking emailed account links (models/AccountToken.js).
 *
 * Only the newest link of an account works: issuing one revokes the account's earlier links of the
 * same purpose first, and the new link is written only after they are gone.
 */

import AccountToken from '../models/AccountToken.js';
import { createSecureToken, hashSecureToken, isWellFormedSecureToken } from '../utils/secureTokens.js';

/**
 * Revokes an account's links: of the given purposes, or all of them.
 * @param {import('mongoose').Types.ObjectId|string} userId
 * @param {string[]} [purposes]
 */
export async function revokeAccountTokens(userId, purposes = null) {
  await AccountToken.deleteMany(purposes ? { userId, purpose: { $in: purposes } } : { userId });
}

/**
 * A new link for the account, after revoking its earlier ones of this purpose.
 * @returns {Promise<{ rawToken: string, expiresAt: Date }>}  `rawToken` goes in the emailed link only
 */
export async function issueAccountToken(userId, purpose, validityMs, now = new Date()) {
  await revokeAccountTokens(userId, [purpose]);
  const { rawToken, tokenHash } = createSecureToken();
  const expiresAt = new Date(now.getTime() + validityMs);
  await AccountToken.create({ userId, purpose, tokenHash, expiresAt });
  return { rawToken, expiresAt };
}

const usableTokenFilter = (rawToken, purpose, now) => ({
  tokenHash: hashSecureToken(rawToken),
  purpose,
  expiresAt: { $gt: now },
});

/**
 * Whether a link still works, without using it up.
 * @returns {Promise<{ userId: import('mongoose').Types.ObjectId, expiresAt: Date } | null>}
 */
export async function findUsableAccountToken(rawToken, purpose, now = new Date()) {
  if (!isWellFormedSecureToken(rawToken)) return null;
  return AccountToken.findOne(usableTokenFilter(rawToken, purpose, now))
    .select('userId expiresAt')
    .lean();
}

/**
 * Uses a link up: finds and deletes it in one operation, so it works exactly once.
 * @returns {Promise<import('mongoose').Types.ObjectId | null>}  the account it belongs to, or null
 *   when the link is malformed, unknown, revoked, expired or already used
 */
export async function consumeAccountToken(rawToken, purpose, now = new Date()) {
  if (!isWellFormedSecureToken(rawToken)) return null;
  const consumed = await AccountToken.findOneAndDelete(usableTokenFilter(rawToken, purpose, now))
    .select('userId')
    .lean();
  return consumed?.userId ?? null;
}
