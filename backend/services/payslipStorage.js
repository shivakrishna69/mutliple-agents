/**
 * Payslip storage: the upload stage of the payslip pipeline (services/payslipService.js), on the
 * shared S3 object store (utils/s3ObjectStore.js: hashing upload, server-side encryption, 60-second
 * download links).
 *
 *   PDF Readable ──► SHA-256 + byte-count transform ──► S3 managed upload
 *                                                        company-payslips/YYYY/MM/<employeeId>_<payslipId>.pdf
 *
 * The resulting SHA-256 is stored with the Payslip record and lets anyone holding the file prove it
 * is the issued one. Keys are built from ids only (no names), so a key reveals nothing about its owner.
 *
 * IAM for the backend's role: s3:PutObject, s3:GetObject, s3:DeleteObject (and the KMS key's
 * GenerateDataKey/Decrypt) on arn:aws:s3:::<bucket>/company-payslips/*.
 */

import { DOWNLOAD_URL_TTL_SECONDS, createS3ObjectStore } from '../utils/s3ObjectStore.js';

export const PAYSLIP_KEY_PREFIX = 'company-payslips';
export const PAYSLIP_DOWNLOAD_URL_TTL_SECONDS = DOWNLOAD_URL_TTL_SECONDS;
// Payslips are well under this; anything larger means the template went wrong.
const MAX_PAYSLIP_PDF_BYTES = 5 * 1024 * 1024;
const PDF_CONTENT_TYPE = 'application/pdf';

export class PayslipStorageError extends Error {
  constructor(message, { cause } = {}) {
    super(message, { cause });
    this.name = 'PayslipStorageError';
  }
}

const payslipStore = createS3ObjectStore({
  label: 'Payslip',
  maxObjectBytes: MAX_PAYSLIP_PDF_BYTES,
  StoreError: PayslipStorageError,
});

/** @param {object|null} storageConfig  config/environment.js loadS3StorageConfig(env, 'PAYSLIP') */
export const initPayslipStorage = (storageConfig) => payslipStore.init(storageConfig);

export const isPayslipStorageConfigured = () => payslipStore.isConfigured();

export const getPayslipServerSideEncryption = () => payslipStore.serverSideEncryption();

export const closePayslipStorage = () => payslipStore.close();

/** company-payslips/2026/10/<employeeId>_<payslipId>.pdf */
export function buildPayslipObjectKey({ year, month, employeeId, payslipId }) {
  return `${PAYSLIP_KEY_PREFIX}/${year}/${String(month).padStart(2, '0')}/${employeeId}_${payslipId}.pdf`;
}

/**
 * Pipes a PDF stream into S3 under `objectKey`.
 * @returns {Promise<{ sha256: string, sizeBytes: number }>}
 * @throws {PayslipStorageError}
 */
export const uploadPayslipPdf = (pdfStream, objectKey) => payslipStore.upload(pdfStream, objectKey, PDF_CONTENT_TYPE);

/** Removes an object; used to undo an upload whose metadata could not be saved. Never throws. */
export const deletePayslipObjectQuietly = (objectKey, requestId) => payslipStore.deleteQuietly(objectKey, requestId);

/** 60-second pre-signed download URL that saves the file as `downloadFileName`. */
export const createPayslipDownloadUrl = (objectKey, downloadFileName) =>
  payslipStore.createDownloadUrl(objectKey, downloadFileName, PDF_CONTENT_TYPE);
