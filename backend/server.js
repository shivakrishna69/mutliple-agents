/**
 * Backend entry point.
 *
 * Boot sequence (see `start()` at the bottom of this file):
 *   1. Load and validate environment variables  -> fail fast on misconfiguration.
 *   2. Connect to MongoDB through Mongoose      -> the server does not accept traffic without a database.
 *      Then connect the cache (services/cacheStore.js): Redis when REDIS_URL is set, else in-memory.
 *   3. Build the Express app (`createApp`)      -> middleware, routes, 404 handler, error handler, in that order.
 *   4. Wrap it in a Node HTTP server and attach Socket.IO (utils/socketManager.js), so REST and
 *      real-time traffic share one port.
 *   5. Start listening and register shutdown    -> SIGINT/SIGTERM close sockets and HTTP first, then the cache and MongoDB.
 *
 * Error boundaries, from innermost to outermost:
 *   - `asyncHandler` wraps a route handler so a thrown error or rejected promise reaches `next(err)`.
 *   - `errorHandler` is the single place that turns an error into an HTTP response and a log line.
 *   - `process.on('unhandledRejection' | 'uncaughtException')` logs anything that escaped Express
 *     and exits, so the process manager restarts a process whose state can no longer be trusted.
 *
 * Logging: every log line is one JSON object on stdout/stderr (`ts`, `level`, `msg`, plus context),
 * so log collectors can parse and filter it without regexes.
 */

import 'dotenv/config';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
// Imported after 'dotenv/config' so the logger sees LOG_LEVEL from .env.
import { log, logger } from './utils/logger.js';
import authRoutes from './routes/authRoutes.js';
import webhookRoutes from './routes/webhookRoutes.js';
import conversationRoutes from './routes/conversationRoutes.js';
import supportRoutes from './routes/supportRoutes.js';
import adminRoutes from './routes/adminRoutes.js';
import orgRoutes from './routes/orgRoutes.js';
import vaultRoutes from './routes/vaultRoutes.js';
import attendanceRoutes from './routes/attendanceRoutes.js';
import internalRoutes from './routes/internalRoutes.js';
import { closeVaultStorage, initVaultStorage } from './services/vaultStorage.js';
import { closeCacheStore, initCacheStore } from './services/cacheStore.js';
import { ensureBootstrapAdmin } from './services/bootstrapAdmin.js';
import { EMAIL_PATTERN } from './constants/validation.js';
import { closeSocketServer, initSocketServer } from './utils/socketManager.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Minimum length for every HMAC secret (JWT, webhook signing, internal AI-service key).
 * HMAC-SHA256 needs a key at least as long as its 256-bit output; shorter secrets can be
 * brute-forced offline from a single signed value.
 */
const MIN_SECRET_LENGTH = 32;

/** Bounds for AI_SERVICE_TIMEOUT_MS: long enough for an LLM round trip, short enough not to hang webhooks. */
const AI_SERVICE_TIMEOUT_BOUNDS_MS = Object.freeze({ MIN: 1_000, MAX: 120_000, DEFAULT: 20_000 });

/**
 * S3 bucket naming rules (3-63 characters, lowercase letters, digits, dots and hyphens, starting and
 * ending with a letter or digit).
 */
const S3_BUCKET_NAME_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
// e.g. ap-south-1, us-east-1, us-gov-west-1
const AWS_REGION_PATTERN = /^[a-z]{2}(?:-[a-z]+)+-\d+$/;

/**
 * Reads the document vault's storage settings (services/vaultStorage.js). Returns null when
 * VAULT_S3_BUCKET is unset, which disables the vault: its routes then answer 503 and the rest of
 * the backend runs normally. When a bucket is set, every related value is validated and a
 * misconfiguration stops startup. AWS credentials are deliberately not read here; the SDK's
 * default provider chain supplies them (IAM role in production).
 */
