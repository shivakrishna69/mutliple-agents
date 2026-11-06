/**
 * A background queue whose work survives restarts, shared by the employee import and the knowledge
 * base ingestion:
 *
 *   REDIS_URL set   a BullMQ queue on Redis: any backend instance's worker can take a job, and
 *                   BullMQ retries a job whose run failed.
 *   no REDIS_URL    in this process, right after it is dispatched.
 *
 * Either way the record's state is in MongoDB and the runner claims it with a lease, so a job handed
 * out twice still runs once. Every `sweepIntervalMs` a sweep hands out again the records that are
 * waiting (dispatched just before a restart) or whose worker stopped (lease run out), so nothing is
 * left behind, with or without Redis. Redis must keep every key (maxmemory-policy noeviction), as
 * BullMQ requires.
 *
 *   const queue = createDurableQueue({ queueName, jobName, dataKey, label, sweepIntervalMs,
 *                                      findWaitingIds, runJob, concurrency, attempts, backoffMs });
 *   queue.init({ redisUrl, ... })   starts the queue, this instance's worker (with Redis) and the sweep;
 *                                   the whole config object is given to runJob as context.config
 *   queue.dispatch(recordId)        hands a record to a worker
 *   queue.close()                   stops everything (on shutdown)
 *
 * runJob(recordId, { config, workerId }) does the work; findWaitingIds() lists the record ids the
 * sweep should hand out again.
 */

import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { logger } from '../utils/logger.js';

// Failed BullMQ jobs kept for inspection; the record in MongoDB is the source of truth.
const FAILED_JOBS_KEPT = 100;

const errorSummary = (runError) => ({ name: runError.name, message: runError.message });

/**
 * @param {{ queueName: string, jobName: string, dataKey: string, label: string, sweepIntervalMs: number,
 *   findWaitingIds: () => Promise<string[]>,
 *   runJob: (recordId: string, context: { config: object, workerId: string }) => Promise<void>,
 *   concurrency?: number, attempts?: number, backoffMs?: number }} options
 */
export function createDurableQueue({
  queueName,
  jobName,
  dataKey,
  label,
  sweepIntervalMs,
  findWaitingIds,
  runJob,
  concurrency = 1,
  attempts = 3,
  backoffMs = 5_000,
}) {
  let state = null;

  function runInThisProcess(recordId) {
    setImmediate(() => {
      runJob(recordId, state.runContext).catch((runError) =>
        logger.error(`${label} stopped; the sweep will resume it`, {
          [dataKey]: recordId,
          error: errorSummary(runError),
        }),
      );
    });
  }

  async function dispatch(recordId) {
    if (!state) throw new Error(`The ${label} queue must be started before work is dispatched`);
    if (!state.queue) {
      runInThisProcess(recordId);
      return;
    }
    await state.queue.add(
      jobName,
      { [dataKey]: recordId },
      {
        attempts,
        backoff: { type: 'exponential', delay: backoffMs },
        removeOnComplete: true,
        removeOnFail: FAILED_JOBS_KEPT,
      },
    );
  }

  async function sweep() {
    try {
      for (const recordId of await findWaitingIds()) await dispatch(recordId);
    } catch (sweepError) {
      logger.error(`${label} sweep failed`, { error: errorSummary(sweepError) });
    }
  }

  function init(config) {
    const workerId = `${hostname()}:${process.pid}:${randomBytes(4).toString('hex')}`;
    state = { runContext: { config, workerId }, queue: null, worker: null, connections: [], sweepTimer: null };

    if (config.redisUrl) {
      // BullMQ blocks on Redis and must retry commands itself, hence maxRetriesPerRequest: null.
      // The worker blocks while it waits for jobs, so it gets a connection of its own.
      const queueConnection = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
      const workerConnection = queueConnection.duplicate();
      state.connections = [queueConnection, workerConnection];
      state.queue = new Queue(queueName, { connection: queueConnection });
      state.worker = new Worker(queueName, (queuedJob) => runJob(queuedJob.data[dataKey], state.runContext), {
        connection: workerConnection,
        concurrency,
      });
      state.worker.on('failed', (queuedJob, runError) =>
        logger.error(`${label} stopped; it will be retried`, {
          [dataKey]: queuedJob?.data[dataKey],
          error: errorSummary(runError),
        }),
      );
    }
    state.sweepTimer = setInterval(sweep, sweepIntervalMs);
    state.sweepTimer.unref();
    sweep();
    logger.info(`${label} queue ready`, { mode: config.redisUrl ? 'bullmq' : 'in-process' });
  }

  async function close() {
    if (!state) return;
    clearInterval(state.sweepTimer);
    await state.worker?.close();
    await state.queue?.close();
    await Promise.all(state.connections.map((connection) => connection.quit()));
    state = null;
  }

  return { init, dispatch, close };
}
