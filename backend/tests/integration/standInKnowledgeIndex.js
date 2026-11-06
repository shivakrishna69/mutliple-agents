/**
 * A stand-in for the AI service's knowledge index endpoints (services/knowledge/knowledgeIndexClient.js),
 * for backend tests: it checks the internal API key, keeps chunks by document and chunk number as
 * the real index does (indexing again overwrites), and can be told to fail or to pause.
 *
 *   const index = await startStandInKnowledgeIndex({ apiKey });
 *   index.url                      base URL for config.aiServiceUrl
 *   index.chunksOf(documentId)     the stored chunks of a document, by chunk number
 *   index.requests                 every request: { path, body }
 *   index.failNext(count)          the next `count` requests answer 503
 *   index.pauseNextIndexing()      the next chunks request waits; returns { reached, release }
 *   index.stop()
 */

import { createServer } from 'node:http';

export async function startStandInKnowledgeIndex({ apiKey }) {
  const chunksByDocument = new Map();
  const requests = [];
  let failuresLeft = 0;
  let pause = null;

  const readBody = async (request) => {
    const parts = [];
    for await (const part of request) parts.push(part);
    return JSON.parse(Buffer.concat(parts).toString('utf8') || '{}');
  };
  const reply = (response, status, body) => {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(body));
  };

  const server = createServer(async (request, response) => {
    if (request.headers['x-internal-api-key'] !== apiKey) return reply(response, 401, { detail: 'unauthorized' });
    const body = await readBody(request);
    requests.push({ path: request.url, body });
    if (failuresLeft > 0) {
      failuresLeft -= 1;
      return reply(response, 503, { detail: 'index unavailable' });
    }
    if (request.method === 'POST' && request.url === '/ai/knowledge/chunks') {
      if (pause) {
        const { markReached, released } = pause;
        pause = null;
        markReached();
        await released;
      }
      const stored = chunksByDocument.get(body.document_id) ?? new Map();
      for (const chunk of body.chunks) {
        const { chunks, ...metadata } = body;
        stored.set(chunk.chunk_index, { ...metadata, ...chunk });
      }
      chunksByDocument.set(body.document_id, stored);
      return reply(response, 200, { indexed: body.chunks.length });
    }
    if (request.method === 'POST' && request.url === '/ai/knowledge/documents/remove') {
      const removed = chunksByDocument.get(body.document_id)?.size ?? 0;
      chunksByDocument.delete(body.document_id);
      return reply(response, 200, { removed });
    }
    return reply(response, 404, { detail: 'not found' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    chunksOf: (documentId) => chunksByDocument.get(documentId.toString()) ?? new Map(),
    seedChunk: (documentId, chunkIndex, chunk) => {
      const stored = chunksByDocument.get(documentId.toString()) ?? new Map();
      stored.set(chunkIndex, chunk);
      chunksByDocument.set(documentId.toString(), stored);
    },
    failNext: (count) => {
      failuresLeft = count;
    },
    pauseNextIndexing: () => {
      let markReached;
      let release;
      const reached = new Promise((resolve) => {
        markReached = resolve;
      });
      const released = new Promise((resolve) => {
        release = resolve;
      });
      pause = { markReached, released };
      return { reached, release };
    },
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}