function loadVaultStorageConfig(env) {
  const bucketName = process.env.VAULT_S3_BUCKET ? process.env.VAULT_S3_BUCKET.trim() : '';
  if (!bucketName) return null;
  if (!S3_BUCKET_NAME_PATTERN.test(bucketName) || bucketName.includes('..')) {
    throw new Error('VAULT_S3_BUCKET is not a valid S3 bucket name');
  }

  const region = (process.env.AWS_REGION ?? '').trim();
  if (!AWS_REGION_PATTERN.test(region)) {
    throw new Error("AWS_REGION must be set to the vault bucket's region (e.g. ap-south-1) when VAULT_S3_BUCKET is set");
  }

  const serverSideEncryption = (process.env.VAULT_S3_SSE ?? 'aws:kms').trim();
  if (!['aws:kms', 'AES256'].includes(serverSideEncryption)) {
    throw new Error('VAULT_S3_SSE must be "aws:kms" or "AES256"');
  }
  const kmsKeyId = process.env.VAULT_S3_KMS_KEY_ID ? process.env.VAULT_S3_KMS_KEY_ID.trim() : null;
  if (kmsKeyId && serverSideEncryption !== 'aws:kms') {
    throw new Error('VAULT_S3_KMS_KEY_ID can only be used with VAULT_S3_SSE=aws:kms');
  }

  // Optional endpoint for S3-compatible stores. Production traffic must stay on TLS.
  const rawEndpoint = process.env.VAULT_S3_ENDPOINT ? process.env.VAULT_S3_ENDPOINT.trim() : null;
  let endpoint = null;
  if (rawEndpoint) {
    let parsedEndpoint;
    try {
      parsedEndpoint = new URL(rawEndpoint);
    } catch {
      throw new Error('VAULT_S3_ENDPOINT must be an absolute URL');
    }
    if (!['http:', 'https:'].includes(parsedEndpoint.protocol)) throw new Error('VAULT_S3_ENDPOINT must use http or https');
    if (env === 'production' && parsedEndpoint.protocol !== 'https:') throw new Error('VAULT_S3_ENDPOINT must use https in production');
    endpoint = parsedEndpoint.origin;
  }

  const forcePathStyleSetting = process.env.VAULT_S3_FORCE_PATH_STYLE;
  if (forcePathStyleSetting !== undefined && forcePathStyleSetting !== '' && !['true', 'false'].includes(forcePathStyleSetting)) {
    throw new Error('VAULT_S3_FORCE_PATH_STYLE must be "true" or "false"');
  }

  return { bucketName, region, serverSideEncryption, kmsKeyId, endpoint, forcePathStyle: forcePathStyleSetting === 'true' };
}

/**
 * Reads configuration from the environment and throws if a required value is missing.
 * Every other module receives this object rather than reading `process.env` directly,
 * so the full set of settings the backend depends on is visible in one place.
 * `createApp` exposes it to request handlers as `req.app.locals.config`.
 */
