/**
 * The daily briefing's cache and its invalidation. A person's briefing is kept for
 * INSIGHT_SETTINGS.CACHE_TTL_SECONDS (Redis when configured, else this process's memory:
 * services/cacheStore.js). A change to a leave request or a task clears the briefings of everyone it
 * appears to and tells their open sessions (Socket.IO INSIGHTS_CHANGED), so banners refresh at once
 * rather than after the cache runs out.
 *
 * Invalidation never fails the change that caused it: a cache or socket error is logged, and the
 * briefing is simply fresh at the next fetch after its time runs out.
 */

import { INSIGHT_SETTINGS } from '../../constants/validation.js';
import EmployeeProfile from '../../models/EmployeeProfile.js';
import User, { ACCOUNT_STATUSES } from '../../models/User.js';
import { logger } from '../../utils/logger.js';
import { emitInsightsChanged } from '../../utils/socketManager.js';
import { deleteCachedJson, getCachedJson, setCachedJson } from '../cacheStore.js';
import { WORKFORCE_ADMIN_ROLES } from '../workforceAccess.js';

const briefingKey = (userId) => `insights:briefing:v1:${userId}`;

export const readCachedBriefing = (userId) => getCachedJson(briefingKey(userId));

export const storeCachedBriefing = (userId, briefing) =>
  setCachedJson(briefingKey(userId), briefing, INSIGHT_SETTINGS.CACHE_TTL_SECONDS);

/**
 * Clears the briefings of these accounts and tells their open sessions. Never throws.
 * @param {Array<string|object|null|undefined>} userIds
 */
export async function invalidateInsights(userIds) {
  const recipients = [...new Set(userIds.filter(Boolean).map(String))];
  await Promise.all(
    recipients.map(async (userId) => {
      try {
        await deleteCachedJson(briefingKey(userId));
      } catch (cacheError) {
        logger.warn('Briefing cache could not be cleared', { userId, error: cacheError.message });
      }
      emitInsightsChanged(userId);
    }),
  );
}

/** The accounts of these employee records (EmployeeProfile ids). */
export async function userIdsOfProfiles(profileIds) {
  const ids = profileIds.filter(Boolean);
  if (ids.length === 0) return [];
  const profiles = await EmployeeProfile.find({ _id: { $in: ids } })
    .select('userId')
    .lean();
  return profiles.map((profile) => profile.userId.toString());
}

/** Active HR users and administrators: they decide leave at the HR step and see every request. */
export async function workforceAdminUserIds() {
  const accounts = await User.find({ role: { $in: WORKFORCE_ADMIN_ROLES }, status: ACCOUNT_STATUSES.ACTIVE })
    .select('_id')
    .lean();
  return accounts.map((account) => account._id.toString());
}

/**
 * Runs an invalidation without letting it fail the caller (a leave or task change that already
 * succeeded). Logs instead.
 * @param {() => Promise<unknown>} invalidate
 */
export async function invalidateQuietly(invalidate) {
  try {
    await invalidate();
  } catch (invalidationError) {
    logger.warn('Briefing invalidation failed', { error: invalidationError.message });
  }
}
