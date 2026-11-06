/**
 * Processes one knowledge base document (models/AgentDocument.js), run by the ingestion queue
 * (services/knowledge/ingestionQueue.js):
 *
 *   claim     UPLOADED, or PROCESSING with an expired lease, and fewer than MAX_ATTEMPTS attempts:
 *             becomes PROCESSING with this worker's lease. Anything else is left alone, so a document
 *             handed out twice is processed once.
 *   read      the stored file (checked against its SHA-256), its text read in a limited thread
 *   chunk     deterministic chunks, at most MAX_CHUNKS_PER_DOCUMENT
 *   index     the document's old chunks are evicted first, then the new ones are indexed in batches;
 *             the lease is renewed before every step
 *   finish    READY with the chunk count, only if this worker still holds the lease
 *
 * Outcomes:
 *   - a file that cannot be used (encrypted, scanned, damaged, too big, missing) is FAILED at once,
 *     with KNOWLEDGE_MESSAGES.PROCESSING_FAILURES explaining why
 *   - the index being unreachable is retried: the lease is released and the error thrown, so the
 *     queue (or the sweep) runs it again; after MAX_ATTEMPTS it is FAILED (INDEX_UNAVAILABLE)
 *   - losing the lease (the document is being deleted, or another worker took over) stops the run,
 *     and the chunks it may have indexed are evicted
 */

import { KNOWLEDGE_MESSAGES } from '../../constants/messages.js';
import { KNOWLEDGE_BASE_SETTINGS } from '../../constants/validation.js';
import AgentDocument, { DOCUMENT_STATUSES } from '../../models/AgentDocument.js';
import { logger } from '../../utils/logger.js';
import { getCompanySettings } from '../companySettings.js';
import { chunkBlocks } from './chunking.js';
import { extractBlocksInThread } from './extractionThread.js';
import { FileStoreError, knowledgeFileStore } from './fileStore.js';
import { removeDocumentChunks, indexChunks } from './knowledgeIndexClient.js';
import { TextExtractionError } from './textExtraction.js';

export const PROCESSING_FAILURE_CODES = Object.freeze({
  TOO_MANY_CHUNKS: 'TOO_MANY_CHUNKS',
  FILE_MISSING: 'FILE_MISSING',
  INDEX_UNAVAILABLE: 'INDEX_UNAVAILABLE',
});

/** The file cannot become part of the knowledge base; retrying would not help. */
class UnusableFileError extends Error {
  constructor(code) {
    super(`Document cannot be used: ${code}`);
    this.code = code;
  }
}

/** This worker no longer holds the document. */
class LeaseLostError extends Error {}

const leaseUntil = (now = new Date()) => new Date(now.getTime() + KNOWLEDGE_BASE_SETTINGS.LEASE_MS);
const RELEASED_LEASE = Object.freeze({ owner: null, until: null });
const heldBy = (documentId, workerId) => ({
  _id: documentId,
  status: DOCUMENT_STATUSES.PROCESSING,
  'lease.owner': workerId,
});

/** What a FAILED document records: the lead-facing reason, no chunks, no lease. */
const failedFields = (code) => ({
  status: DOCUMENT_STATUSES.FAILED,
  errorMessage: KNOWLEDGE_MESSAGES.PROCESSING_FAILURES[code],
  chunkCount: 0,
  lease: RELEASED_LEASE,
});

/** Marks a document this worker holds as FAILED. */
function failDocument(documentId, workerId, code) {
  return AgentDocument.updateOne(heldBy(documentId, workerId), { $set: failedFields(code) });
}

async function claimDocument(documentId, workerId) {
  const now = new Date();
  return AgentDocument.findOneAndUpdate(
    {
      _id: documentId,
      attempts: { $lt: KNOWLEDGE_BASE_SETTINGS.MAX_ATTEMPTS },
      $or: [
        { status: DOCUMENT_STATUSES.UPLOADED },
        { status: DOCUMENT_STATUSES.PROCESSING, 'lease.until': { $lt: now } },
      ],
    },
    {
      $set: { status: DOCUMENT_STATUSES.PROCESSING, lease: { owner: workerId, until: leaseUntil(now) } },
      $inc: { attempts: 1 },
    },
    { new: true },
  ).lean();
}

