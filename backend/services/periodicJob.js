/**
 * Background work that runs when the server starts and then every `intervalMs`: the leave job
 * (services/leaveScheduler.js) and the attendance job (services/attendanceScheduler.js).
 *
 * Steps run one after another. A failing step is logged and the next one still runs; the next round
 * tries again. Steps must be idempotent, because several servers may run them at the same time.
 * The timer does not keep the process alive.
 */

import { logger } from '../utils/logger.js';

/**
 * @param {{ intervalMs: number, steps: { name: string, run: () => Promise<object>,
 *   hasNews: (summary: object) => boolean }[] }} job  `hasNews` decides whether a summary is logged
 * @returns {{ start: () => void, stop: () => void }}
 */
export function createPeriodicJob({ intervalMs, steps }) {
  let timer = null;

  async function runSteps() {
    for (const { name, run, hasNews } of steps) {
      try {
        const summary = await run();
        if (hasNews(summary)) logger.info(`${name} made changes`, summary);
      } catch (stepError) {
        logger.error(`${name} failed`, {
          error: { name: stepError.name, message: stepError.message, stack: stepError.stack },
        });
      }
    }
  }

  return {
    start() {
      if (timer) return;
      runSteps();
      timer = setInterval(runSteps, intervalMs);
      timer.unref();
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
  };
}
