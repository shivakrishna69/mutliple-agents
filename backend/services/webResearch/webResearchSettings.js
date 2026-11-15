/**
 * The administrator's web research rules (models/WebResearchSettings.js), and keeping the cached pages
 * in step with them:
 *
 *   getWebResearchSettings()      the settings, created with the defaults on first use
 *   updateWebResearchSettings()   new lists, refused when based on an older version. Then every cached
 *                                 page of a domain now blocked is removed (record and chunks), and a
 *                                 page whose domain was added to or taken off the allowlist has its
 *                                 approval changed in both places, so employees see exactly the pages
 *                                 of domains approved now.
 *   listCachedSources / removeCachedSource   what is cached, and removing one page
 */

import { HTTP_STATUS } from '../../constants/httpStatus.js';
import { WEB_RESEARCH_MESSAGES as M } from '../../constants/messages.js';
import { WEB_RESEARCH_SETTINGS as S } from '../../constants/validation.js';
import ExternalSource from '../../models/ExternalSource.js';
import WebResearchSettings, { WEB_RESEARCH_SETTINGS_KEY } from '../../models/WebResearchSettings.js';
import { isDuplicateKeyError } from '../../utils/mongoErrors.js';
import { logger } from '../../utils/logger.js';
import { ServiceError } from '../serviceError.js';
import { removeExternalSources, setExternalApproval } from './externalKnowledgeIndex.js';
import { DOMAIN_POLICIES, domainPolicyOf } from './urlSafety.js';

export async function getWebResearchSettings() {
  try {
    return await WebResearchSettings.findOneAndUpdate(
      { key: WEB_RESEARCH_SETTINGS_KEY },
      { $setOnInsert: { key: WEB_RESEARCH_SETTINGS_KEY } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).lean();
  } catch (upsertError) {
    if (!isDuplicateKeyError(upsertError)) throw upsertError;
    return WebResearchSettings.findOne({ key: WEB_RESEARCH_SETTINGS_KEY }).lean();
  }
}

export function toSettingsSummary(settings) {
  return {
    allowedDomains: [...settings.allowedDomains],
    blockedDomains: [...settings.blockedDomains],
    allowUnlistedDomains: settings.allowUnlistedDomains,
    version: settings.__v,
    updatedAt: settings.updatedAt ?? null,
  };
}

/** Removes cached pages (records and chunks). Chunks first: a record is never gone while its chunks stay. */
export async function removeSources(sources, callContext) {
  if (sources.length === 0) return 0;
  const ids = sources.map((source) => source._id);
  await removeExternalSources(ids, callContext);
  const { deletedCount } = await ExternalSource.deleteMany({ _id: { $in: ids } });
  return deletedCount;
}

/** Brings every cached page in line with `settings`; returns what changed. */
async function syncCachedSources(settings, callContext) {
  const sources = await ExternalSource.find({}).select('_id domain approved').lean();
  const blocked = [];
  const nowApproved = [];
  const noLongerApproved = [];
  for (const source of sources) {
    const policy = domainPolicyOf(source.domain, settings);
    if (policy === DOMAIN_POLICIES.BLOCKED) blocked.push(source);
    else if (policy === DOMAIN_POLICIES.APPROVED && !source.approved) nowApproved.push(source);
    else if (policy !== DOMAIN_POLICIES.APPROVED && source.approved) noLongerApproved.push(source);
  }
  const removed = await removeSources(blocked, callContext);
  for (const [group, approved] of [
    [nowApproved, true],
    [noLongerApproved, false],
  ]) {
    if (group.length === 0) continue;
    const ids = group.map((source) => source._id);
    await setExternalApproval(ids, approved, callContext);
    await ExternalSource.updateMany({ _id: { $in: ids } }, { $set: { approved } });
  }
  return { removed, approved: nowApproved.length, unapproved: noLongerApproved.length };
}

/**
 * @param {{ changes: { allowedDomains: string[], blockedDomains: string[], allowUnlistedDomains: boolean },
 *   version: number, actorUserId: string, callContext: object }} update  domains already normalised
 */
export async function updateWebResearchSettings({ changes, version, actorUserId, callContext }) {
  const overlap = changes.allowedDomains.find((domain) => changes.blockedDomains.includes(domain));
  if (overlap) {
    throw new ServiceError(HTTP_STATUS.UNPROCESSABLE_CONTENT, 'DOMAIN_IN_BOTH_LISTS', M.DOMAIN_IN_BOTH_LISTS(overlap));
  }
  await getWebResearchSettings();
  const updated = await WebResearchSettings.findOneAndUpdate(
    { key: WEB_RESEARCH_SETTINGS_KEY, __v: version },
    { $set: { ...changes, updatedByUserId: actorUserId }, $inc: { __v: 1 } },
    { new: true },
  ).lean();
  if (!updated) throw new ServiceError(HTTP_STATUS.CONFLICT, 'VERSION_CONFLICT', M.VERSION_CONFLICT);
  let synced = { removed: 0, approved: 0, unapproved: 0, failed: false };
  try {
    synced = { ...(await syncCachedSources(updated, callContext)), failed: false };
  } catch (syncError) {
    // The settings apply at once to new reads; the cache is brought in line on the next save or the
    // cleanup job. Searches already skip pages of a blocked domain's removed records.
    logger.error('Cached web pages could not be brought in line with the new settings', {
      error: { name: syncError.name, message: syncError.message },
    });
    synced.failed = true;
  }
  return { settings: toSettingsSummary(updated), synced };
}

export async function listCachedSources({ now = new Date() } = {}) {
  const sources = await ExternalSource.find({})
    .sort({ fetchedAt: -1 })
    .limit(S.SOURCES_LISTED)
    .select('url domain title approved fetchedAt expiresAt chunkCount indexed')
    .lean();
  return sources.map((source) => ({
    id: source._id.toString(),
    url: source.url,
    domain: source.domain,
    title: source.title,
    approved: source.approved,
    fetchedAt: source.fetchedAt,
    expiresAt: source.expiresAt,
    expired: source.expiresAt <= now,
    chunkCount: source.chunkCount,
    indexed: source.indexed,
  }));
}

export async function removeCachedSource({ sourceId, callContext }) {
  const source = await ExternalSource.findById(sourceId).select('_id domain').lean();
  if (!source) throw new ServiceError(HTTP_STATUS.NOT_FOUND, 'SOURCE_NOT_FOUND', M.SOURCE_NOT_FOUND);
  await removeSources([source], callContext);
  return { id: sourceId, domain: source.domain };
}
