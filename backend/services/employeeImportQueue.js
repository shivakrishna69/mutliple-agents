/**
 * Where confirmed employee imports run (services/employeeImportRunner.js):
 *
 *   REDIS_URL set   a BullMQ queue on Redis: any backend instance's worker can take the job, and
 *                   BullMQ retries a job whose worker stopped.
 *   no REDIS_URL    in this process, right after it is confirmed.
 *
 * Either way the job's state is in MongoDB and the runner claims it with a lease, so a job handed
 * out twice still runs once. A sweep every EMPLOYEE_IMPORT_LIMITS.SWEEP_INTERVAL_MS hands out jobs
 * that are waiting (confirmed just before a restart) or whose worker stopped (lease run out), so
 * no import is left behind, with or without Redis.
 */

import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { EMPLOYEE_IMPORT_LIMITS } from '../constants/validation.js';
import EmployeeImportJob, { IMPORT_JOB_STATUSES } from '../models/EmployeeImportJob.js';
import { logger } from '../utils/logger.js';
import { runImportJob } from './employeeImportRunner.js';

const QUEUE_NAME = 'employee-imports';
const JOB_NAME = 'import';

let state = null;

function runInThisProcess(importJobId) {
  setImmediate(() => {
    runImportJob(importJobId, state.runContext).catch((runError) =>
      logger.error('Employee import stopped; the sweep will resume it', {
        importJobId,
        error: { name: runError.name, message: runError.message },
      }),
    );
  });
}

/** Queued jobs, and running ones whose worker stopped, are handed out again. */
async function sweep() {
  try {
    const waitingJobs = await EmployeeImportJob.find({
      $or: [
        { status: IMPORT_JOB_STATUSES.QUEUED },
        { status: IMPORT_JOB_STATUSES.RUNNING, 'lease.until': { $lt: new Date() } },
      ],
    })
      .select('_id')
      .lean();
    for (const waitingJob of waitingJobs) await dispatchImportJob(waitingJob._id.toString());
  } catch (sweepError) {
    logger.error('Employee import sweep failed', { error: { name: sweepError.name, message: sweepError.message } });
  }
}

/**
 * Starts the queue (and, with Redis, this instance's worker) and the sweep.
 * @param {{ redisUrl: string|null, jwtSecret: string, appPublicUrl: string, employeeImport: object }} config
 */
export function initEmployeeImportQueue(config) {
  const workerId = `${hostname()}:${process.pid}:${randomBytes(4).toString('hex')}`;
  state = { runContext: { config, workerId }, queue: null, worker: null, connections: [], sweepTimer: null };

  if (config.redisUrl) {
    // BullMQ blocks on Redis and must retry commands itself, hence maxRetriesPerRequest: null.
    // The worker blocks while it waits for jobs, so it gets a connection of its own.
    const queueConnection = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
    const workerConnection = queueConnection.duplicate();
    state.connections = [queueConnection, workerConnection];
    state.queue = new Queue(QUEUE_NAME, { connection: queueConnection });
    state.worker = new Worker(QUEUE_NAME, (queuedJob) => runImportJob(queuedJob.data.importJobId, state.runContext), {
      connection: workerConnection,
      concurrency: 1,
    });
    state.worker.on('failed', (queuedJob, runError) =>
      logger.error('Employee import stopped; it will be retried', {
        importJobId: queuedJob?.data.importJobId,
        error: { name: runError.name, message: runError.message },
      }),
    );
  }
  state.sweepTimer = setInterval(sweep, EMPLOYEE_IMPORT_LIMITS.SWEEP_INTERVAL_MS);
  state.sweepTimer.unref();
  sweep();
  logger.info('Employee import queue ready', { mode: config.redisUrl ? 'bullmq' : 'in-process' });
}

/** Hands a confirmed (or abandoned) job to a worker. */
export async function dispatchImportJob(importJobId) {
  if (!state) throw new Error('initEmployeeImportQueue must run before imports are dispatched');
  if (!state.queue) {
    runInThisProcess(importJobId);
    return;
  }
  await state.queue.add(
    JOB_NAME,
    { importJobId },
    { attempts: 3, backoff: { type: 'exponential', delay: 5_000 }, removeOnComplete: true, removeOnFail: 100 },
  );
}

export async function closeEmployeeImportQueue() {
  if (!state) return;
  clearInterval(state.sweepTimer);
  await state.worker?.close();
  await state.queue?.close();
  await Promise.all(state.connections.map((connection) => connection.quit()));
  state = null;
}
