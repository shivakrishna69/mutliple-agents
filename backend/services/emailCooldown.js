/**
 * The least time between two account emails of one kind to one address (models/EmailCooldown.js).
 *
 * Claimed for every request that could send such an email, whether or not the address has an
 * account and whether or not an email is then sent, so the answer (go ahead, or wait N seconds) is
 * the same for every address.
 *
 * Atomic without a transaction: the update matches only a key whose wait is over; when the key
 * exists and is still waiting, the upsert collides with the unique index instead, and the caller
 * is told how long is left.
 */

import { createHash } from 'node:crypto';
import EmailCooldown from '../models/EmailCooldown.js';
import { isDuplicateKeyError } from '../utils/mongoErrors.js';

/** Separate waits per kind of email: asking for a reset does not hold back a confirmation link. */
export const EMAIL_COOLDOWN_CHANNELS = Object.freeze({
  EMAIL_VERIFICATION: 'email_verification',
  PASSWORD_RESET: 'password_reset',
});

const cooldownKey = (channel, normalizedEmail) =>
  createHash('sha256').update(`${channel}:${normalizedEmail}`, 'utf8').digest('hex');

/**
 * @param {string} channel  EMAIL_COOLDOWN_CHANNELS
 * @param {string} normalizedEmail  lowercased and trimmed
 * @param {number} cooldownMs
 * @returns {Promise<{ allowed: true } | { allowed: false, retryAfterSeconds: number }>}
 */
export async function claimEmailCooldown(channel, normalizedEmail, cooldownMs, now = new Date()) {
  const key = cooldownKey(channel, normalizedEmail);
  try {
    await EmailCooldown.updateOne(
      { key, availableAt: { $lte: now } },
      { $set: { availableAt: new Date(now.getTime() + cooldownMs) } },
      { upsert: true },
    );
    return { allowed: true };
  } catch (claimError) {
    if (!isDuplicateKeyError(claimError)) throw claimError;
  }
  const waiting = await EmailCooldown.findOne({ key }).select('availableAt').lean();
  // Gone between the two calls: its wait just ended, so the next attempt succeeds.
  const remainingMs = waiting ? waiting.availableAt.getTime() - now.getTime() : 0;
  return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(remainingMs / 1000)) };
}
