/**
 * The attendance work, started with the server: closing punches still open after the shift
 * (services/attendancePunchOut.js). Idempotent, so several servers may run it at once
 * (services/periodicJob.js).
 */

import { closeForgottenPunchOuts } from './attendancePunchOut.js';
import { createPeriodicJob } from './periodicJob.js';

/** How often it runs: a forgotten punch-out is closed at most this long after its deadline. */
export const ATTENDANCE_JOB_INTERVAL_MS = 15 * 60 * 1000;

const attendanceJob = createPeriodicJob({
  intervalMs: ATTENDANCE_JOB_INTERVAL_MS,
  steps: [
    {
      name: 'Automatic punch-out',
      run: () => closeForgottenPunchOuts(),
      hasNews: (summary) => summary.closedCount > 0,
    },
  ],
});

/** Runs now and then every ATTENDANCE_JOB_INTERVAL_MS. */
export const startAttendanceScheduler = attendanceJob.start;
export const stopAttendanceScheduler = attendanceJob.stop;
