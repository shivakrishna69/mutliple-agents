/**
 * The hourly leave work, started with the server: the leave job's accruals and year ends
 * (services/leaveAccrualJob.js), then the repair of leave requests a stopped server left part-way
 * (services/leaveRequestSettlement.js). Both are idempotent, so running on several servers at once
 * is safe. Failures are logged and the next run tries again.
 */

import { logger } from '../utils/logger.js';
import { runLeaveAccruals } from './leaveAccrualJob.js';
import { repairLeaveRequests } from './leaveRequestSettlement.js';

/** How often it runs. Hourly keeps joiner credits within an hour of the joining date. */
export const LEAVE_JOB_INTERVAL_MS = 60 * 60 * 1000;

let schedulerTimer = null;

async function runStep(name, step, hasNews) {
  try {
    const summary = await step();
    if (hasNews(summary)) logger.info(`${name} made changes`, summary);
  } catch (stepError) {
    logger.error(`${name} failed`, {
      error: { name: stepError.name, message: stepError.message, stack: stepError.stack },
    });
  }
}

async function runLeaveWork() {
  await runStep(
    'Leave job',
    runLeaveAccruals,
    (summary) => summary.accrualsPosted + summary.yearEndMovementsPosted > 0,
  );
  await runStep('Leave request repair', repairLeaveRequests, (summary) =>
    Object.values(summary).some((count) => count > 0),
  );
}

/** Runs now and then every LEAVE_JOB_INTERVAL_MS. */
export function startLeaveScheduler() {
  if (schedulerTimer) return;
  runLeaveWork();
  schedulerTimer = setInterval(runLeaveWork, LEAVE_JOB_INTERVAL_MS);
  schedulerTimer.unref();
}

export function stopLeaveScheduler() {
  clearInterval(schedulerTimer);
  schedulerTimer = null;
}
