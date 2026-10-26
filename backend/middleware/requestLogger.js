/**
 * Request ids and one structured log line per completed request.
 */

import { randomUUID } from 'node:crypto';
import { log } from '../utils/logger.js';

/**
 * Assigns each request an id (reusing an incoming `X-Request-Id` from a proxy when present),
 * echoes it in the response header, and logs one line when the response finishes.
 * The same id appears in error logs, so a single request can be traced end to end.
 */
export function requestLogger(req, res, next) {
  const startedAt = process.hrtime.bigint();
  req.id = req.get('x-request-id') ?? randomUUID();
  res.setHeader('X-Request-Id', req.id);

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    log(level, 'request completed', {
      requestId: req.id,
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      durationMs: Math.round(durationMs * 100) / 100,
    });
  });

  next();
}
