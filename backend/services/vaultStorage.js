/**
 * S3 storage for the employee document vault (AWS SDK v3).
 *
 * Configuration (validated in server.js loadConfig, passed to initVaultStorage):
 *   VAULT_S3_BUCKET            bucket name; when unset the vault is disabled and its routes answer 503
 *   AWS_REGION                 the bucket's region (required with a bucket)
 *   VAULT_S3_SSE               'aws:kms' (default) or 'AES256'
 *   VAULT_S3_KMS_KEY_ID        optional customer-managed KMS key (ARN or alias) for 'aws:kms';
 *                              without it S3 uses the AWS-managed key aws/s3
 *   VAULT_S3_ENDPOINT          optional, for S3-compatible stores (MinIO, LocalStack, S3Mock)
 *   VAULT_S3_FORCE_PATH_STYLE  'true' for stores that need path-style URLs
 *
 * Credentials are never part of the configuration: the SDK's default provider chain reads them
 * from the environment (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY), the shared config file, or the
 * instance / task IAM role, which is the recommended source in production.
 *
 * Least-privilege IAM policy for the backend's role (replace the bucket name):
 *   s3:PutObject, s3:GetObject, s3:DeleteObject  on  arn:aws:s3:::<bucket>/vault/*
 *   kms:GenerateDataKey, kms:Decrypt              on  the KMS key (when using a customer-managed key)
 * The bucket itself should block all public access and deny requests without TLS
 * (aws:SecureTransport = false).
 *
 * Security properties of this module:
 *   - Every object is written with server-side encryption and `Cache-Control: no-store`.
 *   - Uploads carry a SHA-256 checksum computed by the backend; S3 rejects the write if the bytes
 *     it received differ.
 *   - Downloads are pre-signed GET URLs valid for exactly VAULT_FIELD_LIMITS.DOWNLOAD_URL_TTL_SECONDS
 *     (60 s). The signature also fixes the response headers (attachment disposition, content type,
 *     no-store), so a client cannot change them without invalidating the URL.
 *   - Object keys and the bucket name are never returned by this module's callers as data; they
 *     appear only inside the pre-signed URL, where the random object name reveals nothing. The URL
 *     also carries the download file name (in the signed response-content-disposition parameter),
 *     which only the authorised requester receives. Setting the name as S3 object metadata instead
 *     would keep it out of the URL but store the employee's file name unencrypted in S3 metadata
 *     (SSE does not cover metadata), so the per-request override was chosen.
 *   - Network calls have connect/request timeouts and bounded retries, so a slow S3 cannot hold a
 *     request (and its 10 MB buffer) open indefinitely.
 */

import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { VAULT_FIELD_LIMITS } from '../constants/validation.js';
import { VAULT_SERVER_SIDE_ENCRYPTION } from '../models/DocumentVault.js';
import { logger } from '../utils/logger.js';
import { createS3Client } from '../utils/s3Client.js';

/** @type {{ s3Client: import('@aws-sdk/client-s3').S3Client, bucketName: string, serverSideEncryption: string, kmsKeyId: string | null } | null} */
let vaultStorage = null;

/** Thrown when the vault is used without being configured; the controller maps it to 503. */
export class VaultStorageNotConfiguredError extends Error {
  constructor() {
    super('Document vault storage is not configured (VAULT_S3_BUCKET is not set)');
    this.name = 'VaultStorageNotConfiguredError';
  }
}

/**
 * Creates the S3 client. Call once at startup.
 * @param {{ bucketName: string, region: string, serverSideEncryption: string, kmsKeyId: string | null,
 *           endpoint: string | null, forcePathStyle: boolean } | null} vaultConfig  null disables the vault.
 */
