/**
 * Where offboarding documents are generated (offboardingRunner.js), on the shared durable queue
 * (services/durableQueue.js):
 *
 *   REDIS_URL set   a BullMQ queue on Redis: any backend instance's worker can take the case, and
 *                   BullMQ retries a run that failed.
 *   no REDIS_URL    in this process, right after the case is started.
 *
 * Either way the case's state is in MongoDB and the runner claims it with a lease, so a case handed
 * out twice is still generated once. A sweep every OFFBOARDING_SETTINGS.SWEEP_INTERVAL_MS hands out
 * cases that are queued (started just before a restart, or put back after a failed run) or whose
 * worker stopped (lease run out).
 */

import { OFFBOARDING_SETTINGS } from '../../../constants/validation.js';
import OffboardingCase, { OFFBOARDING_STATUSES } from '../../../models/OffboardingCase.js';
import { createDurableQueue } from '../../durableQueue.js';
import { runOffboardingJob } from './offboardingRunner.js';

async function findWaitingCaseIds() {
  const waiting = await OffboardingCase.find({
    $or: [
      { status: OFFBOARDING_STATUSES.QUEUED },
      { status: OFFBOARDING_STATUSES.GENERATING, 'lease.until': { $lt: new Date() } },
    ],
  })
    .select('_id')
    .lean();
  return waiting.map((offboardingCase) => offboardingCase._id.toString());
}

const offboardingQueue = createDurableQueue({
  queueName: 'offboarding-documents',
  jobName: 'generate',
  dataKey: 'offboardingCaseId',
  label: 'Offboarding documents',
  sweepIntervalMs: OFFBOARDING_SETTINGS.SWEEP_INTERVAL_MS,
  findWaitingIds: findWaitingCaseIds,
  runJob: runOffboardingJob,
  attempts: OFFBOARDING_SETTINGS.MAX_ATTEMPTS,
});

/** Starts the queue (and, with Redis, this instance's worker) and the sweep. */
export const initOffboardingQueue = offboardingQueue.init;

/** Hands a started case to a worker. */
export const dispatchOffboardingJob = offboardingQueue.dispatch;

export const closeOffboardingQueue = offboardingQueue.close;
