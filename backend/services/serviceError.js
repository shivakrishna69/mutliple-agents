/**
 * An error a service throws for a situation the client can act on: not found, conflict, stale
 * version, not allowed. `httpStatus` and the stable `code` go into the API response; anything
 * else a service throws is unexpected and reaches the central error handler as a 500.
 *
 * Used by the HR features built on controllers/workforceHandler.js (work calendar, offices, leave),
 * with the errors and the versioned save they share.
 */

import mongoose from 'mongoose';
import { HTTP_STATUS } from '../constants/httpStatus.js';
import { COMMON_MESSAGES } from '../constants/messages.js';
import { isDuplicateKeyError } from '../utils/mongoErrors.js';

export class ServiceError extends Error {
  constructor(httpStatus, code, message) {
    super(message);
    this.name = 'ServiceError';
    this.httpStatus = httpStatus;
    this.code = code;
  }
}

export const employeeNotFound = () =>
  new ServiceError(HTTP_STATUS.NOT_FOUND, 'EMPLOYEE_NOT_FOUND', COMMON_MESSAGES.EMPLOYEE_NOT_FOUND);

export const staleVersion = () =>
  new ServiceError(HTTP_STATUS.CONFLICT, 'STALE_VERSION', COMMON_MESSAGES.STALE_VERSION);

/** Refuses an edit based on a version other than the stored one. */
export function assertCurrentVersion(document, version) {
  if (document.__v !== version) throw staleVersion();
}

/**
 * Saves a document whose schema versions every save. Someone else saving first becomes
 * 409 STALE_VERSION; a unique-index clash becomes the error `onDuplicateKey` returns, when given.
 * @param {import('mongoose').Document} document
 * @param {{ onDuplicateKey?: () => ServiceError }} [options]
 */
export async function saveVersioned(document, { onDuplicateKey } = {}) {
  try {
    await document.save();
  } catch (saveError) {
    if (saveError instanceof mongoose.Error.VersionError) throw staleVersion();
    if (onDuplicateKey && isDuplicateKeyError(saveError)) throw onDuplicateKey();
    throw saveError;
  }
}
