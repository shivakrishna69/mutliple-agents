/**
 * DocumentVault model: metadata for one sensitive employee document whose bytes live in S3.
 * MongoDB holds who the document belongs to, who may read it, and where it is stored; S3 holds the
 * encrypted file. Nothing here is ever sent to a browser except through the controller's
 * explicit summary (controllers/vaultController.js toDocumentSummary).
 *
 * Relationship vectors
 * --------------------
 *   DocumentVault.employeeId        ──► EmployeeProfile._id  (many-to-one, required, immutable)
 *       The employee the document is about. The owner always has read access, independent of
 *       `accessibleRoles`: ownership is resolved as EmployeeProfile.userId === the session's user id
 *       (never by comparing employeeId with a User id; they are different collections).
 *   DocumentVault.uploadedByUserId  ──► User._id             (who uploaded it; audit, immutable)
 *   DocumentVault.verifiedByUserId  ──► User._id             (who verified it; null until verified)
 *
 * Access model
 * ------------
 *   Read:    the owner, or a user whose role is listed in `accessibleRoles`.
 *   Grantable roles are limited to VAULT_GRANTABLE_ROLES (admin, hr). Support agents and customers
 *   can never be granted access to another person's documents, whatever a client sends.
 *   Verify:  a user whose role is in `accessibleRoles`, who is not the owner (no self-verification).
 *
 * Storage fields (never leave the server)
 * ---------------------------------------
 *   s3KeyPath     vault/employees/{employeeId}/{documentType}/{uploadEpochMs}_{uuid}.{pdf|jpg|png}
 *                 The object name is random, not the uploaded file name, so the key (which is
 *                 part of every pre-signed URL) reveals nothing about the file's content. The
 *                 user's file name is kept in `originalFileName` and applied only as the download
 *                 file name. `select: false`, unique, immutable.
 *   encryptionIv  Initialisation vector for application-layer encryption, as 24 hex characters
 *                 (a 96-bit AES-GCM IV). The upload pipeline in this codebase encrypts at rest with
 *                 S3 server-side encryption (`serverSideEncryption`) instead, because downloads are
 *                 served by pre-signed URLs straight from S3 to the browser, and a browser cannot
 *                 decrypt an application-layer ciphertext without being given the key. The field is
 *                 therefore null for every document this pipeline writes; it is validated so any
 *                 future pipeline that encrypts in the application stores a well-formed IV.
 *                 `select: false`.
 *   serverSideEncryption  The S3 encryption applied at upload: 'aws:kms' or 'AES256'.
 *
 * Integrity
 * ---------
 *   `sha256Checksum` is computed by the backend from the received bytes and sent to S3 as the
 *   object's SHA-256 checksum, so S3 rejects the upload if a single byte changed in transit.
 *
 * Write rules
 * -----------
 *   Identity and storage fields are immutable. Verification goes through `markVerified()` + save(),
 *   with optimistic concurrency so two verifiers racing cannot both succeed. Query-style updates
 *   that touch the guarded fields are rejected.
 */

import mongoose from 'mongoose';
import { VAULT_FIELD_LIMITS } from '../constants/validation.js';
import EmployeeProfile from './EmployeeProfile.js';
import { ROLES } from './User.js';
import { QUERY_UPDATE_OPERATIONS, assertReferenceExists, createGuardedFieldUpdateBlocker } from './hierarchyIntegrity.js';

const { ObjectId } = mongoose.Schema.Types;

/** Allowed values for `documentType`. */
export const VAULT_DOCUMENT_TYPES = Object.freeze({
  OFFER_LETTER: 'Offer_Letter',
  APPRAISAL_DOC: 'Appraisal_Doc',
  GOV_ID: 'Gov_ID',
});

/** Allowed values for `status`. */
export const VAULT_DOCUMENT_STATUSES = Object.freeze({
  PENDING_VERIFICATION: 'Pending_Verification',
  VERIFIED: 'Verified',
});

/** Roles that may appear in `accessibleRoles`. */
export const VAULT_GRANTABLE_ROLES = Object.freeze([ROLES.ADMIN, ROLES.HR]);

/** File types the vault stores, keyed by MIME type, with the extension used in the object key. */
export const VAULT_FILE_TYPES = Object.freeze({
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
});

/** S3 server-side encryption modes the vault accepts. */
export const VAULT_SERVER_SIDE_ENCRYPTION = Object.freeze({ KMS: 'aws:kms', AES256: 'AES256' });

/**
 * vault/employees/<24-hex employeeId>/<documentType>/<13-digit epoch ms>_<uuid v4>.<pdf|jpg|png>
 * Anchored and fully specified, so a key can never contain "..", "/" injection, or a user file name.
 */
const S3_KEY_PATH_PATTERN = new RegExp(
  `^vault/employees/[0-9a-f]{24}/(?:${Object.values(VAULT_DOCUMENT_TYPES).join('|')})/\\d{13}_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.(?:pdf|jpg|png)$`,
);
const AES_GCM_IV_HEX_PATTERN = /^[0-9a-f]{24}$/;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

/** Builds the object key for a new upload. Exported so the controller and the model share one format. */
export function buildVaultObjectKey({ employeeId, documentType, uploadedAtMs, objectUuid, extension }) {
  return `vault/employees/${employeeId}/${documentType}/${uploadedAtMs}_${objectUuid}.${extension}`;
}

