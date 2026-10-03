/**
 * Fixed-window rate limiting, implemented in-process to avoid adding a dependency.
 *
 * How it works: each key (for example a client IP) gets a counter and the time its window
 * started. Every request increments the counter; once it exceeds `maxRequests` the request is
 * answered with 429 and a Retry-After header until the window ends, when the counter resets.
 *
 * Scope and limits of this implementation:
 *   - Counters live in this process's memory. With several backend instances each keeps its
 *     own counters, so the effective limit is multiplied by the instance count; move the store
 *     to a shared database such as Redis before scaling out horizontally.
 *   - Expired windows are swept on a timer so memory stays proportional to the number of
 *     clients seen in the last window. The timer is unref'd so it never keeps the process alive.
 *   - Client IPs come from `req.ip`, which honours X-Forwarded-For only for the number of
 *     proxies configured in TRUST_PROXY_HOPS; clients cannot spoof it otherwise.
 */

import { HTTP_STATUS } from '../constants/httpStatus.js';
import { RATE_LIMITS } from '../constants/rateLimits.js';
import { RATE_LIMIT_MESSAGES } from '../constants/messages.js';
import { sendError } from '../utils/apiResponse.js';
import { logger } from '../utils/logger.js';

/**
 * Creates a rate-limiting middleware.
 * @param {object} limiterOptions
 * @param {string} limiterOptions.limiterName  Identifies the limiter in logs.
 * @param {number} limiterOptions.windowMs     Length of one counting window.
 * @param {number} limiterOptions.maxRequests  Requests allowed per key per window.
 * @param {(req: import('express').Request) => string} limiterOptions.resolveClientKey
 * @param {string} limiterOptions.limitExceededMessage  From constants/messages.js.
 */
export function createRateLimiter({ limiterName, windowMs, maxRequests, resolveClientKey, limitExceededMessage }) {
  /** clientKey -> { requestCount, windowStartedAtMs } */
  const requestWindowsByClientKey = new Map();

  const expiredWindowSweeper = setInterval(() => {
    const currentTimeMs = Date.now();
    for (const [clientKey, requestWindow] of requestWindowsByClientKey) {
      if (currentTimeMs - requestWindow.windowStartedAtMs >= windowMs) {
        requestWindowsByClientKey.delete(clientKey);
      }
    }
  }, windowMs);
  expiredWindowSweeper.unref();

  return function enforceRateLimit(req, res, next) {
    const clientKey = resolveClientKey(req);
    const currentTimeMs = Date.now();

    let requestWindow = requestWindowsByClientKey.get(clientKey);
    if (!requestWindow || currentTimeMs - requestWindow.windowStartedAtMs >= windowMs) {
      requestWindow = { requestCount: 0, windowStartedAtMs: currentTimeMs };
      requestWindowsByClientKey.set(clientKey, requestWindow);
    }
    requestWindow.requestCount += 1;

    if (requestWindow.requestCount > maxRequests) {
      const retryAfterSeconds = Math.ceil((requestWindow.windowStartedAtMs + windowMs - currentTimeMs) / 1000);
      res.set('Retry-After', String(retryAfterSeconds));
      logger.warn('Rate limit exceeded', { requestId: req.id, limiter: limiterName, retryAfterSeconds });
      return sendError(req, res, HTTP_STATUS.TOO_MANY_REQUESTS, limitExceededMessage);
    }
    return next();
  };
}

/** Client IP as resolved by Express (see TRUST_PROXY_HOPS). */
function resolveClientIp(req) {
  return req.ip ?? 'unknown-ip';
}

/**
 * Client IP plus the normalised email being attempted. The email is lowercased and trimmed
 * the same way the login validator does it, so "A@x.io" and " a@x.io" share one budget.
 * A missing or non-string email gets its own bucket rather than bypassing the limit.
 */
function resolveClientIpAndEmail(req) {
  const attemptedEmail = req.body?.email;
  const normalizedEmail = typeof attemptedEmail === 'string' ? attemptedEmail.trim().toLowerCase() : '<no-email>';
  return `${resolveClientIp(req)}|${normalizedEmail}`;
}

export const loginRateLimitByClientIp = createRateLimiter({
  limiterName: 'login_per_ip',
  ...RATE_LIMITS.LOGIN_PER_CLIENT_IP,
  resolveClientKey: resolveClientIp,
  limitExceededMessage: RATE_LIMIT_MESSAGES.TOO_MANY_LOGIN_ATTEMPTS,
});

export const loginRateLimitByClientIpAndEmail = createRateLimiter({
  limiterName: 'login_per_ip_and_email',
  ...RATE_LIMITS.LOGIN_PER_IP_AND_EMAIL,
  resolveClientKey: resolveClientIpAndEmail,
  limitExceededMessage: RATE_LIMIT_MESSAGES.TOO_MANY_LOGIN_ATTEMPTS,
});

export const signupRateLimitByClientIp = createRateLimiter({
  limiterName: 'signup_per_ip',
  ...RATE_LIMITS.SIGNUP_PER_CLIENT_IP,
  resolveClientKey: resolveClientIp,
  limitExceededMessage: RATE_LIMIT_MESSAGES.TOO_MANY_SIGNUP_ATTEMPTS,
});
