/**
 * Issuing, checking, using up and revoking emailed account links (models/AccountToken.js).
 *
 * Only the newest link of an account works: issuing one revokes the account's earlier links of the
 * same purpose first, and the new link is written only after they are gone.
 *
 * A link can also carry a short numeric code (email confirmation: the person may type the code
 * instead of opening the link). The code is stored as an HMAC keyed with a server secret
 * (configureAccountCodeKey, from JWT_SECRET at startup) and bound to the account, so a stolen
 * database alone cannot be searched for codes. Each wrong code is counted on the link; reaching the
 * limit deletes it, link included.
 */

import { createHash, createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import AccountToken from '../models/AccountToken.js';
import { createSecureToken, hashSecureToken, isWellFormedSecureToken } from '../utils/secureTokens.js';

let accountCodeKey = null;

/** Called once at startup with a server secret; codes cannot be issued or checked before. */
export function configureAccountCodeKey(serverSecret) {
  accountCodeKey = createHash('sha256').update(`account-codes:${serverSecret}`, 'utf8').digest();
}

function hashAccountCode(userId, code) {
  if (!accountCodeKey) throw new Error('configureAccountCodeKey must run before account codes are used');
  return createHmac('sha256', accountCodeKey).update(`${userId}:${code}`, 'utf8').digest('hex');
}

/** What checking a typed code found. */
export const ACCOUNT_CODE_OUTCOMES = Object.freeze({ USED: 'used', WRONG: 'wrong', NONE: 'none' });

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
 * @param {{ codeDigits?: number }} [options]  with codeDigits, the link also gets a numeric code
 * @returns {Promise<{ rawToken: string, code: string|null, expiresAt: Date }>}  `rawToken` and
 *   `code` go in the email only
 */
export async function issueAccountToken(userId, purpose, validityMs, now = new Date(), { codeDigits = 0 } = {}) {
  await revokeAccountTokens(userId, [purpose]);
  const { rawToken, tokenHash } = createSecureToken();
  const code = codeDigits > 0 ? String(randomInt(0, 10 ** codeDigits)).padStart(codeDigits, '0') : null;
  const expiresAt = new Date(now.getTime() + validityMs);
  await AccountToken.create({
    userId,
    purpose,
    tokenHash,
    codeHash: code === null ? null : hashAccountCode(userId, code),
    expiresAt,
  });
  return { rawToken, code, expiresAt };
}

/**
 * Checks a typed code against the account's current link of this purpose. A right code uses the
 * link up (it works once); a wrong one is counted, and the wrong code that reaches `maxAttempts`
 * deletes the link.
 * @returns {Promise<'used'|'wrong'|'none'>}  ACCOUNT_CODE_OUTCOMES; 'none' when the account has no
 *   usable link with a code
 */
export async function consumeAccountCode(userId, purpose, code, maxAttempts, now = new Date()) {
  const token = await AccountToken.findOne({ userId, purpose, expiresAt: { $gt: now }, codeHash: { $ne: null } })
    .select('+codeHash failedCodeAttempts')
    .lean();
  if (!token) return ACCOUNT_CODE_OUTCOMES.NONE;

  const expected = Buffer.from(token.codeHash, 'hex');
  const presented = Buffer.from(hashAccountCode(userId, code), 'hex');
  if (timingSafeEqual(expected, presented)) {
    const used = await AccountToken.findOneAndDelete({ _id: token._id }).select('_id').lean();
    return used ? ACCOUNT_CODE_OUTCOMES.USED : ACCOUNT_CODE_OUTCOMES.NONE;
  }

  // Counted atomically, so tries made at the same moment cannot exceed the limit together.
  const counted = await AccountToken.findOneAndUpdate(
    { _id: token._id, failedCodeAttempts: { $lt: maxAttempts } },
    { $inc: { failedCodeAttempts: 1 } },
    { new: true },
  )
    .select('failedCodeAttempts')
    .lean();
  if (!counted || counted.failedCodeAttempts >= maxAttempts) await AccountToken.deleteOne({ _id: token._id });
  return ACCOUNT_CODE_OUTCOMES.WRONG;
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
