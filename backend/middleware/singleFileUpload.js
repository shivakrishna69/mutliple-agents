/**
 * Multipart intake for endpoints that take one file (multer, memory storage): the vault's documents
 * and the employee import's CSV.
 *
 * The file is buffered in memory (never written to the server's disk, where it would outlive the
 * request unencrypted) and handed to the controller.
 *
 * Abuse limits, enforced while the request is being read:
 *   - exactly one file, in the field "file", at most `maxFileBytes`
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
import { sendError } from '../utils/apiResponse.js';
import { logger } from '../utils/logger.js';

const FILE_FIELD_NAME = 'file';
// Room for the multipart boundaries and the small text fields around the file.
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

/**
 * @param {{ maxFileBytes: number, logLabel: string,
 *   messages: { fileTooLarge: string, fileRequired: string, malformedUpload: string, multipartRequired: string } }} options
 * @returns {import('express').RequestHandler}
 */
export function createSingleFileUpload({ maxFileBytes, logLabel, messages }) {
  const receiveSingleFile = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: maxFileBytes,
      files: 1,
      fields: 5,
      fieldNameSize: 50,
      fieldSize: 1024,
      parts: 6,
      headerPairs: 20,
    },
    // Decode non-ASCII file names as UTF-8 (the browser default) rather than Latin-1.
    defParamCharset: 'utf8',
  }).single(FILE_FIELD_NAME);

  /** Maps multer's limit errors to a status and message the client can act on. */
  function describeMulterError(multerError) {
    switch (multerError.code) {
      case 'LIMIT_FILE_SIZE':
        return { statusCode: HTTP_STATUS.PAYLOAD_TOO_LARGE, message: messages.fileTooLarge };
      case 'LIMIT_FILE_COUNT':
      case 'LIMIT_UNEXPECTED_FILE':
        return { statusCode: HTTP_STATUS.BAD_REQUEST, message: messages.fileRequired };
      default:
        return { statusCode: HTTP_STATUS.BAD_REQUEST, message: messages.malformedUpload };
    }
  }

  return function receiveUpload(req, res, next) {
    if (!req.is('multipart/form-data')) {
      return sendError(req, res, HTTP_STATUS.UNSUPPORTED_MEDIA_TYPE, messages.multipartRequired);
    }
    const declaredContentLength = Number(req.get('content-length'));
    if (Number.isFinite(declaredContentLength) && declaredContentLength > maxFileBytes + MULTIPART_OVERHEAD_BYTES) {
      return sendError(req, res, HTTP_STATUS.PAYLOAD_TOO_LARGE, messages.fileTooLarge);
    }

    return receiveSingleFile(req, res, (uploadError) => {
      if (!uploadError) return next();
      if (uploadError instanceof multer.MulterError) {
        const { statusCode, message } = describeMulterError(uploadError);
        logger.warn(`${logLabel} upload rejected while reading`, {
          requestId: req.id,
          userId: req.user?.id,
          code: uploadError.code,
        });
        return sendError(req, res, statusCode, message);
      }
      // Errors from the multipart parser itself (truncated body, broken boundary) are client errors.
      logger.warn(`${logLabel} upload could not be parsed`, {
        requestId: req.id,
        userId: req.user?.id,
        error: uploadError.message,
      });
      return sendError(req, res, HTTP_STATUS.BAD_REQUEST, messages.malformedUpload);
    });
  };
}
