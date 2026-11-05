/**
 * EmailCooldown model: when the next account email (confirmation or password reset) may be sent to
 * an address (services/emailCooldown.js).
 *
 * The key is a SHA-256 hash of the channel and the normalised address, never the address itself,
 * and a key exists whether or not the address has an account: the cooldown then answers the same
 * for every address and reveals nothing. Stored in MongoDB rather than in memory, so it holds across
 * restarts and on every server instance. The TTL index removes a key once its wait is over.
 */

import mongoose from 'mongoose';

const emailCooldownSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, match: /^[0-9a-f]{64}$/, immutable: true },
    availableAt: { type: Date, required: true },
  },
  { timestamps: false },
);

emailCooldownSchema.index({ key: 1 }, { unique: true });
emailCooldownSchema.index({ availableAt: 1 }, { expireAfterSeconds: 0 });

const EmailCooldown = mongoose.model('EmailCooldown', emailCooldownSchema);

export default EmailCooldown;
