/**
 * Cache keys and invalidation for the org hierarchy snapshot (services/orgHierarchyService.js).
 * Kept separate from the service so the models can trigger invalidation without importing the
 * service (which imports the models), avoiding a circular import.
 *
 * Generation scheme (why invalidation cannot be lost to a race)
 * ---------------------------------------------------------------
 *   org:hierarchy:generation          integer, incremented on every invalidation, never expires
 *   org:hierarchy:snapshot:v<S>:g<G>  the snapshot built while the generation was G
 *
 *   Reader:   read G, then read snapshot g<G>.
 *   Rebuild:  read G *before* querying MongoDB, then store the result under g<G>.
 *   Writer:   after changing an employee, increment G.
 *
 *   If a write lands while a rebuild is running, the rebuild still stores its (now stale) result
 *   under the old generation, which no reader asks for any more; it simply expires. Deleting a
 *   single fixed key instead would race: the slow rebuild could write stale data back after the
 *   delete and serve it for a whole TTL.
 *
 *   <S> is SNAPSHOT_SCHEMA_VERSION: bump it whenever the snapshot's shape changes, so a deploy
 *   never reads a snapshot written by the previous release.
 *
 * Writes that bypass Mongoose (manual database edits, migrations) do not invalidate; the TTL
 * bounds how long such changes can stay invisible. Run `invalidateOrgHierarchyCache()` after them.
 */

import { getCounter, incrementCounter } from './cacheStore.js';
import { logger } from '../utils/logger.js';

const SNAPSHOT_SCHEMA_VERSION = 1;
const GENERATION_KEY = 'org:hierarchy:generation';

export const ORG_HIERARCHY_CACHE_SETTINGS = Object.freeze({
  // Safety net for changes that do not go through Mongoose; normal edits invalidate immediately.
  SNAPSHOT_TTL_SECONDS: 300,
});

/** The current generation, or null when the cache is unavailable (callers then skip caching). */
export function readHierarchyGeneration() {
  return getCounter(GENERATION_KEY);
}

export function hierarchySnapshotKey(generation) {
  return `org:hierarchy:snapshot:v${SNAPSHOT_SCHEMA_VERSION}:g${generation}`;
}

/**
 * Marks every cached hierarchy snapshot as stale. Never throws, so it is safe to call
 * fire-and-forget from model middleware: a failed invalidation is logged and the TTL takes over.
 * @param {string} reason  Logged, to explain why the cache was invalidated.
 */
export async function invalidateOrgHierarchyCache(reason) {
  const nextGeneration = await incrementCounter(GENERATION_KEY);
  if (nextGeneration === null) {
    logger.warn('Org hierarchy cache invalidation failed; stale data possible until the TTL expires', {
      reason,
      ttlSeconds: ORG_HIERARCHY_CACHE_SETTINGS.SNAPSHOT_TTL_SECONDS,
    });
    return;
  }
  logger.info('Org hierarchy cache invalidated', { reason, generation: nextGeneration });
}
