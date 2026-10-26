import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createSignedInClient, mongoUnavailableReason, startTestServer, TEST_ADMIN_EMAIL } from './testServer.js';

const skipReason = await mongoUnavailableReason();

describe('role permissions', { skip: skipReason ?? false }, () => {
  let testServer;
  let adminClient;
  let hrClient;
  let customerClient;

  before(async () => {
    testServer = await startTestServer();
    adminClient = await createSignedInClient(testServer, { name: 'Admin User', email: TEST_ADMIN_EMAIL });
    hrClient = await createSignedInClient(testServer, { name: 'Hema HR', email: 'hema.hr@example.com', role: 'hr' });
    customerClient = await createSignedInClient(testServer, { name: 'Cyrus Customer', email: 'cyrus@example.com' });
  });

  after(async () => {
    await testServer?.stop();
  });

  it('makes the bootstrap email an admin on signup', async () => {
    const currentUserResponse = await adminClient.get('/api/auth/me');
    assert.equal(currentUserResponse.body.data.user.role, 'admin');
  });

  it('lets only admins list users', async () => {
    assert.equal((await adminClient.get('/api/admin/users')).status, 200);
    assert.equal((await hrClient.get('/api/admin/users')).status, 403);
    assert.equal((await customerClient.get('/api/admin/users')).status, 403);
    assert.equal((await testServer.createClient().get('/api/admin/users')).status, 401);
  });

  it('does not let a customer promote themselves', async () => {
    const ownUser = (await customerClient.get('/api/auth/me')).body.data.user;
    const promotionResponse = await customerClient.patch(`/api/admin/users/${ownUser.id}/role`, { role: 'admin' });
    assert.equal(promotionResponse.status, 403);

    const storedUser = await testServer.database.collection('users').findOne({ email: 'cyrus@example.com' });
    assert.equal(storedUser.role, 'customer');
  });

  it('keeps workforce risk analytics to HR and admins', async () => {
    assert.equal((await hrClient.get('/api/analytics/workforce-risk')).status, 200);
    assert.equal((await adminClient.get('/api/analytics/workforce-risk')).status, 200);
    assert.equal((await customerClient.get('/api/analytics/workforce-risk')).status, 403);
  });

  it('keeps onboarding invitations to HR and admins', async () => {
    assert.equal((await hrClient.get('/api/people/invitations')).status, 200);
    assert.equal((await customerClient.get('/api/people/invitations')).status, 403);
  });
});
