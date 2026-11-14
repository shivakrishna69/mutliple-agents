/**
 * A stand-in for the ai-service's NSK turn endpoint (POST /ai/nsk/turn), for backend tests: it
 * records each turn and answers with `standIn.respond(body)`, which may call the backend's tools back
 * with the turn's actor token as the real service does.
 *
 *   const standIn = await startNskStandIn();
 *   standIn.respond = async (body) => ({ body: turnResponse({ ... }) });   // or { status, body }
 *   standIn.turns       every request: { path, body }
 *   callNskTool(testServer, tool, { actorToken, args, key })   a tool call as the ai-service makes it
 */

import { createServer } from 'node:http';

export async function startNskStandIn() {
  const standIn = { turns: [], respond: null };
  const server = createServer((request, response) => {
    let rawBody = '';
    request.on('data', (chunk) => {
      rawBody += chunk;
    });
    request.on('end', async () => {
      const body = rawBody ? JSON.parse(rawBody) : null;
      standIn.turns.push({ path: request.url, body });
      try {
        const { status = 200, body: answer } = await standIn.respond(body);
        response.writeHead(status, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(answer));
      } catch (standInError) {
        response.writeHead(500, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ detail: standInError.message }));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  standIn.url = `http://127.0.0.1:${server.address().port}`;
  standIn.close = () => new Promise((resolve) => server.close(resolve));
  return standIn;
}

export const classification = (intent, sentiment = 'NEUTRAL', extra = {}) => ({
  intent,
  sentiment,
  confidence: 0.9,
  topic: null,
  entities: [],
  ...extra,
});

export const turnResponse = (overrides = {}) => ({
  outcome: 'answered',
  reply: 'Hello! I can help with your attendance, leave and company policies.',
  classification: classification('GENERAL_HELP'),
  sources: [],
  suggestions: [],
  tools_used: [],
  usage: { input_tokens: 120, output_tokens: 30 },
  ...overrides,
});

/** A tool call as the ai-service makes it: { status, body }. */
export async function callNskTool(testServer, tool, { actorToken, args = {}, key = testServer.internalApiKey } = {}) {
  const response = await fetch(`${testServer.baseUrl}/api/internal/nsk/tools/${tool}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { 'X-Internal-Api-Key': key } : {}) },
    body: JSON.stringify({ actor_token: actorToken, arguments: args }),
  });
  return { status: response.status, body: await response.json() };
}

/** The server's log once it holds a line matching `pattern` (its output arrives a moment after the response). */
export async function serverLogMatching(testServer, pattern, { waitMs = 3_000 } = {}) {
  const deadline = Date.now() + waitMs;
  while (!pattern.test(testServer.output()) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return testServer.output();
}
