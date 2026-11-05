/**
 * AccountToken model: the single-use links emailed to an account's owner.
 *
 *   email_verification   confirms the address a person signed up with
 *   password_reset       lets the owner of an active account choose a new password
 *
 * Only the SHA-256 hash of the link's token is stored (utils/secureTokens.js). A link is used up by
 * deleting its document in the same operation that finds it, so two clicks at once cannot both
 * succeed, and revoking an account's links is a delete. The TTL index on `expiresAt` makes MongoDB
 * remove expired links (its background task runs about once a minute); lookups also check
 * `expiresAt`, so a link never works past its expiry even before that cleanup.
 */

import mongoose from 'mongoose';

export const ACCOUNT_TOKEN_PURPOSES = Object.freeze({
  EMAIL_VERIFICATION: 'email_verification',
  PASSWORD_RESET: 'password_reset',
});

const accountTokenSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
    purpose: {
      type: String,
      enum: { values: Object.values(ACCOUNT_TOKEN_PURPOSES), message: 'Token purpose "{VALUE}" is not valid' },
      required: true,
      immutable: true,
    },
    tokenHash: { type: String, required: true, match: /^[0-9a-f]{64}$/, select: false, immutable: true },
    // Email confirmation only: the short code sent with the link, as an HMAC keyed with a server
    // secret (a database copy alone cannot be tried against the million possible codes), and how
    // many wrong codes were typed (services/accountTokens.js).
    codeHash: { type: String, default: null, match: /^[0-9a-f]{64}$/, select: false, immutable: true },
    failedCodeAttempts: { type: Number, default: 0, min: 0 },
    expiresAt: { type: Date, required: true, immutable: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

accountTokenSchema.index({ tokenHash: 1 }, { unique: true });
// Revoking an account's links.
accountTokenSchema.index({ userId: 1, purpose: 1 });
accountTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const AccountToken = mongoose.model('AccountToken', accountTokenSchema);

export default AccountToken;
