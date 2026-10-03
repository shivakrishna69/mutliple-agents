/**
 * Payslip storage: the upload stage of the payslip pipeline (services/payslipService.js).
 *
 *   PDF Readable ──► SHA-256 + byte-count transform ──► S3 managed upload (@aws-sdk/lib-storage)
 *                                                        company-payslips/YYYY/MM/<employeeId>_<payslipId>.pdf
 *
 * The PDF is piped through a hashing transform straight into the upload, so the bytes are hashed
 * exactly as they are sent; the resulting SHA-256 is stored with the Payslip record and lets anyone
 * holding the file prove it is the issued one. The managed upload streams the body (and switches to
 * multipart for large bodies), so memory use does not grow with document size.
 *
 * Object settings: server-side encryption (aws:kms or AES256, from PAYSLIP_S3_SSE), content type
 * application/pdf, Cache-Control no-store, and an SDK-computed SHA-256 checksum that S3 verifies on
 * receipt. Keys are built from ids only (no names), so a key reveals nothing about its owner.
 *
 * Downloads are pre-signed GET URLs valid for 60 seconds that force an attachment download with a
 * friendly file name; the key never leaves the server as data.
 *
 * IAM for the backend's role: s3:PutObject, s3:GetObject, s3:DeleteObject (and the KMS key's
 * GenerateDataKey/Decrypt) on arn:aws:s3:::<bucket>/company-payslips/*.
 */

