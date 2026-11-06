/**
 * Where confirmed employee imports run (services/employeeImportRunner.js), on the shared durable
 * queue (services/durableQueue.js):
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

import { EMPLOYEE_IMPORT_LIMITS } from '../constants/validation.js';
import EmployeeImportJob, { IMPORT_JOB_STATUSES } from '../models/EmployeeImportJob.js';
import { createDurableQueue } from './durableQueue.js';
import { runImportJob } from './employeeImportRunner.js';

/** Queued jobs, and running ones whose worker stopped. */
async function findWaitingImportJobIds() {
  const waitingJobs = await EmployeeImportJob.find({
    $or: [
      { status: IMPORT_JOB_STATUSES.QUEUED },
      { status: IMPORT_JOB_STATUSES.RUNNING, 'lease.until': { $lt: new Date() } },
    ],
  })
    .select('_id')
    .lean();
  return waitingJobs.map((waitingJob) => waitingJob._id.toString());
}

const importQueue = createDurableQueue({
  queueName: 'employee-imports',
  jobName: 'import',
  dataKey: 'importJobId',
  label: 'Employee import',
  sweepIntervalMs: EMPLOYEE_IMPORT_LIMITS.SWEEP_INTERVAL_MS,
  findWaitingIds: findWaitingImportJobIds,
  runJob: runImportJob,
});

/**
 * Starts the queue (and, with Redis, this instance's worker) and the sweep.
 * @param {{ redisUrl: string|null, jwtSecret: string, appPublicUrl: string, employeeImport: object }} config
 */
export const initEmployeeImportQueue = importQueue.init;

/** Hands a confirmed (or abandoned) job to a worker. */
export const dispatchImportJob = importQueue.dispatch;

export const closeEmployeeImportQueue = importQueue.close;
