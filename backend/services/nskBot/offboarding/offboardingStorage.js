/**
 * Where offboarding documents are kept: the OFFBOARDING_S3_* bucket, on the shared S3 object store
 * (utils/s3ObjectStore.js: hashing upload, server-side encryption, 60-second download links).
 *
 *   company-offboarding/<caseId>/<kind>_<random>.pdf|.xlsx
 *
 * Keys hold ids only, never names; the random part keeps a regenerated document from overwriting the
 * one it replaces before its record is updated.
 *
 * IAM for the backend's role: s3:PutObject, s3:GetObject, s3:DeleteObject (and the KMS key's
 * GenerateDataKey/Decrypt) on arn:aws:s3:::<bucket>/company-offboarding/*.
 */

import { randomBytes } from 'node:crypto';
import { OFFBOARDING_SETTINGS } from '../../../constants/validation.js';
import { createS3ObjectStore } from '../../../utils/s3ObjectStore.js';

export const OFFBOARDING_KEY_PREFIX = 'company-offboarding';

export const offboardingStore = createS3ObjectStore({
  label: 'Offboarding',
  maxObjectBytes: Math.max(OFFBOARDING_SETTINGS.PDF_MAX_BYTES, OFFBOARDING_SETTINGS.WORKBOOK_MAX_BYTES),
});

/** company-offboarding/<caseId>/relieving_letter_<16 hex>.pdf */
export function offboardingObjectKey(caseId, kind, extension) {
  return `${OFFBOARDING_KEY_PREFIX}/${caseId}/${kind.toLowerCase()}_${randomBytes(8).toString('hex')}.${extension}`;
}
