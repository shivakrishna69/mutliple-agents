/**
 * Where uploaded knowledge base documents are processed (services/knowledge/ingestionRunner.js), on
 * the shared durable queue (services/durableQueue.js): a BullMQ queue on REDIS_URL, or this process
 * without Redis. The document's state is in MongoDB and the runner claims it with a lease, so a
 * document handed out twice is processed once. Every KNOWLEDGE_BASE_SETTINGS.SWEEP_INTERVAL_MS the
 * sweep hands out documents still waiting (uploaded just before a restart) and documents whose
 * worker stopped (lease run out; the runner marks them FAILED once their attempts are used up).
 */

import { KNOWLEDGE_BASE_SETTINGS } from '../../constants/validation.js';
import AgentDocument, { DOCUMENT_STATUSES } from '../../models/AgentDocument.js';
import { createDurableQueue } from '../durableQueue.js';
import { runIngestion } from './ingestionRunner.js';

async function findWaitingDocumentIds() {
  const waiting = await AgentDocument.find({
    $or: [
      { status: DOCUMENT_STATUSES.UPLOADED },
      { status: DOCUMENT_STATUSES.PROCESSING, 'lease.until': { $lt: new Date() } },
    ],
  })
    .select('_id')
    .lean();
  return waiting.map((document) => document._id.toString());
}

const ingestionQueue = createDurableQueue({
  queueName: 'knowledge-ingestion',
  jobName: 'ingest',
  dataKey: 'documentId',
  label: 'Knowledge ingestion',
  sweepIntervalMs: KNOWLEDGE_BASE_SETTINGS.SWEEP_INTERVAL_MS,
  findWaitingIds: findWaitingDocumentIds,
  runJob: runIngestion,
  attempts: KNOWLEDGE_BASE_SETTINGS.MAX_ATTEMPTS,
});

/**
 * Starts the queue (with Redis, this instance's worker too) and the sweep.
 * @param {{ redisUrl: string|null, aiServiceUrl: string, aiServiceApiKey: string, aiServiceTimeoutMs: number }} config
 */
export const initKnowledgeIngestionQueue = ingestionQueue.init;

/** Hands an uploaded document to a worker. */
export const dispatchDocumentIngestion = ingestionQueue.dispatch;

export const closeKnowledgeIngestionQueue = ingestionQueue.close;
