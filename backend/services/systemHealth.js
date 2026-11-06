/**
 * The health of the services the portal depends on, for the dashboard's "Connected services" card
 * and its "Systems live" / "AI agent active" pills (administrators only: GET /api/system/health).
 *
 *   aiService  GET <AI_SERVICE_URL>/health within SYSTEM_HEALTH_SETTINGS.AI_SERVICE_TIMEOUT_MS
 *              (200 operational, 503 degraded: running without its language model; else down)
 *   email      an SMTP connection (and login) check, reused for EMAIL_CHECK_CACHE_MS so loading the
 *              dashboard does not connect to the mail provider every time
 *   database   a MongoDB ping
 *   cache      a Redis ping, or the in-memory cache (always available to this instance)
 *
 * Each service is operational, degraded (answered, but slowly or partly), down, or not_configured.
 * Only states and timings are reported: never addresses, hosts, keys or error texts. overall is
 * down when the database is, degraded when any configured service is not operational.
 */

import axios from 'axios';
import mongoose from 'mongoose';

import { SYSTEM_SERVICE_LABELS, SYSTEM_STATUS_LABELS } from '../constants/messages.js';
import { SYSTEM_HEALTH_SETTINGS } from '../constants/validation.js';
import { checkCacheStore } from './cacheStore.js';
import { checkMailConnection } from './mailService.js';

export const SERVICE_STATES = Object.freeze({
  OPERATIONAL: 'operational',
  DEGRADED: 'degraded',
  DOWN: 'down',
  NOT_CONFIGURED: 'not_configured',
});

const S = SERVICE_STATES;

/** Times `check` (which returns a state), marking a slow answer as degraded. */
async function timed(check, now) {
  const startedAt = Date.now();
  const state = await check();
  const responseMs = Date.now() - startedAt;
  const slowed = state === S.OPERATIONAL && responseMs > SYSTEM_HEALTH_SETTINGS.SLOW_RESPONSE_MS;
  return { status: slowed ? S.DEGRADED : state, responseMs, checkedAt: now().toISOString() };
}

async function checkAiService(aiServiceUrl) {
  try {
    const response = await axios.get(`${aiServiceUrl}/health`, {
      timeout: SYSTEM_HEALTH_SETTINGS.AI_SERVICE_TIMEOUT_MS,
      validateStatus: () => true,
    });
    if (response.status === 200) return S.OPERATIONAL;
    return response.status === 503 ? S.DEGRADED : S.DOWN;
  } catch {
    return S.DOWN;
  }
}

async function checkDatabase() {
  if (mongoose.connection.readyState !== 1) return S.DOWN;
  try {
    await mongoose.connection.db.admin().ping();
    return S.OPERATIONAL;
  } catch {
    return S.DOWN;
  }
}

async function checkCache() {
  const { kind, reachable } = await checkCacheStore();
  if (!kind) return S.NOT_CONFIGURED;
  return reachable ? S.OPERATIONAL : S.DOWN;
}

let lastEmailCheck = null;

/** The SMTP check, reused while it is younger than EMAIL_CHECK_CACHE_MS. */
async function checkEmail(now) {
  const nowMs = now().getTime();
  if (lastEmailCheck && nowMs - lastEmailCheck.atMs < SYSTEM_HEALTH_SETTINGS.EMAIL_CHECK_CACHE_MS) {
    return lastEmailCheck.result;
  }
  const result = await timed(async () => {
    const { configured, reachable } = await checkMailConnection();
    if (!configured) return S.NOT_CONFIGURED;
    return reachable ? S.OPERATIONAL : S.DOWN;
  }, now);
  lastEmailCheck = { atMs: nowMs, result };
  return result;
}

function overallOf(services) {
  const database = services.find((service) => service.key === 'database');
  if (database.status === S.DOWN) return S.DOWN;
  const configured = services.filter((service) => service.status !== S.NOT_CONFIGURED);
  return configured.every((service) => service.status === S.OPERATIONAL) ? S.OPERATIONAL : S.DEGRADED;
}

/**
 * @param {{ aiServiceUrl: string, now?: () => Date }} options
 * @returns {Promise<{ overall: string, overallLabel: string, checkedAt: string,
 *   services: { key: string, label: string, status: string, statusLabel: string,
 *   responseMs: number, checkedAt: string }[] }>}
 */
export async function checkSystemHealth({ aiServiceUrl, now = () => new Date() }) {
  const [aiService, email, database, cache] = await Promise.all([
    timed(() => checkAiService(aiServiceUrl), now),
    checkEmail(now),
    timed(checkDatabase, now),
    timed(checkCache, now),
  ]);
  const services = Object.entries({ aiService, email, database, cache }).map(([key, result]) => ({
    key,
    label: SYSTEM_SERVICE_LABELS[key],
    ...result,
    statusLabel: SYSTEM_STATUS_LABELS[result.status],
  }));
  const overall = overallOf(services);
  return { overall, overallLabel: SYSTEM_STATUS_LABELS[overall], checkedAt: now().toISOString(), services };
}
