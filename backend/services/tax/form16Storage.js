/**
 * Form 16 storage, on the shared S3 object store (utils/s3ObjectStore.js: hashing upload, server-side
 * encryption, 60-second download links), configured by TAX_DOCS_S3_* (config/environment.js).
 *
 *   company-tax-docs/form16/<financialYear>/<employeeId>/<recordId>.pdf
 *
 * Keys are built from ids only, so a key reveals nothing about its owner.
 *
 * IAM for the backend's role: s3:PutObject, s3:GetObject, s3:DeleteObject (and the KMS key's
 * GenerateDataKey/Decrypt) on arn:aws:s3:::<bucket>/company-tax-docs/*.
 */

import { FORM16_SETTINGS } from '../../constants/validation.js';
import { createS3ObjectStore } from '../../utils/s3ObjectStore.js';

export const TAX_DOCS_KEY_PREFIX = 'company-tax-docs';
const PDF_CONTENT_TYPE = 'application/pdf';

export class Form16StorageError extends Error {
  constructor(message, { cause } = {}) {
    super(message, { cause });
    this.name = 'Form16StorageError';
  }
}

export const form16Store = createS3ObjectStore({
  label: 'Form 16',
  maxObjectBytes: FORM16_SETTINGS.MAX_FILE_BYTES,
  StoreError: Form16StorageError,
});

/** company-tax-docs/form16/2025-26/<employeeId>/<recordId>.pdf */
export function buildForm16ObjectKey({ financialYear, employeeId, recordId }) {
  return `${TAX_DOCS_KEY_PREFIX}/form16/${financialYear}/${employeeId}/${recordId}.pdf`;
}

export const uploadForm16Pdf = (pdfStream, objectKey) => form16Store.upload(pdfStream, objectKey, PDF_CONTENT_TYPE);

export const createForm16DownloadUrl = (objectKey, downloadFileName) =>
  form16Store.createDownloadUrl(objectKey, downloadFileName, PDF_CONTENT_TYPE);
