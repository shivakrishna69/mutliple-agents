/**
 * Web pages as NSK's external knowledge (models/ExternalSource.js, Qdrant `external_knowledge`).
 *
 *   readPage        one page for someone with RUN_WEB_RESEARCH: the admin's lists checked; a fresh
 *                   cached copy answered without fetching; otherwise the page is fetched safely
 *                   (safeFetch.js, within the person's daily limit), its readable text extracted
 *                   (pageExtraction.js), chunked like knowledge base documents, and indexed until
 *                   EXTERNAL_KNOWLEDGE_TTL_DAYS. Approved when its final domain is on the allowlist.
 *                   When the index cannot be reached, the page is still answered (and kept, unindexed,
 *                   for the same person to ask again) with a note.
 *   cleanUpExpired  the cleanup job (externalKnowledgeJob.js): expired records with their chunks,
 *                   then any expired chunk left without a record
 *
 * reserveWebUsage keeps each person within their daily limits (config.webResearch.dailyLimits).
 */

import { createHash } from 'node:crypto';
import { HTTP_STATUS } from '../../constants/httpStatus.js';
import { WEB_RESEARCH_MESSAGES as M } from '../../constants/messages.js';
import { WEB_RESEARCH_SETTINGS as S } from '../../constants/validation.js';
import ExternalSource from '../../models/ExternalSource.js';
import { StockQuoteUsage, WebFetchUsage, WebSearchUsage } from '../../models/WebResearchUsage.js';
import { logger } from '../../utils/logger.js';
import { AiServiceError } from '../aiServiceClient.js';
import { reserveDailyUsage } from '../dailyUsageQuota.js';
import { chunkBlocks } from '../knowledge/knowledgeBaseService.js';
import { ServiceError } from '../serviceError.js';
import { indexExternalChunks, removeExpiredExternal, removeExternalSources } from './externalKnowledgeIndex.js';
import { extractPage } from './pageExtraction.js';
import { fetchPublicPage } from './safeFetch.js';
import {
  DOMAIN_POLICIES,
  FETCH_ERROR_CODES,
  WebFetchError,
  allowedRangesOf,
  assertDomainAllowed,
  normalizeUrl,
} from './urlSafety.js';
import { removeSources } from './webResearchSettings.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export const USAGE_KINDS = Object.freeze({ FETCH: 'fetch', SEARCH: 'search', QUOTE: 'quote' });
const USAGE_MODELS = Object.freeze({
  [USAGE_KINDS.FETCH]: WebFetchUsage,
  [USAGE_KINDS.SEARCH]: WebSearchUsage,
  [USAGE_KINDS.QUOTE]: StockQuoteUsage,
});

/** Spends one of the person's daily `kind` calls, or refuses (429) when they are used up. */
export function reserveWebUsage(kind, actor, config) {
  const limit = config.webResearch.dailyLimits[kind];
  return reserveDailyUsage({
    usageModel: USAGE_MODELS[kind],
    userId: actor.id,
    limit,
    retentionDays: S.USAGE_RETENTION_DAYS,
    limitError: () =>
      new ServiceError(HTTP_STATUS.TOO_MANY_REQUESTS, 'WEB_DAILY_LIMIT', M.DAILY_LIMIT(M.USAGE_KINDS[kind], limit)),
  });
}

/** A refusal the assistant can pass on (422 with the reason), from a WebFetchError. */
export function fetchRefusal(fetchError) {
  const message = M.FETCH_REFUSED[fetchError.code];
  const text = typeof message === 'function' ? message(fetchError.details.status) : message;
  return new ServiceError(HTTP_STATUS.UNPROCESSABLE_CONTENT, `FETCH_${fetchError.code}`, text);
}

/** What the assistant is given for a page. */
export function toPageResult(source, { cached, note = null }) {
  return {
    source_id: source._id.toString(),
    url: source.url,
    final_url: source.finalUrl,
    title: source.title,
    domain: source.domain,
    fetched_at: source.fetchedAt.toISOString(),
    approved: source.approved,
    cached,
    text: source.excerpt,
    ...(note ? { note } : {}),
  };
}

async function freshCopyOf(url, now) {
  return ExternalSource.findOne({ url, expiresAt: { $gt: now } }).lean();
}

