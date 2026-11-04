/**
 * Presence against the real server (routes/presenceRoutes.js, company settings `presence`): the
 * company's presence settings, and each person's acknowledgement of the notice, without which
 * nothing about their activity is recorded.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { PRESENCE_NOTICE_VERSION } from '../../constants/validation.js';
import { createSignedInClient, mongoUnavailableReason, startTestServer, TEST_ADMIN_EMAIL } from './testServer.js';

const skipReason = await mongoUnavailableReason();

describe('presence', { skip: skipReason ?? false }, () => {
  let testServer;
  let adminClient;
  let employeeClient;

  before(async () => {
    testServer = await startTestServer();
    adminClient = await createSignedInClient(testServer, { name: 'Ada Admin', email: TEST_ADMIN_EMAIL });
    employeeClient = await createSignedInClient(testServer, { name: 'Esha', email: 'esha@example.com' });
  });

  after(async () => {
    await testServer?.stop();
  });

  async function ownSetup(client = employeeClient) {
    const response = await client.get('/api/presence/me');
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body.data.presence;
  }

  async function changePresenceSettings(presence) {
    const { version } = (await adminClient.get('/api/company/settings')).body.data.settings;
    return adminClient.patch('/api/company/settings', { presence, version });
  }

  it('records nothing until the person acknowledges the current notice', async () => {
    const setup = await ownSetup();
    assert.equal(setup.isTracked, false);
    assert.equal(setup.awayAfterMinutes, 5);
    assert.deepEqual(setup.notice, {
      version: PRESENCE_NOTICE_VERSION,
      acknowledgedVersion: null,
      acknowledgedAt: null,
      isAcknowledged: false,
    });

    const older = await employeeClient.post('/api/presence/notice', { version: PRESENCE_NOTICE_VERSION - 1 });
    assert.equal(older.status, 409);
    assert.equal(older.body.error.code, 'NOTICE_OUTDATED');
    assert.equal(
      (await employeeClient.post('/api/presence/notice', { version: String(PRESENCE_NOTICE_VERSION) })).status,
      400,
    );

    const acknowledged = await employeeClient.post('/api/presence/notice', { version: PRESENCE_NOTICE_VERSION });
    assert.equal(acknowledged.status, 200, JSON.stringify(acknowledged.body));
    assert.equal(acknowledged.body.data.presence.isTracked, true);
    assert.ok(acknowledged.body.data.presence.notice.acknowledgedAt);
    assert.equal((await ownSetup(adminClient)).isTracked, false, 'each person acknowledges for themselves');
  });

  it('lets an administrator change the presence settings, one at a time and within limits', async () => {
    const changed = await changePresenceSettings({ awayAfterMinutes: 10 });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.deepEqual(changed.body.data.settings.presence, {
      enabled: true,
      awayAfterMinutes: 10,
      detailRetentionDays: 90,
      summaryRetentionDays: 730,
    });
    assert.equal((await ownSetup()).awayAfterMinutes, 10);

    const invalid = await changePresenceSettings({
      enabled: 'yes',
      awayAfterMinutes: 0,
      detailRetentionDays: 1000,
      summaryRetentionDays: 10.5,
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error.details[0].field, 'presence.enabled');
    const outOfRange = await changePresenceSettings({ awayAfterMinutes: 0, detailRetentionDays: 1000 });
    assert.equal(outOfRange.status, 400);
    assert.deepEqual(outOfRange.body.error.details.map((detail) => detail.field).sort(), [
      'presence.awayAfterMinutes',
      'presence.detailRetentionDays',
    ]);
  });

  it('stops recording for everyone when the company switches presence off', async () => {
    assert.equal((await changePresenceSettings({ enabled: false })).status, 200);
    const setup = await ownSetup();
    assert.equal(setup.enabled, false);
    assert.equal(setup.isTracked, false);
    assert.equal(setup.notice.isAcknowledged, true, 'the acknowledgement is kept for when it is switched on again');
    assert.equal((await changePresenceSettings({ enabled: true })).status, 200);
    assert.equal((await ownSetup()).isTracked, true);
  });
});
