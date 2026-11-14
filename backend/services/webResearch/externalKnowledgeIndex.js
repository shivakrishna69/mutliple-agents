/**
 * The ai-service's external knowledge index (ai-service app/knowledge/, Qdrant collection
 * `external_knowledge`), as this backend calls it with the internal API key:
 *
 *   POST /ai/external-knowledge/chunks            a page's chunks with the metadata every chunk carries:
 *                                                 its source id, URL, domain, title, fetchedAt,
 *                                                 expiresAt and whether it is approved
 *   POST /ai/external-knowledge/sources/remove    every chunk of these sources
 *   POST /ai/external-knowledge/sources/approval  mark these sources approved, or not
 *   POST /ai/external-knowledge/expired/remove    every chunk that expired before a time (the cleanup
 *                                                 job's safety net for records already gone)
 *
 * Each answers a count; anything else is an AiServiceError(invalid_response).
 */

import { KNOWLEDGE_BASE_SETTINGS } from '../../constants/validation.js';
import { AI_FAILURE_KIND, AiServiceError, postToAiService } from '../aiServiceClient.js';

export const AI_EXTERNAL_PATHS = Object.freeze({
  CHUNKS: '/ai/external-knowledge/chunks',
  REMOVE: '/ai/external-knowledge/sources/remove',
  APPROVAL: '/ai/external-knowledge/sources/approval',
  REMOVE_EXPIRED: '/ai/external-knowledge/expired/remove',
});
// Sources named in one remove or approval request.
const SOURCES_PER_REQUEST = 100;

function countFrom(field) {
  return (responseBody) => {
    const value = responseBody?.[field];
    if (!Number.isInteger(value) || value < 0) {
      throw new AiServiceError(AI_FAILURE_KIND.INVALID_RESPONSE, `"${field}" must be a whole number`);
    }
    return { [field]: value };
  };
}

/**
 * @param {{ source: object, chunks: { chunkIndex: number, text: string, headingPath: string[] }[] }} input
 *   source: an ExternalSource record
 * @param {{ config: object, requestId: string }} callContext
 * @returns {Promise<number>} chunks indexed
 */
export async function indexExternalChunks({ source, chunks }, callContext) {
  const metadata = {
    source_id: source._id.toString(),
    source_url: source.finalUrl,
    domain: source.domain,
    title: source.title,
    fetched_at: source.fetchedAt.toISOString(),
    expires_at: source.expiresAt.toISOString(),
    approved: source.approved,
  };
  let indexed = 0;
  for (let start = 0; start < chunks.length; start += KNOWLEDGE_BASE_SETTINGS.INDEX_BATCH_SIZE) {
    const batch = chunks.slice(start, start + KNOWLEDGE_BASE_SETTINGS.INDEX_BATCH_SIZE);
    const { indexed: batchIndexed } = await postToAiService(
      AI_EXTERNAL_PATHS.CHUNKS,
      {
        ...metadata,
        chunks: batch.map((chunk) => ({
          chunk_index: chunk.chunkIndex,
          text: chunk.text,
          heading_path: chunk.headingPath,
        })),
      },
      callContext,
      countFrom('indexed'),
    );
    if (batchIndexed !== batch.length) {
      throw new AiServiceError(AI_FAILURE_KIND.INVALID_RESPONSE, `indexed ${batchIndexed} of ${batch.length} chunks`);
    }
    indexed += batchIndexed;
  }
  return indexed;
}

async function inBatches(ids, send) {
  let total = 0;
  for (let start = 0; start < ids.length; start += SOURCES_PER_REQUEST) {
    total += await send(ids.slice(start, start + SOURCES_PER_REQUEST).map(String));
  }
  return total;
}

/** @returns {Promise<number>} chunks removed */
export function removeExternalSources(sourceIds, callContext) {
  return inBatches(sourceIds, async (batch) => {
    const { removed } = await postToAiService(
      AI_EXTERNAL_PATHS.REMOVE,
      { source_ids: batch },
      callContext,
      countFrom('removed'),
    );
    return removed;
  });
}

/** @returns {Promise<number>} chunks updated */
export function setExternalApproval(sourceIds, approved, callContext) {
  return inBatches(sourceIds, async (batch) => {
    const { updated } = await postToAiService(
      AI_EXTERNAL_PATHS.APPROVAL,
      { source_ids: batch, approved },
      callContext,
      countFrom('updated'),
    );
    return updated;
  });
}

/** @returns {Promise<number>} chunks removed */
export async function removeExpiredExternal(before, callContext) {
  const { removed } = await postToAiService(
    AI_EXTERNAL_PATHS.REMOVE_EXPIRED,
    { before: before.toISOString() },
    callContext,
    countFrom('removed'),
  );
  return removed;
}
