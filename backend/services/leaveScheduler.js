/**
 * The hourly leave work, started with the server: the leave job's accruals and year ends
 * (services/leaveAccrualJob.js), then the repair of leave requests a stopped server left part-way
 * (services/leaveRequestSettlement.js). Both are idempotent, so running on several servers at once
 * is safe. Failures are logged and the next run tries again (services/periodicJob.js).
 */

import { runLeaveAccruals } from './leaveAccrualJob.js';
import { repairLeaveRequests } from './leaveRequestSettlement.js';
import { createPeriodicJob } from './periodicJob.js';

/** How often it runs. Hourly keeps joiner credits within an hour of the joining date. */
export const LEAVE_JOB_INTERVAL_MS = 60 * 60 * 1000;

const leaveJob = createPeriodicJob({
  intervalMs: LEAVE_JOB_INTERVAL_MS,
  steps: [
    {
      name: 'Leave job',
      run: runLeaveAccruals,
      hasNews: (summary) => summary.accrualsPosted + summary.yearEndMovementsPosted > 0,
    },
    {
      name: 'Leave request repair',
      run: repairLeaveRequests,
      hasNews: (summary) => Object.values(summary).some((count) => count > 0),
    },
  ],
});

/** Runs now and then every LEAVE_JOB_INTERVAL_MS. */
export const startLeaveScheduler = leaveJob.start;
export const stopLeaveScheduler = leaveJob.stop;