function loadConfig() {
  const required = ['MONGO_URI', 'JWT_SECRET', 'WEBHOOK_SIGNING_SECRET', 'AI_SERVICE_API_KEY'];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
  for (const secretName of ['JWT_SECRET', 'WEBHOOK_SIGNING_SECRET', 'AI_SERVICE_API_KEY']) {
    if (process.env[secretName].length < MIN_SECRET_LENGTH) {
      throw new Error(`${secretName} must be at least ${MIN_SECRET_LENGTH} characters`);
    }
  }
  if (new Set([process.env.JWT_SECRET, process.env.WEBHOOK_SIGNING_SECRET, process.env.AI_SERVICE_API_KEY]).size !== 3) {
    // Reusing one secret would let a leak in one integration forge credentials for the others.
    throw new Error('JWT_SECRET, WEBHOOK_SIGNING_SECRET and AI_SERVICE_API_KEY must all be different');
  }

  const aiServiceUrl = process.env.AI_SERVICE_URL ?? 'http://localhost:8000';
  let parsedAiServiceUrl;
  try {
    parsedAiServiceUrl = new URL(aiServiceUrl);
  } catch {
    throw new Error('AI_SERVICE_URL must be an absolute URL');
  }
  if (!['http:', 'https:'].includes(parsedAiServiceUrl.protocol)) {
    throw new Error('AI_SERVICE_URL must use http or https');
  }

  const aiServiceTimeoutMs = Number(process.env.AI_SERVICE_TIMEOUT_MS ?? AI_SERVICE_TIMEOUT_BOUNDS_MS.DEFAULT);
  if (
    !Number.isInteger(aiServiceTimeoutMs) ||
    aiServiceTimeoutMs < AI_SERVICE_TIMEOUT_BOUNDS_MS.MIN ||
    aiServiceTimeoutMs > AI_SERVICE_TIMEOUT_BOUNDS_MS.MAX
  ) {
    throw new Error(
      `AI_SERVICE_TIMEOUT_MS must be an integer between ${AI_SERVICE_TIMEOUT_BOUNDS_MS.MIN} and ${AI_SERVICE_TIMEOUT_BOUNDS_MS.MAX}`,
    );
  }

  const env = process.env.NODE_ENV ?? 'development';

  // Secure cookies are only sent over HTTPS. Defaults to on in production, off elsewhere so the
  // http:// dev server works in every browser; turning it off in production is refused outright.
  const cookieSecureSetting = process.env.COOKIE_SECURE;
  if (cookieSecureSetting !== undefined && !['true', 'false'].includes(cookieSecureSetting)) {
    throw new Error('COOKIE_SECURE must be "true" or "false"');
  }
  const cookieSecure = cookieSecureSetting === undefined ? env === 'production' : cookieSecureSetting === 'true';
  if (env === 'production' && !cookieSecure) {
    throw new Error('COOKIE_SECURE cannot be "false" in production');
  }

  // Number of reverse proxies in front of the app. Express uses it to take the client IP from
  // X-Forwarded-For; 0 ignores that header, so clients cannot spoof their IP to dodge rate limits.
  const trustProxyHops = Number(process.env.TRUST_PROXY_HOPS ?? 0);
  if (!Number.isInteger(trustProxyHops) || trustProxyHops < 0) {
    throw new Error('TRUST_PROXY_HOPS must be a non-negative integer');
  }

  // Optional. The account that becomes the first administrator (see services/bootstrapAdmin.js).
  const bootstrapAdminEmail = process.env.BOOTSTRAP_ADMIN_EMAIL ? process.env.BOOTSTRAP_ADMIN_EMAIL.trim().toLowerCase() : null;
  if (bootstrapAdminEmail && !EMAIL_PATTERN.test(bootstrapAdminEmail)) {
    throw new Error('BOOTSTRAP_ADMIN_EMAIL must be a valid email address');
  }

  // Optional. When set, Socket.IO rooms are shared across instances through Redis.
  const redisUrl = process.env.REDIS_URL ? process.env.REDIS_URL.trim() : null;
  if (redisUrl) {
    let parsedRedisUrl;
    try {
      parsedRedisUrl = new URL(redisUrl);
    } catch {
      throw new Error('REDIS_URL must be an absolute URL, e.g. redis://localhost:6379');
    }
    if (!['redis:', 'rediss:'].includes(parsedRedisUrl.protocol)) {
      throw new Error('REDIS_URL must use the redis:// or rediss:// (TLS) scheme');
    }
  }

  // Optional. Employee document vault storage; null disables the vault.
  const vaultStorage = loadVaultStorageConfig(env);

  return {
    env,
    cookieSecure,
    redisUrl,
    vaultStorage,
    bootstrapAdminEmail,
    trustProxyHops,
    port: Number(process.env.PORT ?? 5000),
    mongoUri: process.env.MONGO_URI,
    jwtSecret: process.env.JWT_SECRET,
    jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '1d',
    corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:5173')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    aiServiceUrl: parsedAiServiceUrl.origin,
    aiServiceTimeoutMs,
    aiServiceApiKey: process.env.AI_SERVICE_API_KEY,
    webhookSigningSecret: process.env.WEBHOOK_SIGNING_SECRET,
  };
}

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

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/**
 * Assigns each request an id (reusing an incoming `X-Request-Id` from a proxy when present),
 * echoes it in the response header, and logs one line when the response finishes.
 * The same id appears in error logs, so a single request can be traced end to end.
 */
function requestLogger(req, res, next) {
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

/** Turns requests that matched no route into a 404 `HttpError` for `errorHandler`. */
function notFoundHandler(req, res, next) {
  next(new HttpError(404, `Route not found: ${req.method} ${req.originalUrl}`));
}

/**
 * Final error boundary for every request. It must be registered after all routes and
 * keep four parameters, which is how Express recognises error-handling middleware.
 *
 * Response body shape: `{ error: { message, requestId, details?, stack? } }`.
 * `stack` is included only outside production.
 */
function createErrorHandler(config) {
  // eslint-disable-next-line no-unused-vars
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

// ---------------------------------------------------------------------------
// Application
// ---------------------------------------------------------------------------

/**
 * Builds the Express app without starting a listener, so tests can mount it with
 * supertest. Middleware order matters: request logging first (so every request is
 * timed), then CORS and body parsing, then routes, then 404, then the error handler.
 */
export function createApp(config) {
  const app = express();

  // Controllers and middleware read settings (JWT secret, expiry) from here instead of process.env.
  app.locals.config = config;
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxyHops);
  app.use(requestLogger);
  app.use(
    cors({
      origin: config.corsOrigins,
      credentials: true,
      exposedHeaders: ['X-Request-Id'],
    }),
  );
  app.use(
    express.json({
      limit: '1mb',
      // Keep the exact bytes received: webhook signatures are computed over the raw body,
      // and re-serialising the parsed JSON would not reproduce them byte for byte.
      verify: (req, res, rawBodyBuffer) => {
        req.rawBody = rawBodyBuffer;
      },
    }),
  );
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));

  /**
   * Liveness and readiness probe. Returns 200 only when MongoDB is connected
   * (readyState 1), so a load balancer stops routing traffic to an instance
   * that has lost its database.
   */
  app.get(
    '/api/health',
    asyncHandler(async (req, res) => {
      const dbConnected = mongoose.connection.readyState === 1;
      res.status(dbConnected ? 200 : 503).json({
        status: dbConnected ? 'ok' : 'degraded',
        service: 'backend',
        database: dbConnected ? 'connected' : 'disconnected',
        uptimeSeconds: Math.round(process.uptime()),
      });
    }),
  );

  // POST /api/auth/signup, POST /api/auth/login, GET /api/auth/me, POST /api/auth/logout
  app.use('/api/auth', authRoutes);
  // POST /api/webhooks/incoming
  app.use('/api/webhooks', webhookRoutes);
  // Conversation list, history, and staff actions (claim, release, reply)
  app.use('/api/conversations', conversationRoutes);
  // Customer web chat: send a message into the AI support pipeline
  app.use('/api/support', supportRoutes);
  // User administration (admins only)
  app.use('/api/admin', adminRoutes);
  // Organisation chart: full hierarchy and per-manager reports (staff only, Redis-cached)
  app.use('/api/org', orgRoutes);
  // Employee document vault: upload, list, 60-second pre-signed downloads, verification
  app.use('/api/vault', vaultRoutes);
  // Attendance: geofenced punch-in for the signed-in employee
  app.use('/api/attendance', attendanceRoutes);
  // Service-to-service API for the ai-service (X-Internal-Api-Key); not for browsers
  app.use('/api/internal', internalRoutes);

  app.use(notFoundHandler);
  app.use(createErrorHandler(config));

  return app;
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

