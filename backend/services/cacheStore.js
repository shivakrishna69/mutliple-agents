/**
 * Shared key-value cache for read-heavy, rebuildable data (e.g. the org hierarchy snapshot).
 *
 * Backends
 *   - REDIS_URL set:   a dedicated Redis connection, shared by every backend instance, so one
 *                      instance's invalidation is seen by all of them.
 *   - REDIS_URL unset: a process-local in-memory map with the same TTL semantics. Correct for a
 *                      single instance (local development); with several instances each keeps its
 *                      own copy, so configure Redis before scaling out.
 *
 * Failure policy: the cache is an optimisation, never a dependency of correctness.
 *   - Startup fails if REDIS_URL is set but Redis is unreachable (same policy as the Socket.IO
 *     adapter), so a misconfiguration is caught at deploy time.
 *   - After startup, every operation is bounded by CACHE_SETTINGS.OPERATION_TIMEOUT_MS and never
 *     throws: a failure is logged and reported as a miss (`null`) or a no-op, and callers fall back
 *     to the database. `disableOfflineQueue` makes commands fail immediately while Redis is
 *     reconnecting instead of piling up behind the outage.
 *
 * Values are JSON. Keys should be namespaced by feature ("org:hierarchy:…").
 */

import { createClient } from 'redis';
import { logger } from '../utils/logger.js';

export const CACHE_SETTINGS = Object.freeze({
  CONNECT_TIMEOUT_MS: 10_000,
  MAX_RECONNECT_DELAY_MS: 5_000,
  // A cache read slower than this is treated as a miss; the database is the faster path then.
  OPERATION_TIMEOUT_MS: 250,
  // Upper bound for the in-memory fallback, so a key-naming bug cannot grow it without limit.
  MEMORY_MAX_ENTRIES: 1_000,
});

/**
 * Memory backend: `entries` holds cached values (TTL, size-capped); `counters` holds generation
 * counters separately, so evicting old values can never reset a counter.
 * @type {{ kind: 'redis', client: object } | { kind: 'memory', entries: Map<string, { value: string, expiresAtMs: number }>, counters: Map<string, number> } | null}
 */
let activeBackend = null;

class CacheTimeoutError extends Error {
  constructor(operationName) {
    super(`Cache ${operationName} timed out after ${CACHE_SETTINGS.OPERATION_TIMEOUT_MS} ms`);
    this.name = 'CacheTimeoutError';
  }
}

/** Resolves with `operation`'s result, or rejects with CacheTimeoutError if it takes too long. */
function withTimeout(operationName, operation) {
  let timeoutHandle;
  const timeout = new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new CacheTimeoutError(operationName)), CACHE_SETTINGS.OPERATION_TIMEOUT_MS);
  });
  return Promise.race([operation, timeout]).finally(() => clearTimeout(timeoutHandle));
}

function redactRedisUrl(redisUrl) {
  const parsedRedisUrl = new URL(redisUrl);
  if (parsedRedisUrl.password) parsedRedisUrl.password = '***';
  return parsedRedisUrl.toString();
}

// ---------------------------------------------------------------------------
// In-memory backend
// ---------------------------------------------------------------------------

function readMemoryEntry(cacheKey) {
  const cacheEntry = activeBackend.entries.get(cacheKey);
  if (!cacheEntry) return null;
  if (cacheEntry.expiresAtMs <= Date.now()) {
    activeBackend.entries.delete(cacheKey);
    return null;
  }
  return cacheEntry.value;
}

