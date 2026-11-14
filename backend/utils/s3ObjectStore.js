/**
 * One S3 area for generated documents (payslips, offboarding letters and statements): upload a
 * stream, remove an object, and hand out short-lived download links. Each area has its own bucket
 * settings (config/environment.js loadS3StorageConfig) and its own store from this factory, so
 * every area uploads, hashes and signs the same way.
 *
 *   Readable ──► SHA-256 + byte-count transform ──► S3 managed upload (@aws-sdk/lib-storage)
 *
 * The bytes are hashed exactly as they are sent; the SHA-256 is kept with the record that names the
 * object, so anyone holding the file can prove it is the one issued. The managed upload streams the
 * body (multipart for large bodies), so memory does not grow with the document. Objects get
 * server-side encryption (aws:kms or AES256, from <AREA>_S3_SSE), Cache-Control no-store, and an
 * SDK-computed SHA-256 checksum that S3 verifies on receipt.
 *
 * Downloads are pre-signed GET URLs valid for DOWNLOAD_URL_TTL_SECONDS that force an attachment with
 * a friendly file name; the key never leaves the server as data.
 *
 *   const store = createS3ObjectStore({ label, maxObjectBytes, StoreError });
 *   store.init(storageConfig)          once at startup; null leaves the area unconfigured
 *   store.isConfigured()
 *   store.upload(readable, key, contentType)        → { sha256, sizeBytes }
 *   store.deleteQuietly(key, requestId)             never throws (logs instead)
 *   store.createDownloadUrl(key, fileName, contentType) → { downloadUrl, expiresAt }
 *   store.close()
 */

import { createHash } from 'node:crypto';
import { Transform } from 'node:stream';
import { DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { logger } from './logger.js';
import { createS3Client } from './s3Client.js';

export const DOWNLOAD_URL_TTL_SECONDS = 60;

export class S3ObjectStoreError extends Error {
  constructor(message, { cause } = {}) {
    super(message, { cause });
    this.name = 'S3ObjectStoreError';
  }
}

/** "attachment" with the file name both as plain ASCII and as UTF-8 (RFC 6266). */
function attachmentDisposition(fileName) {
  const asciiFileName = fileName.replace(/[^\x20-\x7E]|["\\]/g, '_');
  return `attachment; filename="${asciiFileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

/**
 * @param {{ label: string, maxObjectBytes: number, StoreError?: typeof S3ObjectStoreError }} options
 *   `label` names the area in logs and errors ("Payslip"); errors are thrown as `StoreError`.
 */
export function createS3ObjectStore({ label, maxObjectBytes, StoreError = S3ObjectStoreError }) {
  /** @type {{ s3Client: import('@aws-sdk/client-s3').S3Client, bucketName: string, serverSideEncryption: string, kmsKeyId: string|null } | null} */
  let area = null;

  function configured() {
    if (!area) throw new StoreError(`${label} storage is not configured`);
    return area;
  }

  /** Counts and hashes bytes as they pass through; refuses bodies over maxObjectBytes. */
  function createDigestingStream() {
    const sha256 = createHash('sha256');
    let byteCount = 0;
    const digestingStream = new Transform({
      transform(chunk, encoding, callback) {
        byteCount += chunk.length;
        if (byteCount > maxObjectBytes) {
          callback(new StoreError(`${label} file exceeds ${maxObjectBytes} bytes`));
          return;
        }
        sha256.update(chunk);
        callback(null, chunk);
      },
    });
    return { digestingStream, digest: () => ({ sha256: sha256.digest('hex'), sizeBytes: byteCount }) };
  }

  return {
    /** @param {object|null} storageConfig  config/environment.js loadS3StorageConfig(env, '<AREA>') */
    init(storageConfig) {
      if (area) throw new Error(`${label} storage was initialised more than once`);
      if (!storageConfig) return;
      area = {
        s3Client: createS3Client(storageConfig),
        bucketName: storageConfig.bucketName,
        serverSideEncryption: storageConfig.serverSideEncryption,
        kmsKeyId: storageConfig.serverSideEncryption === 'aws:kms' ? storageConfig.kmsKeyId : null,
      };
      logger.info(`${label} storage ready`, {
        bucketName: storageConfig.bucketName,
        serverSideEncryption: storageConfig.serverSideEncryption,
        customEndpoint: Boolean(storageConfig.endpoint),
      });
    },

    isConfigured: () => area !== null,

    serverSideEncryption: () => area?.serverSideEncryption ?? null,

    close() {
      area?.s3Client.destroy();
      area = null;
    },

    /**
     * Pipes `stream` into S3 under `objectKey`.
     * @param {import('node:stream').Readable} stream
     * @returns {Promise<{ sha256: string, sizeBytes: number }>}
     */
    async upload(stream, objectKey, contentType) {
      const { s3Client, bucketName, serverSideEncryption, kmsKeyId } = configured();
      const { digestingStream, digest } = createDigestingStream();
      // A failure of the source stream ends the upload; marked handled so an error after the upload
      // has settled cannot surface as an unhandled rejection (which server.js treats as fatal).
      const sourceFailure = new Promise((resolve, reject) => stream.once('error', reject));
      sourceFailure.catch(() => {});
      stream.pipe(digestingStream);

      const managedUpload = new Upload({
        client: s3Client,
        params: {
          Bucket: bucketName,
          Key: objectKey,
          Body: digestingStream,
          ContentType: contentType,
          CacheControl: 'no-store',
          ChecksumAlgorithm: 'SHA256',
          ServerSideEncryption: serverSideEncryption,
          ...(kmsKeyId && { SSEKMSKeyId: kmsKeyId }),
        },
        queueSize: 1,
        leavePartsOnError: false,
      });

      try {
        await Promise.race([managedUpload.done(), sourceFailure]);
      } catch (uploadError) {
        if (uploadError instanceof StoreError) throw uploadError;
        throw new StoreError(`${label} upload failed: ${uploadError.message}`, { cause: uploadError });
      }
      const { sha256, sizeBytes } = digest();
      if (sizeBytes === 0) throw new StoreError(`${label} file was empty`);
      return { sha256, sizeBytes };
    },

    /** Removes an object, e.g. to undo an upload whose record could not be saved. Never throws. */
    async deleteQuietly(objectKey, requestId) {
      if (!area) return;
      try {
        await area.s3Client.send(new DeleteObjectCommand({ Bucket: area.bucketName, Key: objectKey }));
      } catch (deleteError) {
        logger.error(`${label} object cleanup failed; remove it manually`, {
          requestId,
          objectKey,
          error: deleteError.message,
        });
      }
    },

    /** A DOWNLOAD_URL_TTL_SECONDS pre-signed link that saves the object as `fileName`. */
    async createDownloadUrl(objectKey, fileName, contentType) {
      const { s3Client, bucketName } = configured();
      const signedAtMs = Date.now();
      const downloadUrl = await getSignedUrl(
        s3Client,
        new GetObjectCommand({
          Bucket: bucketName,
          Key: objectKey,
          ResponseContentDisposition: attachmentDisposition(fileName),
          ResponseContentType: contentType,
          ResponseCacheControl: 'no-store',
        }),
        { expiresIn: DOWNLOAD_URL_TTL_SECONDS },
      );
      return { downloadUrl, expiresAt: new Date(signedAtMs + DOWNLOAD_URL_TTL_SECONDS * 1000).toISOString() };
    },
  };
}
