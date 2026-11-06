/**
 * Reads a knowledge base file's text in a thread of its own (services/knowledge/extractionWorker.js),
 * never on the thread that serves the API:
 *
 *   - the thread may use at most KNOWLEDGE_BASE_SETTINGS.EXTRACTION_MAX_HEAP_MB of memory, and is
 *     stopped after EXTRACTION_TIMEOUT_MS, so a hostile or huge file cannot stall or exhaust the API
 *   - one thread per file, ended when the file is read
 *
 * extractBlocksInThread(content, mimeType) → the blocks of services/knowledge/textExtraction.js, or
 * a TextExtractionError (TIMED_OUT and OUT_OF_MEMORY come from here, the others from the reader).
 */

import { Worker } from 'node:worker_threads';
import { KNOWLEDGE_BASE_SETTINGS } from '../../constants/validation.js';
import { EXTRACTION_FAILURES, TextExtractionError } from './textExtraction.js';

const WORKER_URL = new URL('./extractionWorker.js', import.meta.url);
// Below this a thread cannot even start, and V8 then aborts the whole process instead of reporting
// ERR_WORKER_OUT_OF_MEMORY; with at least this much, running out of memory only ends the thread.
export const MIN_THREAD_HEAP_MB = 16;

/**
 * @param {Buffer} content
 * @param {string} mimeType
 * @param {{ timeoutMs?: number, maxHeapMb?: number }} [limits]  tests may tighten them
 */
export function extractBlocksInThread(
  content,
  mimeType,
  {
    timeoutMs = KNOWLEDGE_BASE_SETTINGS.EXTRACTION_TIMEOUT_MS,
    maxHeapMb = KNOWLEDGE_BASE_SETTINGS.EXTRACTION_MAX_HEAP_MB,
  } = {},
) {
  if (!(maxHeapMb >= MIN_THREAD_HEAP_MB)) {
    throw new RangeError(`Text extraction needs at least ${MIN_THREAD_HEAP_MB} MB of heap, not ${maxHeapMb}`);
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const worker = new Worker(WORKER_URL, {
      workerData: { content, mimeType },
      resourceLimits: { maxOldGenerationSizeMb: maxHeapMb },
    });
    const settle = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      outcome();
    };
    const timer = setTimeout(
      () => settle(() => reject(new TextExtractionError(EXTRACTION_FAILURES.TIMED_OUT))),
      timeoutMs,
    );
    worker.once('message', (result) =>
      settle(() =>
        result.ok
          ? resolve(result.blocks)
          : reject(new TextExtractionError(result.code ?? EXTRACTION_FAILURES.CORRUPT, result.detail)),
      ),
    );
    worker.once('error', (threadError) =>
      settle(() =>
        reject(
          new TextExtractionError(
            threadError?.code === 'ERR_WORKER_OUT_OF_MEMORY'
              ? EXTRACTION_FAILURES.OUT_OF_MEMORY
              : EXTRACTION_FAILURES.CORRUPT,
            threadError?.name ?? null,
          ),
        ),
      ),
    );
    worker.once('exit', () =>
      settle(() => reject(new TextExtractionError(EXTRACTION_FAILURES.CORRUPT, 'thread ended without a result'))),
    );
  });
}
