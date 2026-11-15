/**
 * An NSK turn waits NSK_TURN_TIMEOUT_MS (a web or stock question runs several tool rounds); other NSK
 * requests keep the client's usual deadline.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sendApiRequest } from './httpClient.js';
import { NSK_TURN_TIMEOUT_MS, requestNskSessions, sendNskMessage } from './nskBotApi.js';

vi.mock('./httpClient.js', () => ({
  sendApiRequest: vi.fn(async () => ({ responseData: { session: { id: 's1' } }, responseMessage: 'NSK replied' })),
}));

describe('NSK request deadlines', () => {
  beforeEach(() => sendApiRequest.mockClear());

  it('gives a turn the long deadline, between the backend’s 90 s and nginx’s 120 s', async () => {
    const result = await sendNskMessage({ message: 'TCS share price?', sessionId: 's1' }, 'csrf');
    expect(result).toEqual({ session: { id: 's1' } });
    expect(sendApiRequest).toHaveBeenCalledWith(
      expect.objectContaining({ endpointPath: '/api/nsk-bot/message', timeoutMs: NSK_TURN_TIMEOUT_MS }),
    );
    expect(NSK_TURN_TIMEOUT_MS).toBeGreaterThan(90_000);
    expect(NSK_TURN_TIMEOUT_MS).toBeLessThan(120_000);
  });

  it('keeps the usual deadline for the other requests', async () => {
    await requestNskSessions();
    expect(sendApiRequest.mock.calls[0][0].timeoutMs).toBeUndefined();
  });
});