import { createHash } from 'node:crypto';
import { Transform } from 'node:stream';
import { DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { logger } from '../utils/logger.js';
import { createS3Client } from '../utils/s3Client.js';

export const PAYSLIP_KEY_PREFIX = 'company-payslips';
export const PAYSLIP_DOWNLOAD_URL_TTL_SECONDS = 60;
// Payslips are well under this; anything larger means the template went wrong.
const MAX_PAYSLIP_PDF_BYTES = 5 * 1024 * 1024;

/** @type {{ s3Client: import('@aws-sdk/client-s3').S3Client, bucketName: string, serverSideEncryption: string, kmsKeyId: string|null } | null} */
let payslipStorage = null;

export class PayslipStorageError extends Error {
  constructor(message, { cause } = {}) {
    super(message, { cause });
    this.name = 'PayslipStorageError';
  }
}

/** @param {object|null} storageConfig  server.js loadS3StorageConfig(env, 'PAYSLIP') */
export function initPayslipStorage(storageConfig) {
  if (payslipStorage) throw new Error('initPayslipStorage was called more than once');
  if (!storageConfig) return;
  payslipStorage = {
    s3Client: createS3Client(storageConfig),
    bucketName: storageConfig.bucketName,
    serverSideEncryption: storageConfig.serverSideEncryption,
    kmsKeyId: storageConfig.serverSideEncryption === 'aws:kms' ? storageConfig.kmsKeyId : null,
  };
  logger.info('Payslip storage ready', { bucketName: storageConfig.bucketName, serverSideEncryption: storageConfig.serverSideEncryption, customEndpoint: Boolean(storageConfig.endpoint) });
}

export function isPayslipStorageConfigured() {
  return payslipStorage !== null;
}

export function getPayslipServerSideEncryption() {
  return payslipStorage?.serverSideEncryption ?? null;
}

export function closePayslipStorage() {
  payslipStorage?.s3Client.destroy();
  payslipStorage = null;
}

/** company-payslips/2026/10/<employeeId>_<payslipId>.pdf */
export function buildPayslipObjectKey({ year, month, employeeId, payslipId }) {
  return `${PAYSLIP_KEY_PREFIX}/${year}/${String(month).padStart(2, '0')}/${employeeId}_${payslipId}.pdf`;
}

/** Counts and hashes bytes as they pass through; refuses bodies over MAX_PAYSLIP_PDF_BYTES. */
function createDigestingStream() {
  const sha256 = createHash('sha256');
  let byteCount = 0;
  const digestingStream = new Transform({
    transform(chunk, encoding, callback) {
      byteCount += chunk.length;
      if (byteCount > MAX_PAYSLIP_PDF_BYTES) {
        callback(new PayslipStorageError(`PDF exceeds ${MAX_PAYSLIP_PDF_BYTES} bytes`));
        return;
      }
      sha256.update(chunk);
      callback(null, chunk);
    },
  });
  return { digestingStream, digest: () => ({ sha256: sha256.digest('hex'), sizeBytes: byteCount }) };
}

/**
 * Pipes a PDF stream into S3 under `objectKey`.
 * @param {import('node:stream').Readable} pdfStream
 * @param {string} objectKey
 * @returns {Promise<{ sha256: string, sizeBytes: number }>}
 * @throws {PayslipStorageError}
 */
export async function uploadPayslipPdf(pdfStream, objectKey) {
  if (!payslipStorage) throw new PayslipStorageError('Payslip storage is not configured');
  const { digestingStream, digest } = createDigestingStream();
  // A failure of the source stream ends the upload; marked handled so an error after the upload has
  // settled cannot surface as an unhandled rejection (which server.js treats as fatal).
  const sourceFailure = new Promise((resolve, reject) => pdfStream.once('error', reject));
  sourceFailure.catch(() => {});
  pdfStream.pipe(digestingStream);

  const managedUpload = new Upload({
    client: payslipStorage.s3Client,
    params: {
      Bucket: payslipStorage.bucketName,
      Key: objectKey,
      Body: digestingStream,
      ContentType: 'application/pdf',
      CacheControl: 'no-store',
      ChecksumAlgorithm: 'SHA256',
      ServerSideEncryption: payslipStorage.serverSideEncryption,
      ...(payslipStorage.kmsKeyId && { SSEKMSKeyId: payslipStorage.kmsKeyId }),
    },
    queueSize: 1,
    leavePartsOnError: false,
  });

  try {
    await Promise.race([managedUpload.done(), sourceFailure]);
  } catch (uploadError) {
    if (uploadError instanceof PayslipStorageError) throw uploadError;
    throw new PayslipStorageError(`Payslip upload failed: ${uploadError.message}`, { cause: uploadError });
  }
  const { sha256, sizeBytes } = digest();
  if (sizeBytes === 0) throw new PayslipStorageError('PDF stream was empty');
  return { sha256, sizeBytes };
}

/** Removes an object; used to undo an upload whose metadata could not be saved. Never throws. */
export async function deletePayslipObjectQuietly(objectKey, requestId) {
  if (!payslipStorage) return;
  try {
    await payslipStorage.s3Client.send(new DeleteObjectCommand({ Bucket: payslipStorage.bucketName, Key: objectKey }));
  } catch (deleteError) {
    logger.error('Payslip object cleanup failed; remove it manually', { requestId, objectKey, error: deleteError.message });
  }
}

/** 60-second pre-signed download URL that saves the file as `downloadFileName`. */
export async function createPayslipDownloadUrl(objectKey, downloadFileName) {
  if (!payslipStorage) throw new PayslipStorageError('Payslip storage is not configured');
  const signedAtMs = Date.now();
  const asciiFileName = downloadFileName.replace(/[^\x20-\x7E]|["\\]/g, '_');
  const downloadUrl = await getSignedUrl(
    payslipStorage.s3Client,
    new GetObjectCommand({
      Bucket: payslipStorage.bucketName,
      Key: objectKey,
      ResponseContentDisposition: `attachment; filename="${asciiFileName}"; filename*=UTF-8''${encodeURIComponent(downloadFileName)}`,
      ResponseContentType: 'application/pdf',
      ResponseCacheControl: 'no-store',
    }),
    { expiresIn: PAYSLIP_DOWNLOAD_URL_TTL_SECONDS },
  );
  return { downloadUrl, expiresAt: new Date(signedAtMs + PAYSLIP_DOWNLOAD_URL_TTL_SECONDS * 1000).toISOString() };
}
