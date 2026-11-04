/**
 * Presence work in the background, started with the server (services/periodicJob.js):
 *   every minute  close presence whose reports stopped without a disconnect (a server that died, a
 *                 frozen tab) and publish those people as offline (services/presence.js)
 *   every hour    write each employee's totals for the day before, and delete detail and totals
 *                 older than the company keeps them (services/presenceActivity.js)
 * Every step is idempotent, so several servers may run them at once.
 */

import { publishPresenceChange } from '../utils/socketManager.js';
import { closeStalePresence, describePresenceChange, PRESENCE_STATUSES } from './presence.js';
import { deleteExpiredPresence, writeDailySummaries } from './presenceActivity.js';
import { createPeriodicJob } from './periodicJob.js';

export const PRESENCE_SWEEP_INTERVAL_MS = 60 * 1000;
export const PRESENCE_DAILY_INTERVAL_MS = 60 * 60 * 1000;

async function closeAndPublishStalePresence() {
  const { closed } = await closeStalePresence();
  for (const { userId, since } of closed) {
    publishPresenceChange(await describePresenceChange(userId, { status: PRESENCE_STATUSES.OFFLINE, since }));
  }
  return { closedCount: closed.length };
}

const sweepJob = createPeriodicJob({
  intervalMs: PRESENCE_SWEEP_INTERVAL_MS,
  steps: [{ name: 'Stale presence', run: closeAndPublishStalePresence, hasNews: (summary) => summary.closedCount > 0 }],
});

const dailyJob = createPeriodicJob({
  intervalMs: PRESENCE_DAILY_INTERVAL_MS,
  steps: [
    { name: 'Presence daily totals', run: () => writeDailySummaries(), hasNews: () => false },
    {
      name: 'Presence retention',
      run: () => deleteExpiredPresence(),
      hasNews: (summary) => summary.intervalsDeleted + summary.summariesDeleted > 0,
    },
  ],
});

export function startPresenceJobs() {
  sweepJob.start();
  dailyJob.start();
}

export function stopPresenceJobs() {
  sweepJob.stop();
  dailyJob.stop();
}
