/**
 * The vector index of department knowledge, which the AI service keeps (it embeds the text and
 * stores it in Qdrant). Calls go through the shared internal client (services/aiServiceClient.js:
 * internal API key, hard deadline, no redirects, size caps), and fail with its AiServiceError.
 *
 *   indexChunks({ document, companyId, chunks }, callContext)
 *       POST /ai/knowledge/chunks, in batches of KNOWLEDGE_BASE_SETTINGS.INDEX_BATCH_SIZE. Every
 *       chunk carries its metadata: company, department, agent, document, accessLevel DEPARTMENT,
 *       chunk number, headings and page. The AI service derives each point's id from the document
 *       id and chunk number, so indexing a document again overwrites its chunks.
 *   removeDocumentChunks(documentId, callContext)
 *       POST /ai/knowledge/documents/remove: evicts every chunk of the document; safe to repeat.
 *
 * callContext is { config, requestId } as for every AI service call.
 */

import { KNOWLEDGE_BASE_SETTINGS } from '../../constants/validation.js';
import { AI_FAILURE_KIND, AiServiceError, postToAiService } from '../aiServiceClient.js';

export const AI_KNOWLEDGE_CHUNKS_PATH = '/ai/knowledge/chunks';
export const AI_KNOWLEDGE_REMOVE_PATH = '/ai/knowledge/documents/remove';
export const KNOWLEDGE_ACCESS_LEVELS = Object.freeze({ DEPARTMENT: 'DEPARTMENT' });

const isCount = (value) => Number.isInteger(value) && value >= 0;

function countFrom(field) {
  return (responseBody) => {
    if (!isCount(responseBody?.[field])) {
      throw new AiServiceError(AI_FAILURE_KIND.INVALID_RESPONSE, `"${field}" must be a whole number`);
    }
    return { [field]: responseBody[field] };
  };
}

/**
 * @param {{ document: { _id, departmentId, agentId }, companyId: string,
 *   chunks: { chunkIndex: number, text: string, headingPath: string[], page: number|null }[] }} input
 * @param {{ config: object, requestId: string }} callContext
 * @param {{ beforeEachBatch?: () => Promise<void> }} [hooks]  e.g. to renew a lease; may throw to stop
 * @returns {Promise<number>} chunks indexed
 */
export async function indexChunks({ document, companyId, chunks }, callContext, { beforeEachBatch } = {}) {
  const metadata = {
    company_id: companyId,
    department_id: document.departmentId.toString(),
    agent_id: document.agentId.toString(),
    document_id: document._id.toString(),
    access_level: KNOWLEDGE_ACCESS_LEVELS.DEPARTMENT,
  };
  let indexed = 0;
  for (let start = 0; start < chunks.length; start += KNOWLEDGE_BASE_SETTINGS.INDEX_BATCH_SIZE) {
    await beforeEachBatch?.();
    const batch = chunks.slice(start, start + KNOWLEDGE_BASE_SETTINGS.INDEX_BATCH_SIZE);
    const { indexed: batchIndexed } = await postToAiService(
      AI_KNOWLEDGE_CHUNKS_PATH,
      {
        ...metadata,
        chunks: batch.map((chunk) => ({
          chunk_index: chunk.chunkIndex,
          text: chunk.text,
          heading_path: chunk.headingPath,
          page: chunk.page,
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

/** @returns {Promise<number>} chunks removed */
export async function removeDocumentChunks(documentId, callContext) {
  const { removed } = await postToAiService(
    AI_KNOWLEDGE_REMOVE_PATH,
    { document_id: documentId.toString() },
    callContext,
    countFrom('removed'),
  );
  return removed;
}
