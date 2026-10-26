/**
 * The error boundary of every request: HttpError for expected failures, asyncHandler for async
 * routes, the 404 handler, and the final error handler that turns any error into a JSON response.
 */

import mongoose from 'mongoose';
import { log } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Error primitives
// ---------------------------------------------------------------------------

/**
 * An error whose message is safe to show to the client. Route code throws `HttpError`
 * for expected failures (bad input, not found, forbidden); `errorHandler` returns its
 * `statusCode` and `message` as-is. Any other error is treated as an unexpected 500
 * and its message is hidden in production.
 */
export class HttpError extends Error {
  constructor(statusCode, message, details) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.details = details;
  }
}

/**
 * Wraps an async route handler so that a thrown error or rejected promise is passed
 * to `next(err)` and handled by `errorHandler`, instead of leaving the request hanging.
 *
 * Express 5 already forwards rejected promises from handlers; this wrapper keeps the
 * behaviour explicit and also covers handlers mounted through libraries that call
 * them outside Express's own promise handling.
 *
 *   router.get('/items/:id', asyncHandler(async (req, res) => { ... }));
 */
export const asyncHandler = (handler) => (req, res, next) => {
  Promise.resolve()
    .then(() => handler(req, res, next))
    .catch(next);
};

/**
 * Converts known library errors into `HttpError`s with the right status code so that
 * `errorHandler` does not need to know about each library's error shapes.
 */
function normalizeError(err) {
  if (err instanceof HttpError) return err;

  if (err instanceof mongoose.Error.ValidationError) {
    const details = Object.values(err.errors).map((e) => ({ path: e.path, message: e.message }));
    return new HttpError(400, 'Validation failed', details);
  }
  if (err instanceof mongoose.Error.CastError) {
    return new HttpError(400, `Invalid value for "${err.path}"`);
  }
  if (err?.code === 11000) {
    return new HttpError(409, 'Duplicate value', { fields: Object.keys(err.keyValue ?? {}) });
  }
  if (err?.name === 'JsonWebTokenError' || err?.name === 'TokenExpiredError') {
    return new HttpError(401, 'Invalid or expired token');
  }
  if (err?.type === 'entity.parse.failed') {
    return new HttpError(400, 'Malformed JSON body');
  }
  if (err?.type === 'entity.too.large') {
    return new HttpError(413, 'Request body too large');
  }
  return err;
}

/** Turns requests that matched no route into a 404 `HttpError` for `errorHandler`. */
export function notFoundHandler(req, res, next) {
  next(new HttpError(404, `Route not found: ${req.method} ${req.originalUrl}`));
}

/**
 * Final error boundary for every request. It must be registered after all routes and
 * keep four parameters, which is how Express recognises error-handling middleware.
 *
 * Response body shape: `{ error: { message, requestId, details?, stack? } }`.
 * `stack` is included only outside production.
 */
export function createErrorHandler(config) {
  return function errorHandler(err, req, res, next) {
    const normalized = normalizeError(err);
    const isExpected = normalized instanceof HttpError;
    const statusCode = isExpected ? normalized.statusCode : 500;

    log(statusCode >= 500 ? 'error' : 'warn', isExpected ? normalized.message : 'Unhandled error', {
      requestId: req.id,
      method: req.method,
      path: req.originalUrl,
      status: statusCode,
      error: { name: err.name, message: err.message, stack: statusCode >= 500 ? err.stack : undefined },
    });

    if (res.headersSent) {
      // Part of the response is already on the wire; let Express close the connection.
      return next(err);
    }

    const showInternals = config.env !== 'production';
    res.status(statusCode).json({
      error: {
        message: isExpected || showInternals ? normalized.message : 'Internal server error',
        requestId: req.id,
        ...(normalized.details && { details: normalized.details }),
        ...(showInternals && statusCode >= 500 && { stack: err.stack }),
      },
    });
  };
}
