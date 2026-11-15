/**
 * Removes expired external knowledge (externalKnowledge.js cleanUpExpired) when the server starts and
 * every WEB_RESEARCH_SETTINGS.CLEANUP_INTERVAL_MS. Idempotent, so several servers may run it; a round
 * that cannot reach the ai-service is logged and the next one tries again (searches skip expired pages
 * meanwhile).
 */

import { WEB_RESEARCH_SETTINGS } from '../../constants/validation.js';
import { createPeriodicJob } from '../periodicJob.js';
import { cleanUpExpired } from './externalKnowledge.js';

let job = null;

/** @param {object} config  the server's configuration (the ai-service address and key) */
export function startExternalKnowledgeCleanup(config) {
  job = createPeriodicJob({
    intervalMs: WEB_RESEARCH_SETTINGS.CLEANUP_INTERVAL_MS,
    steps: [
      {
        name: 'External knowledge cleanup',
        run: () => cleanUpExpired({ config }),
        hasNews: (summary) => summary.removedSources > 0 || summary.removedOrphanChunks > 0,
      },
    ],
  });
  job.start();
}

export function stopExternalKnowledgeCleanup() {
  job?.stop();
  job = null;
}
