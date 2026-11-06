/**
 * Runs in a worker thread started by services/knowledge/extractionThread.js: reads one file's text
 * (services/knowledge/textExtraction.js) and posts the result back. Nothing else runs here.
 */

import { parentPort, workerData } from 'node:worker_threads';
import { TextExtractionError, extractBlocks } from './textExtraction.js';

try {
  const blocks = await extractBlocks(workerData.content, workerData.mimeType);
  parentPort.postMessage({ ok: true, blocks });
} catch (extractionError) {
  parentPort.postMessage(
    extractionError instanceof TextExtractionError
      ? { ok: false, code: extractionError.code, detail: extractionError.detail }
      : { ok: false, code: null, detail: extractionError?.name ?? 'Error' },
  );
}
