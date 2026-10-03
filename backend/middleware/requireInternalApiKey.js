/**
 * Authenticates service-to-service calls from the ai-service (routes/internalRoutes.js).
 *
 * The caller must send X-Internal-Api-Key equal to AI_SERVICE_API_KEY, the same shared secret the
 * backend sends when it calls the ai-service. The comparison is constant-time (HMAC of both values,
 * then timingSafeEqual on equal-length digests), so response timing reveals nothing about the key.
 * These routes carry no user session, so they bypass cookies and CSRF entirely; the key is the only
 * credential, which is why it must stay server-side and never reach a browser.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { HTTP_STATUS } from '../constants/httpStatus.js';
import { REGULARIZATION_MESSAGES } from '../constants/messages.js';
import { sendError } from '../utils/apiResponse.js';
import { logger } from '../utils/logger.js';

export const INTERNAL_API_KEY_HEADER = 'X-Internal-Api-Key';

/** Digest both sides so timingSafeEqual always compares equal-length buffers. */
function digestKey(keyText, comparisonSalt) {
  return createHmac('sha256', comparisonSalt).update(keyText, 'utf8').digest();
}

export function requireInternalApiKey(req, res, next) {
  const expectedApiKey = req.app.locals.config.aiServiceApiKey;
  const presentedApiKey = req.get(INTERNAL_API_KEY_HEADER) ?? '';
  const isAuthentic =
    presentedApiKey.length > 0 && timingSafeEqual(digestKey(presentedApiKey, expectedApiKey), digestKey(expectedApiKey, expectedApiKey));
  if (!isAuthentic) {
    logger.warn('Internal API call rejected: missing or invalid key', { requestId: req.id, path: req.originalUrl, clientIp: req.ip });
    return sendError(req, res, HTTP_STATUS.UNAUTHORIZED, REGULARIZATION_MESSAGES.INTERNAL_KEY_INVALID);
  }
  return next();
}
