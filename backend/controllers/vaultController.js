/**
 * Employee document vault endpoints (routes/vaultRoutes.js, mounted at /api/vault).
 *
 *   POST  /documents                          upload one document (multipart: file, employeeId, documentType[, accessibleRoles])
 *   GET   /employees/:employeeId/documents    list the documents of one employee the caller may read
 *   GET   /download/:documentId               issue a 60-second pre-signed download URL
 *   PATCH /documents/:documentId/verify       mark a document verified
 *
 * Every route runs after `protect`, so the session cookie (and, for POST/PATCH, the CSRF token) is
 * verified and `req.user` comes from the database before any handler here runs; a missing or
 * invalid session is answered with 401 by `protect`. Authorisation rules live in
 * services/vaultAccess.js; storage in services/vaultStorage.js.
 *
 * What clients never receive: the S3 key, the bucket name as data, the encryption IV, or any
 * storage error detail. Documents are returned through `toDocumentSummary` only.
 *
 * Every upload, listing, download and verification attempt, allowed or not, is written as an audit
 * event (utils/auditLogger.js). Pre-signed URLs are bearer credentials and are never logged.
 */

import { createHash, randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { HTTP_STATUS } from '../constants/httpStatus.js';
import { VAULT_MESSAGES } from '../constants/messages.js';
import { VAULT_FIELD_LIMITS } from '../constants/validation.js';
import DocumentVault, { VAULT_DOCUMENT_STATUSES, buildVaultObjectKey } from '../models/DocumentVault.js';
import EmployeeProfile from '../models/EmployeeProfile.js';
import {
  DEFAULT_ACCESSIBLE_ROLES,
  VAULT_DENIAL_REASONS,
  evaluateDocumentReadAccess,
  evaluateUploadAccess,
  evaluateVerifyAccess,
  findOwnEmployeeProfileId,
  isVaultManagerRole,
} from '../services/vaultAccess.js';
import {
  createVaultDownloadUrl,
  deleteVaultObjectQuietly,
  getVaultServerSideEncryption,
  isVaultStorageConfigured,
  putVaultObject,
} from '../services/vaultStorage.js';
import { sendError, sendSuccess } from '../utils/apiResponse.js';
import { AUDIT_OUTCOMES, recordAuditEvent } from '../utils/auditLogger.js';
import { logger } from '../utils/logger.js';
import { isValidObjectIdString } from '../validators/conversationValidators.js';
import { detectVaultFileType, sanitizeOriginalFileName, validateVaultUploadFields } from '../validators/vaultValidators.js';

const AUDIT_CATEGORY = 'document_vault';
const AUDIT_ACTIONS = Object.freeze({ UPLOAD: 'upload', LIST: 'list', DOWNLOAD: 'download', VERIFY: 'verify' });

/** The only shape in which a vault document leaves the server. */
function toDocumentSummary(documentRecord) {
  return {
    id: documentRecord._id.toString(),
    employeeId: documentRecord.employeeId.toString(),
    documentType: documentRecord.documentType,
    originalFileName: documentRecord.originalFileName,
    contentType: documentRecord.contentType,
    sizeBytes: documentRecord.sizeBytes,
    sha256Checksum: documentRecord.sha256Checksum,
    status: documentRecord.status,
    accessibleRoles: [...documentRecord.accessibleRoles],
    uploadedByUserId: documentRecord.uploadedByUserId.toString(),
    verifiedByUserId: documentRecord.verifiedByUserId ? documentRecord.verifiedByUserId.toString() : null,
    verifiedAt: documentRecord.verifiedAt ? documentRecord.verifiedAt.toISOString() : null,
    createdAt: documentRecord.createdAt.toISOString(),
  };
}

function audit(req, action, outcome, details = {}) {
  recordAuditEvent(req, { category: AUDIT_CATEGORY, action, outcome, ...details });
}

// =================================================================================================
// POST /api/vault/documents
// =================================================================================================

/**
 * Upload pipeline:
 *   1. Storage configured? (503)       2. Exactly one file? (400)       3. Fields valid? (400)
 *   4. Target employee exists? (404)   5. Caller may upload this type for this employee? (403)
 *   6. File bytes are PDF/JPEG/PNG? (415)
 *   7. SHA-256 the bytes, build a random object key, PUT to S3 with SSE + checksum (503 on failure)
 *   8. Save the metadata; if that fails, delete the S3 object so no orphan file remains
 * Responses: 201 { message, data: { document } }
 */
export async function uploadDocument(req, res, next) {
  try {
    if (!isVaultStorageConfigured()) {
      return sendError(req, res, HTTP_STATUS.SERVICE_UNAVAILABLE, VAULT_MESSAGES.STORAGE_NOT_CONFIGURED);
    }
    if (!req.file) {
      return sendError(req, res, HTTP_STATUS.BAD_REQUEST, VAULT_MESSAGES.FILE_REQUIRED, [{ field: 'file', message: VAULT_MESSAGES.FILE_REQUIRED }]);
    }

    const fieldValidation = validateVaultUploadFields(req.body);
    if (!fieldValidation.isValid) {
      audit(req, AUDIT_ACTIONS.UPLOAD, AUDIT_OUTCOMES.REJECTED, { reason: 'invalid_fields' });
      return sendError(req, res, HTTP_STATUS.BAD_REQUEST, fieldValidation.validationErrors[0].message, fieldValidation.validationErrors);
    }
    const { employeeId, documentType, accessibleRoles: requestedAccessibleRoles } = fieldValidation.sanitizedInput;

    if (!(await EmployeeProfile.exists({ _id: employeeId }))) {
      audit(req, AUDIT_ACTIONS.UPLOAD, AUDIT_OUTCOMES.REJECTED, { employeeId, documentType, reason: 'employee_not_found' });
      return sendError(req, res, HTTP_STATUS.NOT_FOUND, VAULT_MESSAGES.EMPLOYEE_NOT_FOUND);
    }

    const ownEmployeeProfileId = await findOwnEmployeeProfileId(req.user.id);
    const uploadAccess = evaluateUploadAccess({
      user: req.user,
      isOwnProfile: ownEmployeeProfileId === employeeId,
      documentType,
      requestedAccessibleRoles,
    });
    if (!uploadAccess.isAllowed) {
      audit(req, AUDIT_ACTIONS.UPLOAD, AUDIT_OUTCOMES.DENIED, { employeeId, documentType, reason: uploadAccess.denialReason });
      const denialMessage =
        uploadAccess.denialReason === VAULT_DENIAL_REASONS.ROLE_GRANT_BY_NON_MANAGER ? VAULT_MESSAGES.ROLE_GRANT_NOT_ALLOWED : VAULT_MESSAGES.UPLOAD_NOT_ALLOWED;
      return sendError(req, res, HTTP_STATUS.FORBIDDEN, denialMessage);
    }

    const fileBuffer = req.file.buffer;
    const detectedFileType = detectVaultFileType(fileBuffer);
    if (!detectedFileType) {
      audit(req, AUDIT_ACTIONS.UPLOAD, AUDIT_OUTCOMES.REJECTED, { employeeId, documentType, reason: 'unsupported_file_type', declaredContentType: req.file.mimetype });
      return sendError(req, res, HTTP_STATUS.UNSUPPORTED_MEDIA_TYPE, VAULT_MESSAGES.UNSUPPORTED_FILE_TYPE);
    }

    const sha256Digest = createHash('sha256').update(fileBuffer).digest();
    const objectKey = buildVaultObjectKey({
      employeeId,
      documentType,
      uploadedAtMs: Date.now(),
      objectUuid: randomUUID(),
      extension: detectedFileType.extension,
    });

    try {
      await putVaultObject({ objectKey, fileBuffer, contentType: detectedFileType.contentType, sha256Base64: sha256Digest.toString('base64') });
    } catch (storageError) {
      logger.error('Vault upload to S3 failed', { requestId: req.id, error: storageError.message, errorName: storageError.name, httpStatus: storageError.$metadata?.httpStatusCode });
      audit(req, AUDIT_ACTIONS.UPLOAD, AUDIT_OUTCOMES.FAILED, { employeeId, documentType, reason: 'storage_unavailable' });
      return sendError(req, res, HTTP_STATUS.SERVICE_UNAVAILABLE, VAULT_MESSAGES.STORAGE_UNAVAILABLE);
    }

    let documentRecord;
    try {
      documentRecord = await DocumentVault.create({
        employeeId,
        documentType,
        originalFileName: sanitizeOriginalFileName(req.file.originalname, detectedFileType.extension),
        contentType: detectedFileType.contentType,
        sizeBytes: fileBuffer.length,
        sha256Checksum: sha256Digest.toString('hex'),
        encryptionIv: null,
        s3KeyPath: objectKey,
        serverSideEncryption: getVaultServerSideEncryption(),
        accessibleRoles: requestedAccessibleRoles ?? DEFAULT_ACCESSIBLE_ROLES,
        uploadedByUserId: req.user.id,
      });
    } catch (metadataError) {
      // The file is in S3 but nothing references it; remove it before reporting the failure.
      await deleteVaultObjectQuietly(objectKey, req.id);
      audit(req, AUDIT_ACTIONS.UPLOAD, AUDIT_OUTCOMES.FAILED, { employeeId, documentType, reason: 'metadata_save_failed' });
      throw metadataError;
    }

    audit(req, AUDIT_ACTIONS.UPLOAD, AUDIT_OUTCOMES.ALLOWED, {
      documentId: documentRecord._id.toString(),
      employeeId,
      documentType,
      sizeBytes: documentRecord.sizeBytes,
      accessibleRoles: documentRecord.accessibleRoles,
    });
    return sendSuccess(res, HTTP_STATUS.CREATED, VAULT_MESSAGES.DOCUMENT_UPLOADED, { document: toDocumentSummary(documentRecord) });
  } catch (error) {
    return next(error);
  }
}

// =================================================================================================
// GET /api/vault/employees/:employeeId/documents
// =================================================================================================

/**
 * The owner sees all their documents; admin/hr see the documents whose accessibleRoles include
 * their role; anyone else gets 403. The filter is applied in the query, so documents the caller
 * may not read are never loaded.
 * Responses: 200 { message, data: { documents: [summary], meta: { count, limit } } }, 400, 403, 404
 */
export async function listEmployeeDocuments(req, res, next) {
  try {
    const { employeeId } = req.params;
    if (!isValidObjectIdString(employeeId)) {
      return sendError(req, res, HTTP_STATUS.BAD_REQUEST, VAULT_MESSAGES.INVALID_EMPLOYEE_ID, [{ field: 'employeeId', message: VAULT_MESSAGES.INVALID_EMPLOYEE_ID }]);
    }
    const normalizedEmployeeId = employeeId.toLowerCase();
    if (!(await EmployeeProfile.exists({ _id: normalizedEmployeeId }))) {
      return sendError(req, res, HTTP_STATUS.NOT_FOUND, VAULT_MESSAGES.EMPLOYEE_NOT_FOUND);
    }

    const ownEmployeeProfileId = await findOwnEmployeeProfileId(req.user.id);
    const isOwner = ownEmployeeProfileId === normalizedEmployeeId;
    if (!isOwner && !isVaultManagerRole(req.user.role)) {
      audit(req, AUDIT_ACTIONS.LIST, AUDIT_OUTCOMES.DENIED, { employeeId: normalizedEmployeeId, reason: VAULT_DENIAL_REASONS.NOT_OWNER_AND_ROLE_NOT_GRANTED });
      return sendError(req, res, HTTP_STATUS.FORBIDDEN, VAULT_MESSAGES.ACCESS_DENIED);
    }

    const visibilityFilter = isOwner ? { employeeId: normalizedEmployeeId } : { employeeId: normalizedEmployeeId, accessibleRoles: req.user.role };
    const documentRecords = await DocumentVault.find(visibilityFilter).sort({ createdAt: -1 }).limit(VAULT_FIELD_LIMITS.LIST_LIMIT).lean();

    audit(req, AUDIT_ACTIONS.LIST, AUDIT_OUTCOMES.ALLOWED, { employeeId: normalizedEmployeeId, grantBasis: isOwner ? 'owner' : 'role', documentCount: documentRecords.length });
    return sendSuccess(res, HTTP_STATUS.OK, VAULT_MESSAGES.DOCUMENTS_RETRIEVED, {
      documents: documentRecords.map(toDocumentSummary),
      meta: { count: documentRecords.length, limit: VAULT_FIELD_LIMITS.LIST_LIMIT },
    });
  } catch (error) {
    return next(error);
  }
}

// =================================================================================================
// GET /api/vault/download/:documentId
// =================================================================================================

/**
 * Secure download flow:
 *   1. Authentication: done by `protect` (401 before this runs).
 *   2. Resolution: load the document, including its storage key, by id. 400 malformed id, 404 missing.
 *   3. Authorisation: owner (via EmployeeProfile.userId) or role in accessibleRoles, else 403.
 *   4. Pre-signed URL: S3 GET URL with expiresIn exactly 60 seconds, forcing an attachment download.
 *   5. Response: the URL and its expiry only; no key, bucket or storage metadata as data.
 * Every attempt is audited, including malformed and not-found ones (probing shows up in the log).
 *
 * Responses:
 *   200 { message, data: { download: { url, expiresAt, expiresInSeconds, fileName, contentType, sizeBytes } } }
 *   400 / 403 / 404 / 503 (storage not configured or unavailable)
 */
export async function downloadDocument(req, res, next) {
  try {
    const { documentId } = req.params;
    if (!isValidObjectIdString(documentId)) {
      audit(req, AUDIT_ACTIONS.DOWNLOAD, AUDIT_OUTCOMES.REJECTED, { reason: 'invalid_document_id' });
      return sendError(req, res, HTTP_STATUS.BAD_REQUEST, VAULT_MESSAGES.INVALID_DOCUMENT_ID, [{ field: 'documentId', message: VAULT_MESSAGES.INVALID_DOCUMENT_ID }]);
    }

    const documentRecord = await DocumentVault.findById(documentId).select('+s3KeyPath').lean();
    if (!documentRecord) {
      audit(req, AUDIT_ACTIONS.DOWNLOAD, AUDIT_OUTCOMES.REJECTED, { documentId, reason: 'document_not_found' });
      return sendError(req, res, HTTP_STATUS.NOT_FOUND, VAULT_MESSAGES.DOCUMENT_NOT_FOUND);
    }

    const ownEmployeeProfileId = await findOwnEmployeeProfileId(req.user.id);
    const readAccess = evaluateDocumentReadAccess({ user: req.user, ownEmployeeProfileId, documentRecord });
    const auditContext = { documentId, employeeId: documentRecord.employeeId.toString(), documentType: documentRecord.documentType };
    if (!readAccess.isAllowed) {
      audit(req, AUDIT_ACTIONS.DOWNLOAD, AUDIT_OUTCOMES.DENIED, { ...auditContext, reason: readAccess.denialReason, accessibleRoles: documentRecord.accessibleRoles });
      return sendError(req, res, HTTP_STATUS.FORBIDDEN, VAULT_MESSAGES.ACCESS_DENIED);
    }

    if (!isVaultStorageConfigured()) {
      audit(req, AUDIT_ACTIONS.DOWNLOAD, AUDIT_OUTCOMES.FAILED, { ...auditContext, reason: 'storage_not_configured' });
      return sendError(req, res, HTTP_STATUS.SERVICE_UNAVAILABLE, VAULT_MESSAGES.STORAGE_NOT_CONFIGURED);
    }

    let signedDownload;
    try {
      signedDownload = await createVaultDownloadUrl({
        objectKey: documentRecord.s3KeyPath,
        downloadFileName: documentRecord.originalFileName,
        contentType: documentRecord.contentType,
      });
    } catch (signingError) {
      // Signing needs valid AWS credentials; a failure here is a server-side credential problem.
      logger.error('Vault download URL signing failed', { requestId: req.id, documentId, error: signingError.message, errorName: signingError.name });
      audit(req, AUDIT_ACTIONS.DOWNLOAD, AUDIT_OUTCOMES.FAILED, { ...auditContext, reason: 'signing_failed' });
      return sendError(req, res, HTTP_STATUS.SERVICE_UNAVAILABLE, VAULT_MESSAGES.STORAGE_UNAVAILABLE);
    }

    audit(req, AUDIT_ACTIONS.DOWNLOAD, AUDIT_OUTCOMES.ALLOWED, {
      ...auditContext,
      grantBasis: readAccess.grantBasis,
      urlExpiresAt: signedDownload.expiresAt,
    });
    return sendSuccess(res, HTTP_STATUS.OK, VAULT_MESSAGES.DOWNLOAD_URL_ISSUED, {
      download: {
        url: signedDownload.downloadUrl,
        expiresAt: signedDownload.expiresAt,
        expiresInSeconds: VAULT_FIELD_LIMITS.DOWNLOAD_URL_TTL_SECONDS,
        fileName: documentRecord.originalFileName,
        contentType: documentRecord.contentType,
        sizeBytes: documentRecord.sizeBytes,
      },
    });
  } catch (error) {
    return next(error);
  }
}

// =================================================================================================
// PATCH /api/vault/documents/:documentId/verify
// =================================================================================================

/**
 * Marks a document Verified. Allowed for a role in accessibleRoles, never for the owner.
 * Optimistic concurrency turns a race between two verifiers into one success and one 409.
 * Responses: 200 { message, data: { document } }, 400, 403, 404, 409
 */
export async function verifyDocument(req, res, next) {
  try {
    const { documentId } = req.params;
    if (!isValidObjectIdString(documentId)) {
      return sendError(req, res, HTTP_STATUS.BAD_REQUEST, VAULT_MESSAGES.INVALID_DOCUMENT_ID, [{ field: 'documentId', message: VAULT_MESSAGES.INVALID_DOCUMENT_ID }]);
    }
    const documentRecord = await DocumentVault.findById(documentId);
    if (!documentRecord) {
      audit(req, AUDIT_ACTIONS.VERIFY, AUDIT_OUTCOMES.REJECTED, { documentId, reason: 'document_not_found' });
      return sendError(req, res, HTTP_STATUS.NOT_FOUND, VAULT_MESSAGES.DOCUMENT_NOT_FOUND);
    }

    const ownEmployeeProfileId = await findOwnEmployeeProfileId(req.user.id);
    const verifyAccess = evaluateVerifyAccess({ user: req.user, ownEmployeeProfileId, documentRecord });
    const auditContext = { documentId, employeeId: documentRecord.employeeId.toString(), documentType: documentRecord.documentType };
    if (!verifyAccess.isAllowed) {
      audit(req, AUDIT_ACTIONS.VERIFY, AUDIT_OUTCOMES.DENIED, { ...auditContext, reason: verifyAccess.denialReason });
      const denialMessage = verifyAccess.denialReason === VAULT_DENIAL_REASONS.SELF_VERIFICATION ? VAULT_MESSAGES.CANNOT_VERIFY_OWN_DOCUMENT : VAULT_MESSAGES.VERIFY_NOT_ALLOWED;
      return sendError(req, res, HTTP_STATUS.FORBIDDEN, denialMessage);
    }
    if (documentRecord.status === VAULT_DOCUMENT_STATUSES.VERIFIED) {
      return sendError(req, res, HTTP_STATUS.CONFLICT, VAULT_MESSAGES.ALREADY_VERIFIED);
    }

    documentRecord.markVerified(req.user.id);
    try {
      await documentRecord.save();
    } catch (saveError) {
      if (saveError instanceof mongoose.Error.VersionError) {
        return sendError(req, res, HTTP_STATUS.CONFLICT, VAULT_MESSAGES.CONCURRENT_UPDATE);
      }
      throw saveError;
    }

    audit(req, AUDIT_ACTIONS.VERIFY, AUDIT_OUTCOMES.ALLOWED, auditContext);
    return sendSuccess(res, HTTP_STATUS.OK, VAULT_MESSAGES.DOCUMENT_VERIFIED, { document: toDocumentSummary(documentRecord) });
  } catch (error) {
    return next(error);
  }
}
