/**
 * RevokedSession model: sessions that ended before their JWT expired (logout).
 *
 * JWTs are stateless, so without this list a token would keep working until `exp` even after
 * the user signed out. On logout the token's `jti` is recorded here, and the auth middleware
 * rejects any token whose `jti` is listed.
 *
 * Each entry is only needed until the token would have expired anyway. The TTL index on
 * `expiresAt` makes MongoDB delete it then (its background task runs about once a minute),
 * so the collection only ever holds sessions that are both revoked and still unexpired.
 */

import mongoose from 'mongoose';

const revokedSessionSchema = new mongoose.Schema(
  {
    // The JWT `jti` claim. Unique, so revoking the same session twice is a no-op.
    sessionId: { type: String, required: true, unique: true, immutable: true },
    // Kept for audits ("which sessions did this user end?"); not used for the revocation check.
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
    // The JWT's own expiry; the entry is deleted once this time passes.
    expiresAt: { type: Date, required: true, immutable: true },
  },
  { timestamps: { createdAt: 'revokedAt', updatedAt: false } },
);

revokedSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const RevokedSession = mongoose.model('RevokedSession', revokedSessionSchema);

export default RevokedSession;