const documentVaultSchema = new mongoose.Schema(
  {
    // ──► EmployeeProfile._id
    employeeId: {
      type: ObjectId,
      ref: 'EmployeeProfile',
      required: [true, 'employeeId is required'],
      immutable: true,
    },
    documentType: {
      type: String,
      enum: { values: Object.values(VAULT_DOCUMENT_TYPES), message: 'Document type "{VALUE}" is not valid' },
      required: [true, 'Document type is required'],
      immutable: true,
    },
    // Display / download name supplied by the uploader, already sanitised by the controller.
    originalFileName: {
      type: String,
      required: true,
      trim: true,
      minlength: 1,
      maxlength: VAULT_FIELD_LIMITS.ORIGINAL_FILE_NAME_MAX_LENGTH,
      immutable: true,
    },
    // Detected from the file's leading bytes, never taken from the client's Content-Type.
    contentType: {
      type: String,
      enum: { values: Object.keys(VAULT_FILE_TYPES), message: 'Content type "{VALUE}" is not allowed' },
      required: true,
      immutable: true,
    },
    sizeBytes: {
      type: Number,
      required: true,
      min: 1,
      max: VAULT_FIELD_LIMITS.MAX_FILE_BYTES,
      immutable: true,
    },
    sha256Checksum: {
      type: String,
      required: true,
      match: [SHA256_HEX_PATTERN, 'sha256Checksum must be 64 lowercase hex characters'],
      immutable: true,
    },
    encryptionIv: {
      type: String,
      default: null,
      select: false,
      immutable: true,
      validate: {
        validator: (initializationVector) => initializationVector === null || AES_GCM_IV_HEX_PATTERN.test(initializationVector),
        message: 'encryptionIv must be 24 lowercase hex characters (96-bit AES-GCM IV)',
      },
    },
    s3KeyPath: {
      type: String,
      required: [true, 's3KeyPath is required'],
      unique: true,
      select: false,
      immutable: true,
      match: [S3_KEY_PATH_PATTERN, 's3KeyPath does not match the vault key format'],
    },
    serverSideEncryption: {
      type: String,
      enum: { values: Object.values(VAULT_SERVER_SIDE_ENCRYPTION), message: 'Server-side encryption "{VALUE}" is not supported' },
      required: true,
      immutable: true,
    },
    status: {
      type: String,
      enum: { values: Object.values(VAULT_DOCUMENT_STATUSES), message: 'Status "{VALUE}" is not valid' },
      default: VAULT_DOCUMENT_STATUSES.PENDING_VERIFICATION,
      required: true,
    },
    accessibleRoles: {
      type: [{ type: String, enum: { values: VAULT_GRANTABLE_ROLES, message: 'Role "{VALUE}" cannot be granted vault access' } }],
      validate: [
        { validator: (roleList) => Array.isArray(roleList) && roleList.length > 0, message: 'accessibleRoles must list at least one role' },
        { validator: (roleList) => new Set(roleList).size === roleList.length, message: 'accessibleRoles must not repeat a role' },
      ],
    },
    // ──► User._id
    uploadedByUserId: {
      type: ObjectId,
      ref: 'User',
      required: true,
      immutable: true,
    },
    // ──► User._id; set together with verifiedAt by markVerified().
    verifiedByUserId: {
      type: ObjectId,
      ref: 'User',
      default: null,
    },
    verifiedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
    // Concurrent saves of the same document fail with a VersionError instead of overwriting.
    optimisticConcurrency: true,
    toJSON: {
      transform(doc, ret) {
        delete ret.s3KeyPath;
        delete ret.encryptionIv;
        delete ret.__v;
        return ret;
      },
    },
  },
);

// ---------------------------------------------------------------------------
// Indexes
// ---------------------------------------------------------------------------

// `unique: true` on s3KeyPath guarantees one metadata record per stored object.

// An employee's documents, optionally by type, newest first (listing and "latest Gov_ID").
documentVaultSchema.index({ employeeId: 1, documentType: 1, createdAt: -1 });

// HR verification queue: pending documents, oldest first.
documentVaultSchema.index({ status: 1, createdAt: 1 });

// ---------------------------------------------------------------------------
// Consistency and references
// ---------------------------------------------------------------------------

documentVaultSchema.pre('validate', async function enforceVaultConsistency() {
  const isVerified = this.status === VAULT_DOCUMENT_STATUSES.VERIFIED;
  const hasVerificationRecord = Boolean(this.verifiedByUserId && this.verifiedAt);
  if (isVerified !== hasVerificationRecord) {
    this.invalidate('status', 'A verified document must record who verified it and when, and only a verified document may');
  }
  if (this.isNew) {
    await assertReferenceExists({ model: EmployeeProfile, referencedId: this.employeeId, entityLabel: 'Employee' });
  }
});

/** Marks the document verified by `verifierUserId`. Does not save; the caller saves. */
documentVaultSchema.methods.markVerified = function markVerified(verifierUserId) {
  this.status = VAULT_DOCUMENT_STATUSES.VERIFIED;
  this.verifiedByUserId = verifierUserId;
  this.verifiedAt = new Date();
  return this;
};

documentVaultSchema.pre(
  QUERY_UPDATE_OPERATIONS,
  createGuardedFieldUpdateBlocker('DocumentVault', ['employeeId', 's3KeyPath', 'encryptionIv', 'status', 'verifiedByUserId', 'verifiedAt']),
);

const DocumentVault = mongoose.model('DocumentVault', documentVaultSchema);

export default DocumentVault;