/** A document whose attempts ran out while its worker was gone is marked FAILED. */
async function giveUpIfExhausted(documentId) {
  const { modifiedCount } = await AgentDocument.updateOne(
    {
      _id: documentId,
      status: DOCUMENT_STATUSES.PROCESSING,
      'lease.until': { $lt: new Date() },
      attempts: { $gte: KNOWLEDGE_BASE_SETTINGS.MAX_ATTEMPTS },
    },
    { $set: failedFields(PROCESSING_FAILURE_CODES.INDEX_UNAVAILABLE) },
  );
  if (modifiedCount) logger.warn('Knowledge document failed: attempts used up', { documentId });
}

async function evictQuietly(documentId, callContext) {
  try {
    await removeDocumentChunks(documentId, callContext);
  } catch (evictError) {
    // The document is gone or failed; its chunks are evicted again when it is deleted.
    logger.warn('Knowledge chunks could not be evicted yet', { documentId, error: evictError.message });
  }
}

async function chunksOf(document) {
  let content;
  try {
    content = await knowledgeFileStore.readFile(document.fileKey, { expectedSha256: document.contentSha256 });
  } catch (readError) {
    if (readError instanceof FileStoreError) throw new UnusableFileError(PROCESSING_FAILURE_CODES.FILE_MISSING);
    throw readError;
  }
  let blocks;
  try {
    blocks = await extractBlocksInThread(content, document.mimeType);
  } catch (extractionError) {
    if (extractionError instanceof TextExtractionError) throw new UnusableFileError(extractionError.code);
    throw extractionError;
  }
  const chunks = chunkBlocks(blocks);
  if (chunks.length > KNOWLEDGE_BASE_SETTINGS.MAX_CHUNKS_PER_DOCUMENT) {
    throw new UnusableFileError(PROCESSING_FAILURE_CODES.TOO_MANY_CHUNKS);
  }
  return chunks;
}

/**
 * @param {string} documentId
 * @param {{ config: object, workerId: string }} context
 */
export async function runIngestion(documentId, { config, workerId }) {
  const document = await claimDocument(documentId, workerId);
  if (!document) {
    await giveUpIfExhausted(documentId);
    return;
  }
  const callContext = { config, requestId: `knowledge-${documentId}-${document.attempts}` };
  const renewLease = async () => {
    const { matchedCount } = await AgentDocument.updateOne(heldBy(document._id, workerId), {
      $set: { 'lease.until': leaseUntil() },
    });
    if (!matchedCount) throw new LeaseLostError();
  };

  try {
    const chunks = await chunksOf(document);
    const companyId = (await getCompanySettings())._id.toString();
    await renewLease();
    await removeDocumentChunks(document._id, callContext);
    const indexed = await indexChunks({ document, companyId, chunks }, callContext, { beforeEachBatch: renewLease });

    const { matchedCount } = await AgentDocument.updateOne(heldBy(document._id, workerId), {
      $set: {
        status: DOCUMENT_STATUSES.READY,
        chunkCount: indexed,
        errorMessage: null,
        processedAt: new Date(),
        lease: RELEASED_LEASE,
      },
    });
    if (!matchedCount) throw new LeaseLostError();
    logger.info('Knowledge document ready', { documentId, chunks: indexed, attempt: document.attempts });
  } catch (runError) {
    if (runError instanceof LeaseLostError) {
      logger.info('Knowledge document processing stopped: no longer held by this worker', { documentId });
      await evictQuietly(document._id, callContext);
      return;
    }
    if (runError instanceof UnusableFileError) {
      await failDocument(document._id, workerId, runError.code);
      logger.warn('Knowledge document failed', { documentId, reason: runError.code });
      await evictQuietly(document._id, callContext);
      return;
    }
    // The index (or the database) is unreachable: try again, unless the attempts are used up.
    if (document.attempts >= KNOWLEDGE_BASE_SETTINGS.MAX_ATTEMPTS) {
      await failDocument(document._id, workerId, PROCESSING_FAILURE_CODES.INDEX_UNAVAILABLE);
      logger.warn('Knowledge document failed: attempts used up', { documentId, error: runError.message });
      await evictQuietly(document._id, callContext);
      return;
    }
    await AgentDocument.updateOne(heldBy(document._id, workerId), {
      $set: { lease: { owner: null, until: new Date() } },
    });
    throw runError;
  }
}
