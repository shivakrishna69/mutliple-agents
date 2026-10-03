/**
 * EmployeeInvitation: HR invites a person by email; the person opens the emailed link, chooses a
 * password, and their User account and EmployeeProfile are created together
 * (services/invitationService.js).
 *
 * Token handling
 *   The link carries a random 32-byte token. Only its SHA-256 hash is stored (`tokenHash`), so a
 *   database leak cannot be turned into working invite links. Resending replaces the hash, which
 *   makes every earlier link for this invitation stop working.
 *
 * Lifecycle (`status`)
 *   pending    sent, waiting for the person; valid until `expiresAt`
 *   accepting  transient: claimed by an accept request that is creating the account (stops two
 *              tabs from accepting the same link at once); reverted to pending if creation fails
 *   accepted   account created (`acceptedUserId`, `acceptedAt`)
 *   revoked    cancelled by HR (`revokedAt`, `revokedByUserId`)
 *   An expired invitation keeps status "pending"; expiry is decided from `expiresAt` at read time,
 *   so nothing has to run on a schedule.
 *
 * One open invitation per email: a partial unique index over pending/accepting invitations.
 * `profileDraft` is what the EmployeeProfile will be created with; it is re-validated on accept,
 * because a department or manager can change in the days between invite and acceptance.
 */

import mongoose from 'mongoose';
import { ROLES } from './User.js';
import { EMPLOYMENT_STATUSES, WORK_LOCATION_TYPES } from './EmployeeProfile.js';

const { ObjectId } = mongoose.Schema.Types;

export const INVITATION_STATUSES = Object.freeze({
  PENDING: 'pending',
  ACCEPTING: 'accepting',
  ACCEPTED: 'accepted',
  REVOKED: 'revoked',
});

/** Roles an invitation can grant. Admins are never created by invitation (promote in Users & roles). */
export const INVITABLE_ROLES = Object.freeze([ROLES.CUSTOMER, ROLES.AGENT, ROLES.HR]);

export const INVITATION_LIMITS = Object.freeze({
  VALIDITY_DAYS: 7,
  TOKEN_BYTES: 32,
  NAME_MIN_LENGTH: 2,
  NAME_MAX_LENGTH: 100,
  DESIGNATION_MAX_LENGTH: 100,
  LIST_LIMIT: 200,
});

const invitationSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true, maxlength: 254 },
    name: { type: String, required: true, trim: true, minlength: INVITATION_LIMITS.NAME_MIN_LENGTH, maxlength: INVITATION_LIMITS.NAME_MAX_LENGTH },
    role: { type: String, enum: INVITABLE_ROLES, required: true },
    profileDraft: {
      designation: { type: String, required: true, trim: true, maxlength: INVITATION_LIMITS.DESIGNATION_MAX_LENGTH },
      departmentId: { type: ObjectId, ref: 'Department', required: true },
      reportingManagerId: { type: ObjectId, ref: 'EmployeeProfile', default: null },
      workLocationType: { type: String, enum: Object.values(WORK_LOCATION_TYPES), required: true },
      dateOfJoining: { type: Date, required: true },
      employmentStatus: { type: String, enum: Object.values(EMPLOYMENT_STATUSES), required: true },
    },
    tokenHash: { type: String, required: true, match: /^[0-9a-f]{64}$/, select: false },
    expiresAt: { type: Date, required: true },
    status: { type: String, enum: Object.values(INVITATION_STATUSES), default: INVITATION_STATUSES.PENDING, required: true },
    invitedByUserId: { type: ObjectId, ref: 'User', required: true },
    sendCount: { type: Number, default: 1, min: 1 },
    lastSentAt: { type: Date, required: true },
    lastDelivery: {
      // "sent" (accepted by the mail server), "not_configured" (no SMTP; link shown to HR), "failed".
      outcome: { type: String, enum: ['sent', 'not_configured', 'failed'], required: true },
      at: { type: Date, required: true },
    },
    acceptedUserId: { type: ObjectId, ref: 'User', default: null },
    acceptedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
    revokedByUserId: { type: ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, optimisticConcurrency: true },
);

invitationSchema.index({ tokenHash: 1 }, { unique: true });
invitationSchema.index(
  { email: 1 },
  { unique: true, partialFilterExpression: { status: { $in: [INVITATION_STATUSES.PENDING, INVITATION_STATUSES.ACCEPTING] } }, name: 'one_open_invitation_per_email' },
);
invitationSchema.index({ status: 1, createdAt: -1 });

/** True when a pending invitation's link can still be used. */
invitationSchema.methods.isUsable = function isUsable(now = new Date()) {
  return this.status === INVITATION_STATUSES.PENDING && this.expiresAt > now;
};

const EmployeeInvitation = mongoose.model('EmployeeInvitation', invitationSchema);
export default EmployeeInvitation;
