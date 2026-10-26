import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { mongoUnavailableReason, startTestServer, TEST_APP_ORIGIN } from './testServer.js';

const skipReason = await mongoUnavailableReason();

describe('request ids and the error boundary', { skip: skipReason ?? false }, () => {
  let testServer;

  before(async () => {
    testServer = await startTestServer();
  });

  after(async () => {
    await testServer?.stop();
  });

  it('answers unknown routes with a JSON 404 that carries the request id', async () => {
    const response = await fetch(`${testServer.baseUrl}/api/does-not-exist`);
    const body = await response.json();
    assert.equal(response.status, 404);
    assert.match(body.error.message, /Route not found: GET \/api\/does-not-exist/);
    assert.equal(body.error.requestId, response.headers.get('x-request-id'));
  });

  it('reuses a request id sent by a proxy', async () => {
    const response = await fetch(`${testServer.baseUrl}/api/health`, { headers: { 'X-Request-Id': 'proxy-123' } });
    assert.equal(response.headers.get('x-request-id'), 'proxy-123');
  });

  it('answers malformed JSON with a 400 instead of a server error', async () => {
    const response = await fetch(`${testServer.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: TEST_APP_ORIGIN },
      body: '{"email": ',
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.message, 'Malformed JSON body');
  });
});