/**
 * @param {{ actor: { id: string }, url: string, settings: object, config: object, requestId: string,
 *   now?: Date, resolve?: Function }} request  `resolve` replaces DNS in tests of this function
 * @returns {Promise<{ source: object, cached: boolean, note: string|null }>}
 * @throws {ServiceError}  422 for a page that may not or cannot be read, 429 over the daily limit
 */
export async function readPage({ actor, url, settings, config, requestId, now = new Date(), resolve }) {
  let normalized;
  try {
    normalized = normalizeUrl(url, { allowedPorts: config.webResearch.allowedPorts });
    assertDomainAllowed(normalized.hostname, settings);
  } catch (refused) {
    if (refused instanceof WebFetchError) throw fetchRefusal(refused);
    throw refused;
  }
  const cached = await freshCopyOf(normalized.url, now);
  if (cached) return { source: cached, cached: true, note: cached.indexed ? null : M.INDEX_UNAVAILABLE };

  await reserveWebUsage(USAGE_KINDS.FETCH, actor, config);
  let page;
  try {
    page = await fetchPublicPage(normalized.url, {
      checkHost: (hostname) => assertDomainAllowed(hostname, settings),
      allowedRanges: allowedRangesOf(config.webResearch.allowedPrivateCidrs),
      allowedPorts: config.webResearch.allowedPorts,
      ...(resolve ? { resolve } : {}),
    });
  } catch (fetchError) {
    if (fetchError instanceof WebFetchError) throw fetchRefusal(fetchError);
    throw fetchError;
  }
  const extracted = extractPage(page);
  if (!extracted.text) throw fetchRefusal(new WebFetchError(FETCH_ERROR_CODES.EMPTY_CONTENT));

  // Approved only when the page it ended on is on the allowlist.
  const approved = assertDomainAllowed(page.hostname, settings) === DOMAIN_POLICIES.APPROVED;
  const chunks = chunkBlocks(extracted.blocks);
  const fetchedAt = now;
  const fields = {
    url: normalized.url,
    finalUrl: page.finalUrl,
    domain: page.hostname,
    title: extracted.title,
    byline: extracted.byline,
    approved,
    fetchedAt,
    expiresAt: new Date(fetchedAt.getTime() + config.webResearch.cacheTtlDays * DAY_MS),
    excerpt: extracted.text.slice(0, S.EXCERPT_CHARS),
    sha256: createHash('sha256').update(extracted.text).digest('hex'),
    sizeBytes: page.sizeBytes,
    chunkCount: 0,
    indexed: false,
    fetchedByUserId: actor.id,
  };
  // One record per URL: an expired copy is replaced, its old chunks removed first.
  const previous = await ExternalSource.findOne({ url: normalized.url }).select('_id').lean();
  const callContext = { config, requestId };
  let source;
  let note = null;
  try {
    if (previous) await removeExternalSources([previous._id], callContext);
    source = await ExternalSource.findOneAndUpdate(
      { url: normalized.url },
      { $set: fields },
      { upsert: true, new: true },
    ).lean();
    const indexed = await indexExternalChunks({ source, chunks }, callContext);
    source = await ExternalSource.findByIdAndUpdate(
      source._id,
      { $set: { indexed: true, chunkCount: indexed } },
      { new: true },
    ).lean();
  } catch (indexError) {
    if (!(indexError instanceof AiServiceError)) throw indexError;
    logger.warn('A fetched page could not be indexed; it is kept unindexed until it expires', {
      requestId,
      domain: page.hostname,
      failureKind: indexError.failureKind,
    });
    source ??= await ExternalSource.findOneAndUpdate(
      { url: normalized.url },
      { $set: fields },
      { upsert: true, new: true },
    ).lean();
    note = M.INDEX_UNAVAILABLE;
  }
  return { source, cached: false, note };
}

/**
 * The cleanup job's step: expired pages removed with their chunks, then expired chunks with no record.
 * @returns {Promise<{ removedSources: number, removedOrphanChunks: number }>}
 */
export async function cleanUpExpired({ config, now = new Date() }) {
  const callContext = { config, requestId: `external-knowledge-cleanup-${now.getTime()}` };
  const expired = await ExternalSource.find({ expiresAt: { $lte: now } })
    .select('_id domain')
    .lean();
  const removedSources = await removeSources(expired, callContext);
  const removedOrphanChunks = await removeExpiredExternal(now, callContext);
  return { removedSources, removedOrphanChunks };
}
