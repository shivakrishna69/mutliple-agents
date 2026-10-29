/**
 * Backend entry point.
 *
 * Boot sequence (see `start()` at the bottom of this file):
 *   1. Load and validate environment variables  -> fail fast on misconfiguration (config/environment.js).
 *   2. Connect to MongoDB through Mongoose      -> the server does not accept traffic without a database.
 *      Then connect the cache (services/cacheStore.js): Redis when REDIS_URL is set, else in-memory.
 *   3. Build the Express app (`createApp`)      -> middleware, routes, 404 handler, error handler, in that order.
 *   4. Wrap it in a Node HTTP server and attach Socket.IO (utils/socketManager.js), so REST and
 *      real-time traffic share one port.
 *   5. Start listening and register shutdown    -> SIGINT/SIGTERM close sockets and HTTP first, then the cache and MongoDB.
 *
 * Error boundaries, from innermost to outermost:
 *   - `asyncHandler` wraps a route handler so a thrown error or rejected promise reaches `next(err)`.
 *   - `errorHandler` is the single place that turns an error into an HTTP response and a log line
 *     (`asyncHandler`, `HttpError` and the handlers live in middleware/errorHandling.js).
 *   - `process.on('unhandledRejection' | 'uncaughtException')` logs anything that escaped Express
 *     and exits, so the process manager restarts a process whose state can no longer be trusted.
 *
 * Logging: every log line is one JSON object on stdout/stderr (`ts`, `level`, `msg`, plus context),
 * so log collectors can parse and filter it without regexes.
 */

import 'dotenv/config';
import http from 'node:http';
import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
// Imported after 'dotenv/config' so the logger sees LOG_LEVEL from .env.
import { logger } from './utils/logger.js';
import authRoutes from './routes/authRoutes.js';
import webhookRoutes from './routes/webhookRoutes.js';
import conversationRoutes from './routes/conversationRoutes.js';
import supportRoutes from './routes/supportRoutes.js';
import adminRoutes from './routes/adminRoutes.js';
import orgRoutes from './routes/orgRoutes.js';
import vaultRoutes from './routes/vaultRoutes.js';
import attendanceRoutes from './routes/attendanceRoutes.js';
import internalRoutes from './routes/internalRoutes.js';
import payrollRoutes from './routes/payrollRoutes.js';
import peopleRoutes from './routes/peopleRoutes.js';
import invitationRoutes from './routes/invitationRoutes.js';
import analyticsRoutes from './routes/analyticsRoutes.js';
import okrRoutes from './routes/okrRoutes.js';
import workCalendarRoutes from './routes/workCalendarRoutes.js';
import officeRoutes from './routes/officeRoutes.js';
import employeeRoutes from './routes/employeeRoutes.js';
import leaveRoutes from './routes/leaveRoutes.js';
import { closeVaultStorage, initVaultStorage } from './services/vaultStorage.js';
import { closePayslipServices, initPayslipServices } from './services/payslipService.js';
import { closeMailService, initMailService } from './services/mailService.js';
import { closeCacheStore, initCacheStore } from './services/cacheStore.js';
import { startLeaveScheduler, stopLeaveScheduler } from './services/leaveScheduler.js';
import { ensureBootstrapAdmin } from './services/bootstrapAdmin.js';
import { runStartupMigrations } from './migrations/index.js';
import { loadConfig } from './config/environment.js';
import { asyncHandler, createErrorHandler, notFoundHandler } from './middleware/errorHandling.js';
import { requestLogger } from './middleware/requestLogger.js';
import { closeSocketServer, initSocketServer } from './utils/socketManager.js';

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
  // Payroll: income tax under both regimes, EPF, ESI, professional tax (FY 2026-27)
  app.use('/api/payroll', payrollRoutes);
  app.use('/api/people', peopleRoutes);
  app.use('/api/invitations', invitationRoutes);
  // Workforce analytics: attrition and burnout risk (HR and admins)
  app.use('/api/analytics', analyticsRoutes);
  // OKRs: company goals, team objectives, key results, milestones
  app.use('/api/okrs', okrRoutes);
  // Holidays and day classification per office (HR edits, employees read).
  app.use('/api/work-calendar', workCalendarRoutes);
  // Offices (with their weekly offs) and employee records, managed by HR.
  app.use('/api/offices', officeRoutes);
  app.use('/api/employees', employeeRoutes);
  // Leave settings, types, balances, ledger, HR movements and the leave job.
  app.use('/api/leave', leaveRoutes);

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
  // Unique indexes enforce rules (one office per code, one request per half day of leave...), so
  // they must exist before the first request is served, not be built in the background after it.
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
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
    await runStartupMigrations();
    await ensureBootstrapAdmin(config.bootstrapAdminEmail);
    await initCacheStore(config);
    initVaultStorage(config.vaultStorage);
    initPayslipServices(config.payslips);
    initMailService(config.mail);
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
    // Accruals, year ends and leave request repair, now and hourly (idempotent, so several
    // instances may run it).
    startLeaveScheduler();
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
      stopLeaveScheduler();
      await closeSocketServer();
      await closeCacheStore();
      closeVaultStorage();
      await closePayslipServices();
      closeMailService();
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