export function initVaultStorage(vaultConfig) {
  if (vaultStorage) throw new Error('initVaultStorage was called more than once');
  if (!vaultConfig) {
    logger.info('Document vault storage disabled', { reason: 'VAULT_S3_BUCKET is not set' });
    return;
  }

  const s3Client = createS3Client(vaultConfig);

  vaultStorage = {
    s3Client,
    bucketName: vaultConfig.bucketName,
    serverSideEncryption: vaultConfig.serverSideEncryption,
    kmsKeyId: vaultConfig.serverSideEncryption === VAULT_SERVER_SIDE_ENCRYPTION.KMS ? vaultConfig.kmsKeyId : null,
  };
  logger.info('Document vault storage ready', {
    bucketName: vaultConfig.bucketName,
    region: vaultConfig.region,
    serverSideEncryption: vaultConfig.serverSideEncryption,
    customerManagedKmsKey: Boolean(vaultStorage.kmsKeyId),
    customEndpoint: Boolean(vaultConfig.endpoint),
  });
}

export function isVaultStorageConfigured() {
  return vaultStorage !== null;
}

/** The encryption mode new uploads use, recorded on the metadata document. */
export function getVaultServerSideEncryption() {
  if (!vaultStorage) throw new VaultStorageNotConfiguredError();
  return vaultStorage.serverSideEncryption;
}

/** Releases the client's sockets. Safe to call when the vault is disabled. */
export function closeVaultStorage() {
  vaultStorage?.s3Client.destroy();
  vaultStorage = null;
}

/**
 * Stores one document with server-side encryption and an integrity checksum.
 * @param {{ objectKey: string, fileBuffer: Buffer, contentType: string, sha256Base64: string }} upload
 * @throws S3 / network errors (after the SDK's retries)
 */
export async function putVaultObject({ objectKey, fileBuffer, contentType, sha256Base64 }) {
  if (!vaultStorage) throw new VaultStorageNotConfiguredError();
  await vaultStorage.s3Client.send(
    new PutObjectCommand({
      Bucket: vaultStorage.bucketName,
      Key: objectKey,
      Body: fileBuffer,
      ContentLength: fileBuffer.length,
      ContentType: contentType,
      CacheControl: 'no-store',
      ChecksumSHA256: sha256Base64,
      ServerSideEncryption: vaultStorage.serverSideEncryption,
      ...(vaultStorage.kmsKeyId && { SSEKMSKeyId: vaultStorage.kmsKeyId }),
    }),
  );
}

/**
 * Deletes an object. Used to undo an upload whose metadata could not be saved, so no unreferenced
 * file is left in the bucket. Never throws: a failure is logged with the key for manual cleanup
 * (server logs only; the key is not client data).
 */
export async function deleteVaultObjectQuietly(objectKey, requestId) {
  if (!vaultStorage) return;
  try {
    await vaultStorage.s3Client.send(new DeleteObjectCommand({ Bucket: vaultStorage.bucketName, Key: objectKey }));
  } catch (deleteError) {
    logger.error('Vault object cleanup failed; remove it manually', { requestId, objectKey, error: deleteError.message });
  }
}

/**
 * `attachment` Content-Disposition with an ASCII fallback name and the exact UTF-8 name (RFC 6266 /
 * RFC 5987), so names in any script download correctly and quotes cannot break the header.
 */
function buildAttachmentDisposition(downloadFileName) {
  const asciiFallbackName = downloadFileName.replace(/[^\x20-\x7E]|["\\]/g, '_');
  const encodedName = encodeURIComponent(downloadFileName).replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${asciiFallbackName}"; filename*=UTF-8''${encodedName}`;
}

/**
 * Creates a pre-signed GET URL for one object, valid for exactly 60 seconds.
 * @returns {Promise<{ downloadUrl: string, expiresAt: string }>}
 */
export async function createVaultDownloadUrl({ objectKey, downloadFileName, contentType }) {
  if (!vaultStorage) throw new VaultStorageNotConfiguredError();
  const expiresInSeconds = VAULT_FIELD_LIMITS.DOWNLOAD_URL_TTL_SECONDS;
  const signedAtMs = Date.now();
  const downloadUrl = await getSignedUrl(
    vaultStorage.s3Client,
    new GetObjectCommand({
      Bucket: vaultStorage.bucketName,
      Key: objectKey,
      ResponseContentDisposition: buildAttachmentDisposition(downloadFileName),
      ResponseContentType: contentType,
      ResponseCacheControl: 'no-store',
    }),
    { expiresIn: expiresInSeconds },
  );
  return { downloadUrl, expiresAt: new Date(signedAtMs + expiresInSeconds * 1000).toISOString() };
}