function writeMemoryEntry(cacheKey, serializedValue, ttlSeconds) {
  const { entries } = activeBackend;
  entries.delete(cacheKey);
  if (entries.size >= CACHE_SETTINGS.MEMORY_MAX_ENTRIES) {
    // Maps iterate in insertion order, so the first key is the oldest write.
    entries.delete(entries.keys().next().value);
  }
  entries.set(cacheKey, { value: serializedValue, expiresAtMs: Date.now() + ttlSeconds * 1000 });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Connects the cache. Call once during startup, before the HTTP server accepts requests.
 * @param {{ redisUrl: string | null }} config
 * @throws {Error} if Redis is configured but cannot be reached
 */
export async function initCacheStore({ redisUrl }) {
  if (activeBackend) throw new Error('initCacheStore was called more than once');

  if (!redisUrl) {
    activeBackend = { kind: 'memory', entries: new Map(), counters: new Map() };
    logger.info('Cache store ready', { backend: 'memory' });
    return;
  }

  const redactedRedisUrl = redactRedisUrl(redisUrl);
  const connectionState = { hasCompletedInitialConnect: false };
  const redisClient = createClient({
    url: redisUrl,
    disableOfflineQueue: true,
    socket: {
      connectTimeout: CACHE_SETTINGS.CONNECT_TIMEOUT_MS,
      // Before the first successful connect a failure is final (startup fails fast); afterwards
      // reconnect with capped exponential backoff.
      reconnectStrategy: (retryCount, failureCause) => {
        if (!connectionState.hasCompletedInitialConnect) {
          return new Error(`Initial Redis connection failed: ${failureCause?.message ?? 'unknown error'}`);
        }
        return Math.min(2 ** retryCount * 100, CACHE_SETTINGS.MAX_RECONNECT_DELAY_MS);
      },
    },
  });
  // node-redis reports connection failures as 'error' events; an unhandled one would crash the process.
  redisClient.on('error', (redisError) => logger.error('Redis cache connection error', { redisUrl: redactedRedisUrl, error: redisError.message }));
  redisClient.on('reconnecting', () => logger.warn('Redis cache connection reconnecting', { redisUrl: redactedRedisUrl }));

  try {
    await redisClient.connect();
  } catch (connectError) {
    await Promise.allSettled([redisClient.destroy()]);
    throw new Error(`Could not connect the cache to Redis at ${redactedRedisUrl}: ${connectError.message}`);
  }
  connectionState.hasCompletedInitialConnect = true;
  activeBackend = { kind: 'redis', client: redisClient };
  logger.info('Cache store ready', { backend: 'redis', redisUrl: redactedRedisUrl });
}

/** Closes the Redis connection (if any). Safe to call when the cache was never initialised. */
export async function closeCacheStore() {
  const closingBackend = activeBackend;
  activeBackend = null;
  if (closingBackend?.kind !== 'redis') return;
  const { client: redisClient } = closingBackend;
  // During an outage the client is reconnecting and a graceful close would wait for it; there is
  // nothing to flush, so drop the socket immediately.
  if (!redisClient.isReady) {
    redisClient.destroy();
    return;
  }
  try {
    await withTimeout('close', redisClient.close());
  } catch (closeError) {
    logger.warn('Redis cache connection did not close cleanly', { error: closeError.message });
    redisClient.destroy();
  }
}

// ---------------------------------------------------------------------------
// Operations (never throw)
// ---------------------------------------------------------------------------

/**
 * Reads and parses a JSON value. Returns null on a miss, an expired key, a corrupt value, an
 * uninitialised cache, or any Redis failure.
 */
export async function getCachedJson(cacheKey) {
  if (!activeBackend) return null;
  try {
    const serializedValue =
      activeBackend.kind === 'redis' ? await withTimeout('get', activeBackend.client.get(cacheKey)) : readMemoryEntry(cacheKey);
    return serializedValue === null ? null : JSON.parse(serializedValue);
  } catch (readError) {
    logger.warn('Cache read failed; falling back to the source', { cacheKey, error: readError.message });
    return null;
  }
}

/** Stores a JSON value for `ttlSeconds`. Returns true when stored, false on failure. */
export async function setCachedJson(cacheKey, cacheValue, ttlSeconds) {
  if (!activeBackend) return false;
  try {
    const serializedValue = JSON.stringify(cacheValue);
    if (activeBackend.kind === 'redis') {
      await withTimeout('set', activeBackend.client.set(cacheKey, serializedValue, { expiration: { type: 'EX', value: ttlSeconds } }));
    } else {
      writeMemoryEntry(cacheKey, serializedValue, ttlSeconds);
    }
    return true;
  } catch (writeError) {
    logger.warn('Cache write failed', { cacheKey, error: writeError.message });
    return false;
  }
}

/**
 * Reads an integer counter (used as a cache generation number). A missing counter is 0.
 * Returns null when the cache cannot be read, so the caller can skip caching entirely.
 */
export async function getCounter(counterKey) {
  if (!activeBackend) return null;
  try {
    const counterValue =
      activeBackend.kind === 'redis' ? await withTimeout('get', activeBackend.client.get(counterKey)) : String(activeBackend.counters.get(counterKey) ?? 0);
    const parsedCounter = counterValue === null ? 0 : Number.parseInt(counterValue, 10);
    return Number.isSafeInteger(parsedCounter) ? parsedCounter : 0;
  } catch (readError) {
    logger.warn('Cache counter read failed', { counterKey, error: readError.message });
    return null;
  }
}

/** Atomically increments a counter that never expires. Returns the new value, or null on failure. */
export async function incrementCounter(counterKey) {
  if (!activeBackend) return null;
  try {
    if (activeBackend.kind === 'redis') {
      return await withTimeout('incr', activeBackend.client.incr(counterKey));
    }
    const nextValue = (activeBackend.counters.get(counterKey) ?? 0) + 1;
    activeBackend.counters.set(counterKey, nextValue);
    return nextValue;
  } catch (incrementError) {
    logger.warn('Cache counter increment failed', { counterKey, error: incrementError.message });
    return null;
  }
}
