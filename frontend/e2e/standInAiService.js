/**
 * A stand-in for the ai-service's leave assistant, for the browser tests (no real model runs in
 * tests). It behaves like the real one where the browser can tell: it reads the employee's real
 * balance through the backend's internal API with the shared key, and drafts a day of Casual Leave
 * for "today" when asked to book. A question containing "unavailable" gets a 503, as when the AI
 * model is down. It also keeps the department knowledge index the way the backend sees it
 * (POST /ai/knowledge/chunks, POST /ai/knowledge/documents/remove: counts only, nothing embedded), so
 * an uploaded document reaches READY. Other ai-service endpoints are not served.
 */

import { createServer } from 'node:http';

export const STAND_IN_TRIGGERS = Object.freeze({ UNAVAILABLE: 'unavailable', BOOK: 'book' });

/**
 * @param {{ backendUrl: () => string, internalApiKey: () => string }} backend  read when a question
 *   arrives, because the backend starts after the stand-in (it needs the stand-in's address)
 * @returns {Promise<{ url: string, close: () => Promise<void> }>}
 */
export async function startStandInAiService(backend) {
  const internalGet = async (path) => {
    const response = await fetch(`${backend.backendUrl()}/api/internal/leave${path}`, {
      headers: { 'X-Internal-Api-Key': backend.internalApiKey() },
    });
    return (await response.json()).data;
  };

  async function answer(question) {
    const message = question.message.toLowerCase();
    if (message.includes(STAND_IN_TRIGGERS.UNAVAILABLE)) return { status: 503, body: { error: 'AI model is down' } };
    const { balances } = await internalGet(`/employees/${question.employee_id}/balances`);
    const casual = balances.find((balance) => balance.leaveType.code === 'CL');
    if (!message.includes(STAND_IN_TRIGGERS.BOOK)) {
      return {
        status: 200,
        body: {
          reply: `You have ${casual.availableDays} days of Casual Leave available.`,
          draft: null,
          tools_used: [],
        },
      };
    }
    return {
      status: 200,
      body: {
        reply: 'Today costs 1 day of Casual Leave. Review the draft and send it when you are ready.',
        draft: {
          leave_type_id: casual.leaveType.id,
          start_date: question.today,
          start_day_portion: 'full',
          end_date: question.today,
          end_day_portion: 'full',
          reason: 'Dentist appointment',
        },
        tools_used: ['price_leave', 'propose_leave_draft'],
      },
    };
  }

  // Chunk numbers indexed per document, as the real index would hold them.
  const indexedChunks = new Map();
  function knowledgeAnswer(path, body) {
    if (path === '/ai/knowledge/chunks') {
      const chunks = indexedChunks.get(body.document_id) ?? new Set();
      for (const chunk of body.chunks) chunks.add(chunk.chunk_index);
      indexedChunks.set(body.document_id, chunks);
      return { status: 200, body: { indexed: body.chunks.length } };
    }
    const removed = indexedChunks.get(body.document_id)?.size ?? 0;
    indexedChunks.delete(body.document_id);
    return { status: 200, body: { removed } };
  }
  const KNOWLEDGE_PATHS = new Set(['/ai/knowledge/chunks', '/ai/knowledge/documents/remove']);

  const server = createServer((request, response) => {
    let rawBody = '';
    request.on('data', (chunk) => {
      rawBody += chunk;
    });
    request.on('end', async () => {
      const isLeaveQuestion = request.method === 'POST' && request.url === '/ai/leave/assistant';
      const isKnowledgeCall = request.method === 'POST' && KNOWLEDGE_PATHS.has(request.url);
      const keyMatches = request.headers['x-internal-api-key'] === backend.internalApiKey();
      const { status, body } =
        !isLeaveQuestion && !isKnowledgeCall
          ? { status: 404, body: { error: 'Not served by the stand-in' } }
          : !keyMatches
            ? { status: 401, body: { error: 'Invalid internal API key' } }
            : isKnowledgeCall
              ? knowledgeAnswer(request.url, JSON.parse(rawBody))
              : await answer(JSON.parse(rawBody));
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(body));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
