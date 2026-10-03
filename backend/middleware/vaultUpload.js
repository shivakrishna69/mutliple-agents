/**
 * Multipart intake for vault uploads (multer, memory storage).
 *
 * The file is buffered in memory (never written to the server's disk, where it would outlive the
 * request unencrypted) and handed to the controller, which checks it and streams the buffer to S3.
 *
 * Abuse limits, enforced while the request is being read:
 *   - exactly one file, in the field "file", at most VAULT_FIELD_LIMITS.MAX_FILE_BYTES
 *   - at most 5 text fields, each at most 1 KB, field names at most 50 bytes
 *   - a declared Content-Length far above the limit is refused before any byte is read
 * Route order matters: `protect` (session + CSRF) and the per-user rate limit run before this, so
 * an unauthenticated client cannot make the server buffer anything.
 *
 * Errors become precise client responses: 413 for an oversized file, 415 when the request is not
 * multipart, 400 for anything malformed.
 */

import multer from 'multer';
import { HTTP_STATUS } from '../constants/httpStatus.js';
import { VAULT_MESSAGES } from '../constants/messages.js';
import { VAULT_FIELD_LIMITS } from '../constants/validation.js';
import { sendError } from '../utils/apiResponse.js';
import { logger } from '../utils/logger.js';

const VAULT_FILE_FIELD_NAME = 'file';
// Room for the multipart boundaries and the small text fields around the file.
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

const receiveSingleVaultFile = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: VAULT_FIELD_LIMITS.MAX_FILE_BYTES,
    files: 1,
    fields: 5,
    fieldNameSize: 50,
    fieldSize: 1024,
    parts: 6,
    headerPairs: 20,
  },
  // Decode non-ASCII file names as UTF-8 (the browser default) rather than Latin-1.
  defParamCharset: 'utf8',
}).single(VAULT_FILE_FIELD_NAME);

/** Maps multer's limit errors to a status and message the client can act on. */
function describeMulterError(multerError) {
  switch (multerError.code) {
    case 'LIMIT_FILE_SIZE':
      return { statusCode: HTTP_STATUS.PAYLOAD_TOO_LARGE, message: VAULT_MESSAGES.FILE_TOO_LARGE };
    case 'LIMIT_FILE_COUNT':
    case 'LIMIT_UNEXPECTED_FILE':
      return { statusCode: HTTP_STATUS.BAD_REQUEST, message: VAULT_MESSAGES.FILE_REQUIRED };
    default:
      return { statusCode: HTTP_STATUS.BAD_REQUEST, message: VAULT_MESSAGES.MALFORMED_UPLOAD };
  }
}

export function receiveVaultUpload(req, res, next) {
  if (!req.is('multipart/form-data')) {
    return sendError(req, res, HTTP_STATUS.UNSUPPORTED_MEDIA_TYPE, VAULT_MESSAGES.MULTIPART_REQUIRED);
  }
  const declaredContentLength = Number(req.get('content-length'));
  if (Number.isFinite(declaredContentLength) && declaredContentLength > VAULT_FIELD_LIMITS.MAX_FILE_BYTES + MULTIPART_OVERHEAD_BYTES) {
    return sendError(req, res, HTTP_STATUS.PAYLOAD_TOO_LARGE, VAULT_MESSAGES.FILE_TOO_LARGE);
  }

  return receiveSingleVaultFile(req, res, (uploadError) => {
    if (!uploadError) return next();
    if (uploadError instanceof multer.MulterError) {
      const { statusCode, message } = describeMulterError(uploadError);
      logger.warn('Vault upload rejected while reading', { requestId: req.id, userId: req.user?.id, code: uploadError.code });
      return sendError(req, res, statusCode, message);
    }
    // Errors from the multipart parser itself (truncated body, broken boundary) are client errors.
    logger.warn('Vault upload could not be parsed', { requestId: req.id, userId: req.user?.id, error: uploadError.message });
    return sendError(req, res, HTTP_STATUS.BAD_REQUEST, VAULT_MESSAGES.MALFORMED_UPLOAD);
  });
}
