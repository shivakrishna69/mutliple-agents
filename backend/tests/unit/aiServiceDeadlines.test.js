/**
 * The ai-service deadlines (services/aiServiceClient.js postToAiService): every call has
 * AI_SERVICE_TIMEOUT_MS, and an NSK turn (services/nskBot/nskTurnClient.js) has NSK_TURN_TIMEOUT_MS
 * instead, so a turn that runs several tool rounds is not cut off at the shorter deadline. Checked
 * against a local server that answers late.
 */

import { once } from 'node:events';
import { createServer } from 'node:http';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { AI_FAILURE_KIND, AiServiceError, postToAiService } from '../../services/aiServiceClient.js';
import { AI_NSK_TURN_PATH, requestNskTurn } from '../../services/nskBot/nskTurnClient.js';

const LATE_MS = 300;

describe('ai-service deadlines', () => {
  let server;
  let config;

  before(async () => {
    server = createServer((request, response) => {
      setTimeout(() => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ path: request.url }));
      }, LATE_MS);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    config = {
      aiServiceUrl: `http://127.0.0.1:${server.address().port}`,
      aiServiceApiKey: 'k'.repeat(32),
      aiServiceTimeoutMs: 100,
      nskTurnTimeoutMs: 2_000,
    };
  });

  after(() => server.close());

  it('times out at AI_SERVICE_TIMEOUT_MS, or at the longer deadline a call asks for', async () => {
    await assert.rejects(
      postToAiService('/ai/process', {}, { config, requestId: 'r1' }, (body) => body),
      (error) => error instanceof AiServiceError && error.failureKind === AI_FAILURE_KIND.TIMEOUT,
    );
    const answered = await postToAiService(
      '/ai/process',
      {},
      { config, requestId: 'r2', timeoutMs: 2_000 },
      (body) => body,
    );
    assert.equal(answered.path, '/ai/process');
  });

  it('gives an NSK turn NSK_TURN_TIMEOUT_MS', async () => {
    // The late answer is not a valid turn: reaching the parser shows the turn was not timed out.
    await assert.rejects(
      requestNskTurn({}, { config, requestId: 'r3' }),
      (error) => error instanceof AiServiceError && error.failureKind === AI_FAILURE_KIND.INVALID_RESPONSE,
    );
    await assert.rejects(
      requestNskTurn({}, { config: { ...config, nskTurnTimeoutMs: 100 }, requestId: 'r4' }),
      (error) => error.failureKind === AI_FAILURE_KIND.TIMEOUT,
    );
    assert.equal(AI_NSK_TURN_PATH, '/ai/nsk/turn');
  });
});