/**
 * Opens the Mongoose connection and logs connection state changes after startup,
 * so a later disconnect or reconnect is visible in the logs.
 */
async function connectDatabase(uri) {
  mongoose.set('strictQuery', true);

  mongoose.connection.on('disconnected', () => logger.warn('MongoDB disconnected'));
  mongoose.connection.on('reconnected', () => logger.info('MongoDB reconnected'));
  mongoose.connection.on('error', (err) => logger.error('MongoDB connection error', { error: err.message }));

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000 });
  logger.info('MongoDB connected', { host: mongoose.connection.host, db: mongoose.connection.name });
}

// ---------------------------------------------------------------------------
// Process entry point
// ---------------------------------------------------------------------------

/**
 * Starts the backend. Any failure during boot (bad config, unreachable database)
 * is logged and exits with code 1, so the failure is visible to the process manager
 * instead of leaving a half-started server running.
 */
async function start() {
  let config;
  try {
    config = loadConfig();
    await connectDatabase(config.mongoUri);
    await ensureBootstrapAdmin(config.bootstrapAdminEmail);
    await initCacheStore(config);
    initVaultStorage(config.vaultStorage);
  } catch (err) {
    logger.error('Startup failed', { error: err.message, stack: err.stack });
    process.exit(1);
  }

  const app = createApp(config);

  // One HTTP server carries both Express and Socket.IO, so they share the port, TLS termination,
  // and proxy configuration. Socket.IO must be attached before listen() so no early upgrade
  // request reaches the server without a handler.
  const httpServer = http.createServer(app);
  try {
    await initSocketServer(httpServer, config);
  } catch (socketInitError) {
    logger.error('Startup failed', { error: socketInitError.message, stack: socketInitError.stack });
    await closeCacheStore();
    await mongoose.connection.close();
    process.exit(1);
  }

  httpServer.on('error', (serverError) => {
    logger.error('HTTP server error', { error: serverError.message, code: serverError.code });
    process.exit(1);
  });
  httpServer.listen(config.port, () => {
    logger.info('HTTP server listening', { port: config.port, env: config.env });
  });

  /**
   * Graceful shutdown: disconnect sockets and stop accepting connections (closeSocketServer
   * also closes the HTTP server and waits for in-flight requests), then close the cache and MongoDB.
   * A 10-second timer forces exit if something hangs.
   */
  let isShuttingDown = false;
  const shutdown = async (signal) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info('Shutdown signal received', { signal });
    const forceExit = setTimeout(() => {
      logger.error('Graceful shutdown timed out; forcing exit');
      process.exit(1);
    }, 10_000);
    forceExit.unref();

    try {
      await closeSocketServer();
      await closeCacheStore();
      closeVaultStorage();
      await mongoose.connection.close();
      logger.info('Shutdown complete');
      process.exit(0);
    } catch (shutdownError) {
      logger.error('Shutdown failed', { error: shutdownError.message, stack: shutdownError.stack });
      process.exit(1);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// Last-resort boundary for errors that escaped every request and startup handler.
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', {
    error: reason instanceof Error ? { message: reason.message, stack: reason.stack } : reason,
  });
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { error: { message: err.message, stack: err.stack } });
  process.exit(1);
});

start();
