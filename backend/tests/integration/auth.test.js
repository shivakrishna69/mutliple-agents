import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { mongoUnavailableReason, startTestServer, STRONG_PASSWORD } from './testServer.js';

const skipReason = await mongoUnavailableReason();

describe('authentication and sessions', { skip: skipReason ?? false }, () => {
  let testServer;

  before(async () => {
    testServer = await startTestServer();
  });

  after(async () => {
    await testServer?.stop();
  });

  it('signs a new user up as a customer, even when the body asks for another role', async () => {
    const client = testServer.createClient();
    const signupResponse = await client.post('/api/auth/signup', {
      name: 'Asha Rao',
      email: 'Asha.Rao@Example.com',
      password: STRONG_PASSWORD,
      role: 'admin',
    });
    assert.equal(signupResponse.status, 201);
    assert.equal(signupResponse.body.data.user.email, 'asha.rao@example.com');
    assert.equal(signupResponse.body.data.user.role, 'customer');
    assert.equal(signupResponse.body.data.user.password, undefined);
    assert.equal(typeof signupResponse.body.data.csrfToken, 'string');

    const currentUserResponse = await client.get('/api/auth/me');
    assert.equal(currentUserResponse.status, 200);
    assert.equal(currentUserResponse.body.data.user.email, 'asha.rao@example.com');
  });

  it('stores only a password hash', async () => {
    const storedUser = await testServer.database.collection('users').findOne({ email: 'asha.rao@example.com' });
    assert.ok(storedUser.password.startsWith('$2'), 'expected a bcrypt hash');
    assert.notEqual(storedUser.password, STRONG_PASSWORD);
  });

  it('rejects a duplicate email', async () => {
    const duplicateResponse = await testServer.createClient().signup('Asha Again', 'asha.rao@example.com');
    assert.equal(duplicateResponse.status, 400);
    assert.match(duplicateResponse.body.error.message, /already/i);
    assert.equal(await testServer.database.collection('users').countDocuments({ email: 'asha.rao@example.com' }), 1);
  });

  it('gives the same answer for a wrong password and an unknown email', async () => {
    const wrongPasswordResponse = await testServer.createClient().login('asha.rao@example.com', 'Wrong#Pass2026');
    const unknownEmailResponse = await testServer.createClient().login('nobody@example.com', 'Wrong#Pass2026');
    assert.equal(wrongPasswordResponse.status, 401);
    assert.equal(unknownEmailResponse.status, 401);
    assert.equal(wrongPasswordResponse.body.error.message, unknownEmailResponse.body.error.message);
  });

  it('requires a session for protected routes', async () => {
    const anonymousResponse = await testServer.createClient().get('/api/auth/me');
    assert.equal(anonymousResponse.status, 401);
  });

  it('refuses state-changing requests without the CSRF token', async () => {
    const client = testServer.createClient();
    await client.login('asha.rao@example.com');

    const withoutTokenResponse = await client.post('/api/auth/logout', undefined, { sendCsrfToken: false });
    assert.equal(withoutTokenResponse.status, 403);

    const stillSignedInResponse = await client.get('/api/auth/me');
    assert.equal(stillSignedInResponse.status, 200);
  });

  it('revokes the session on logout, so a copied cookie stops working', async () => {
    const client = testServer.createClient();
    await client.login('asha.rao@example.com');
    const copiedCookies = new Map(client.cookies);

    const logoutResponse = await client.post('/api/auth/logout');
    assert.equal(logoutResponse.status, 200);

    const replayingClient = testServer.createClient();
    replayingClient.cookies = copiedCookies;
    const replayResponse = await replayingClient.get('/api/auth/me');
    assert.equal(replayResponse.status, 401);
  });

  it('changes the password only with the current one, then accepts the new one', async () => {
    const client = testServer.createClient();
    await client.login('asha.rao@example.com');
    const newPassword = 'Fresh#Pass2027';

    const wrongCurrentResponse = await client.post('/api/auth/password', {
      currentPassword: 'Wrong#Pass2026',
      newPassword,
    });
    assert.notEqual(wrongCurrentResponse.status, 200);

    const changeResponse = await client.post('/api/auth/password', { currentPassword: STRONG_PASSWORD, newPassword });
    assert.equal(changeResponse.status, 200);

    const newLoginResponse = await testServer.createClient().login('asha.rao@example.com', newPassword);
    assert.equal(newLoginResponse.status, 200);
  });
});
