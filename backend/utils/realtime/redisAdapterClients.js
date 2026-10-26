/**
 * Redis connections for the Socket.IO adapter, used when several backend instances share rooms.
 */

import { createClient } from 'redis';
import { logger } from '../logger.js';
import { SOCKET_SERVER_SETTINGS } from './socketProtocol.js';

/** REDIS_URL with any password replaced, safe to log. */
function redactRedisUrl(redisUrl) {
  const parsedRedisUrl = new URL(redisUrl);
  if (parsedRedisUrl.password) parsedRedisUrl.password = '***';
  return parsedRedisUrl.toString();
}

/**
 * Opens the adapter's publisher and subscriber connections.
 *
 * Reconnect policy: before both connections have succeeded once, a failed attempt is final, so
 * startup fails within REDIS_CONNECT_TIMEOUT_MS instead of retrying forever. After that, a lost
 * connection is retried with exponential backoff capped at REDIS_MAX_RECONNECT_DELAY_MS, and
 * every state change is logged. An `error` listener is attached to each client because
 * node-redis emits connection failures as events, and an unhandled `error` event would crash
 * the process.
 *
 * @param {string} redisUrl
 * @returns {Promise<{ publisherClient: object, subscriberClient: object }>}
 * @throws {Error} if either connection cannot be established
 */
export async function connectRedisAdapterClients(redisUrl) {
  const connectionState = { hasCompletedInitialConnect: false };
  const redactedRedisUrl = redactRedisUrl(redisUrl);

  const publisherClient = createClient({
    url: redisUrl,
    socket: {
      connectTimeout: SOCKET_SERVER_SETTINGS.REDIS_CONNECT_TIMEOUT_MS,
      reconnectStrategy: (retryCount, failureCause) => {
        if (!connectionState.hasCompletedInitialConnect) {
          return new Error(`Initial Redis connection failed: ${failureCause?.message ?? 'unknown error'}`);
        }
        return Math.min(2 ** retryCount * 100, SOCKET_SERVER_SETTINGS.REDIS_MAX_RECONNECT_DELAY_MS);
      },
    },
  });
  // duplicate() copies the URL and socket options, including the reconnect strategy.
  const subscriberClient = publisherClient.duplicate();

  for (const [connectionRole, redisClient] of [
    ['publisher', publisherClient],
    ['subscriber', subscriberClient],
  ]) {
    redisClient.on('error', (redisError) => {
      logger.error('Redis adapter connection error', {
        connectionRole,
        redisUrl: redactedRedisUrl,
        error: redisError.message,
      });
    });
    redisClient.on('reconnecting', () => {
      logger.warn('Redis adapter connection reconnecting', { connectionRole, redisUrl: redactedRedisUrl });
    });
    redisClient.on('ready', () => {
      logger.info('Redis adapter connection ready', { connectionRole, redisUrl: redactedRedisUrl });
    });
  }

  try {
    await Promise.all([publisherClient.connect(), subscriberClient.connect()]);
  } catch (connectError) {
    // Release whichever connection did open so the failed startup leaves no sockets behind.
    await Promise.allSettled([publisherClient, subscriberClient].map((redisClient) => redisClient.destroy()));
    throw new Error(`Could not connect to Redis at ${redactedRedisUrl}: ${connectError.message}`);
  }

  connectionState.hasCompletedInitialConnect = true;
  return { publisherClient, subscriberClient };
}
