/**
 * Authenticates inbound webhooks with an HMAC-SHA256 signature.
 *
 * The sender and this backend share WEBHOOK_SIGNING_SECRET. For every request the sender sends:
 *   X-Webhook-Timestamp:  current Unix time in whole seconds, e.g. 1790000000
 *   X-Webhook-Signature:  "sha256=" + hex(HMAC_SHA256(secret, `${timestamp}.${rawBody}`))
 * where rawBody is the exact request body bytes.
 *
 * Why each part exists:
 *   - The HMAC proves the request came from a holder of the secret and that neither the body
 *     nor the timestamp was altered in transit.
 *   - Signing the raw bytes (captured by express.json's `verify` hook in server.js) avoids
 *     false mismatches from JSON re-serialisation (key order, whitespace, unicode escapes).
 *   - The timestamp is inside the signed string, so it cannot be changed, and requests outside
 *     the tolerance window are rejected. That bounds replay of a captured request; replays
 *     inside the window are absorbed by eventId de-duplication in the controller.
 *   - The comparison is constant-time, so response timing does not reveal how much of a forged
 *     signature was correct.
 *
 * Every failure is a 401 with a specific message, and is logged without the signature value.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { HTTP_STATUS } from '../constants/httpStatus.js';
import { WEBHOOK_MESSAGES } from '../constants/messages.js';
import { WEBHOOK_FIELD_LIMITS } from '../constants/validation.js';
import { sendError } from '../utils/apiResponse.js';
import { logger } from '../utils/logger.js';

export const WEBHOOK_TIMESTAMP_HEADER = 'x-webhook-timestamp';
export const WEBHOOK_SIGNATURE_HEADER = 'x-webhook-signature';

/** Unix seconds: 1 to 12 digits, no sign, no decimals. */
const UNIX_SECONDS_PATTERN = /^\d{1,12}$/;

/** "sha256=" followed by exactly 64 lowercase or uppercase hex characters. */
const SIGNATURE_HEADER_PATTERN = /^sha256=([a-fA-F0-9]{64})$/;

/**
 * Computes the signature for a timestamp and raw body. Exported so tests and trusted internal
 * senders produce signatures with exactly the same construction.
 * @param {string} signingSecret
 * @param {string} timestampSeconds
 * @param {Buffer} rawBodyBuffer
 * @returns {string} lowercase hex digest
 */
export function computeWebhookSignature(signingSecret, timestampSeconds, rawBodyBuffer) {
  return createHmac('sha256', signingSecret).update(`${timestampSeconds}.`, 'utf8').update(rawBodyBuffer).digest('hex');
}

function rejectWebhook(req, res, rejectionReason, clientMessage) {
  logger.warn('Webhook rejected', { requestId: req.id, reason: rejectionReason, path: req.originalUrl });
  return sendError(req, res, HTTP_STATUS.UNAUTHORIZED, clientMessage);
}

/** Express middleware: lets the request through only if its signature verifies. */
export function verifyWebhookSignature(req, res, next) {
  const timestampHeader = req.get(WEBHOOK_TIMESTAMP_HEADER);
  const signatureHeader = req.get(WEBHOOK_SIGNATURE_HEADER);

  if (!timestampHeader || !signatureHeader) {
    return rejectWebhook(req, res, 'signature_missing', WEBHOOK_MESSAGES.SIGNATURE_MISSING);
  }

  const signatureMatch = SIGNATURE_HEADER_PATTERN.exec(signatureHeader);
  if (!UNIX_SECONDS_PATTERN.test(timestampHeader) || !signatureMatch) {
    return rejectWebhook(req, res, 'signature_malformed', WEBHOOK_MESSAGES.SIGNATURE_MALFORMED);
  }

  const currentTimeSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(currentTimeSeconds - Number(timestampHeader)) > WEBHOOK_FIELD_LIMITS.SIGNATURE_TOLERANCE_SECONDS) {
    return rejectWebhook(req, res, 'timestamp_out_of_window', WEBHOOK_MESSAGES.SIGNATURE_EXPIRED);
  }

  // No JSON body (or a non-JSON content type) leaves rawBody unset; sign over zero bytes then,
  // which only verifies if the sender also signed an empty body.
  const rawBodyBuffer = Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.alloc(0);
  const expectedSignatureHex = computeWebhookSignature(
    req.app.locals.config.webhookSigningSecret,
    timestampHeader,
    rawBodyBuffer,
  );

  const presentedSignatureBuffer = Buffer.from(signatureMatch[1].toLowerCase(), 'hex');
  const expectedSignatureBuffer = Buffer.from(expectedSignatureHex, 'hex');
  if (!timingSafeEqual(presentedSignatureBuffer, expectedSignatureBuffer)) {
    return rejectWebhook(req, res, 'signature_mismatch', WEBHOOK_MESSAGES.SIGNATURE_INVALID);
  }

  return next();
}
