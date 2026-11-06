/**
 * The services' health (GET /api/system/health) for administrators, shared by the top bar's
 * "Systems live" pill and the dashboard's "Connected services" card: one request serves both, and
 * an answer is reused for HEALTH_REUSE_MS. A failed check is forgotten, so the next view asks again.
 */

import { requestSystemHealth } from '../api/dashboardApi.js';
import { useApiResource } from './useApiResource.js';

const HEALTH_REUSE_MS = 60_000;
let sharedCheck = null;

function loadSharedHealth() {
  if (sharedCheck && Date.now() - sharedCheck.atMs < HEALTH_REUSE_MS) return sharedCheck.promise;
  const promise = requestSystemHealth().catch((checkError) => {
    sharedCheck = null;
    throw checkError;
  });
  sharedCheck = { atMs: Date.now(), promise };
  return promise;
}

/** @param {boolean} enabled  false for anyone but administrators (the server refuses them) */
export function useSystemHealth(enabled) {
  return useApiResource(() => loadSharedHealth(), [], { enabled });
}
