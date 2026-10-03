/**
 * Builds the AWS SDK v3 S3 client used by every storage area (document vault, payslips), so
 * connection limits and retry policy are identical everywhere.
 *
 *   - connect / request timeouts: a slow or unreachable S3 cannot hold a request (and its buffer)
 *     open indefinitely; a payslip or a 10 MB upload still finishes well inside the request timeout.
 *   - maxAttempts 3: the SDK retries throttling and transient network errors with backoff.
 *   - credentials are never passed in: the SDK's default provider chain reads them from the
 *     environment, shared config, or the instance / task IAM role.
 */

import { S3Client } from '@aws-sdk/client-s3';

export const S3_CLIENT_SETTINGS = Object.freeze({
  CONNECTION_TIMEOUT_MS: 3_000,
  REQUEST_TIMEOUT_MS: 30_000,
  MAX_ATTEMPTS: 3,
});

/**
 * @param {{ region: string, endpoint: string | null, forcePathStyle: boolean }} storageConfig
 *   One storage area's validated settings (server.js loadS3StorageConfig).
 */
export function createS3Client(storageConfig) {
  return new S3Client({
    region: storageConfig.region,
    ...(storageConfig.endpoint && { endpoint: storageConfig.endpoint }),
    forcePathStyle: storageConfig.forcePathStyle,
    maxAttempts: S3_CLIENT_SETTINGS.MAX_ATTEMPTS,
    requestHandler: {
      connectionTimeout: S3_CLIENT_SETTINGS.CONNECTION_TIMEOUT_MS,
      requestTimeout: S3_CLIENT_SETTINGS.REQUEST_TIMEOUT_MS,
    },
  });
}
