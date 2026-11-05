import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { VALIDATION_MESSAGES } from '../../constants/messages.js';
import { TERMS_VERSION } from '../../constants/validation.js';
import {
  createSignedInClient,
  endEmailCooldowns,
  latestVerificationToken,
  mongoUnavailableReason,
  startTestServer,
  STRONG_PASSWORD,
  TEST_APP_ORIGIN,
} from './testServer.js';

const skipReason = await mongoUnavailableReason();

describe('authentication and sessions', { skip: skipReason ?? false }, () => {
  let testServer;

  before(async () => {
    testServer = await startTestServer();
  });

  after(async () => {
    await testServer?.stop();
  });

  it('signs a new user up as a customer, even when the body asks for another role, once the email is confirmed', async () => {
    const client = testServer.createClient();
    const signupResponse = await client.signup('Asha Rao', 'Asha.Rao@Example.com', STRONG_PASSWORD, { role: 'admin' });
    assert.equal(signupResponse.status, 202);
    assert.equal(signupResponse.body.data.email, 'asha.rao@example.com');
    assert.equal(signupResponse.body.data.csrfToken, undefined, 'no session before the email is confirmed');
    assert.equal((await client.get('/api/auth/me')).status, 401);

    const token = await latestVerificationToken(testServer, 'asha.rao@example.com');
    const confirmResponse = await client.post('/api/auth/verify-email', { token });
    assert.equal(confirmResponse.status, 200);
    assert.equal(confirmResponse.body.data.user.email, 'asha.rao@example.com');
    assert.equal(confirmResponse.body.data.user.role, 'customer');
    assert.equal(confirmResponse.body.data.user.password, undefined);
    assert.equal(typeof confirmResponse.body.data.csrfToken, 'string');

    const currentUserResponse = await client.get('/api/auth/me');
    assert.equal(currentUserResponse.status, 200);
    assert.equal(currentUserResponse.body.data.user.email, 'asha.rao@example.com');
  });

  it('stores the signup details: first and last name, the phone in international form, the terms accepted', async () => {
    const stored = await testServer.database.collection('users').findOne({ email: 'asha.rao@example.com' });
    assert.equal(stored.firstName, 'Asha');
    assert.equal(stored.lastName, 'Rao');
    assert.equal(stored.name, 'Asha Rao');
    assert.equal(stored.phoneNumber, '+919876543210');
    assert.equal(stored.phoneVerifiedAt, null);
    assert.equal(stored.termsVersion, TERMS_VERSION);
    assert.ok(stored.termsAcceptedAt instanceof Date);
  });

  it('names every missing or unusable signup field, with messages from the server', async () => {
    const empty = await testServer.createClient().post('/api/auth/signup', {});
    assert.equal(empty.status, 400);
    assert.deepEqual(Object.fromEntries(empty.body.error.details.map(({ field, message }) => [field, message])), {
      firstName: VALIDATION_MESSAGES.FIRST_NAME_REQUIRED,
      lastName: VALIDATION_MESSAGES.LAST_NAME_REQUIRED,
      email: VALIDATION_MESSAGES.EMAIL_REQUIRED,
      phoneNumber: VALIDATION_MESSAGES.PHONE_REQUIRED,
      password: VALIDATION_MESSAGES.PASSWORD_REQUIRED,
      acceptTerms: VALIDATION_MESSAGES.TERMS_NOT_ACCEPTED,
    });

    const unusable = await testServer
      .createClient()
      .signup('Ravi Kumar', 'ravi@example.com', STRONG_PASSWORD, { phoneNumber: '12345', acceptTerms: 'yes' });
    assert.equal(unusable.status, 400);
    assert.deepEqual(unusable.body.error.details, [
      { field: 'phoneNumber', message: VALIDATION_MESSAGES.PHONE_INVALID },
      { field: 'acceptTerms', message: VALIDATION_MESSAGES.TERMS_NOT_ACCEPTED },
    ]);
    assert.equal(await testServer.database.collection('users').countDocuments({ email: 'ravi@example.com' }), 0);
  });

  it('stores only a password hash', async () => {
    const storedUser = await testServer.database.collection('users').findOne({ email: 'asha.rao@example.com' });
    assert.ok(storedUser.password.startsWith('$2'), 'expected a bcrypt hash');
    assert.notEqual(storedUser.password, STRONG_PASSWORD);
  });

  it('answers a signup with a registered email like any other, and emails the owner instead', async () => {
    await endEmailCooldowns(testServer);
    const duplicateResponse = await testServer.createClient().signup('Asha Again', 'asha.rao@example.com');
    assert.equal(duplicateResponse.status, 202);
    const [, ownerNotice] = await testServer.mailbox.waitForMessages('asha.rao@example.com', 2);
    assert.match(ownerNotice.subject, /already have/i);
    assert.equal(await testServer.database.collection('users').countDocuments({ email: 'asha.rao@example.com' }), 1);
    const storedUser = await testServer.database.collection('users').findOne({ email: 'asha.rao@example.com' });
    assert.equal(storedUser.name, 'Asha Rao', 'a confirmed account is never taken over by a signup');
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

  it('keeps a session after the browser closes only when asked to remember the device', async () => {
    const email = 'remy@example.com';
    await createSignedInClient(testServer, { name: 'Remy Dsouza', email });
    const send = (path, body, headers = {}) =>
      fetch(`${testServer.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: TEST_APP_ORIGIN, ...headers },
        body: JSON.stringify(body),
      });
    // Max-Age of each session cookie; null for a browser-session cookie.
    const cookieLifetimes = (response) =>
      response.headers.getSetCookie().map((line) => {
        const maxAge = /;\s*max-age=(\d+)/i.exec(line)?.[1];
        return maxAge === undefined ? null : Number(maxAge);
      });
    const rememberedSeconds = 30 * 24 * 60 * 60;
    const lastsAboutThirtyDays = (seconds) => seconds > rememberedSeconds - 60 && seconds <= rememberedSeconds;

    const plain = await send('/api/auth/login', { email, password: STRONG_PASSWORD });
    assert.equal(plain.status, 200);
    assert.deepEqual(cookieLifetimes(plain), [null, null], 'deleted when the browser closes');

    const remembered = await send('/api/auth/login', { email, password: STRONG_PASSWORD, rememberDevice: true });
    assert.equal(remembered.status, 200);
    assert.ok(cookieLifetimes(remembered).every(lastsAboutThirtyDays), String(cookieLifetimes(remembered)));

    const notABoolean = await send('/api/auth/login', { email, password: STRONG_PASSWORD, rememberDevice: 'true' });
    assert.equal(notABoolean.status, 400);
    assert.deepEqual((await notABoolean.json()).error.details, [
      { field: 'rememberDevice', message: VALIDATION_MESSAGES.REMEMBER_DEVICE_MUST_BE_BOOLEAN },
    ]);

    // Changing the password renews the session; a remembered one stays remembered.
    const { csrfToken } = (await remembered.json()).data;
    const cookies = remembered.headers
      .getSetCookie()
      .map((line) => line.split(';')[0])
      .join('; ');
    const changed = await send(
      '/api/auth/password',
      { currentPassword: STRONG_PASSWORD, newPassword: 'Third#Pass2028' },
      { Cookie: cookies, 'X-CSRF-Token': csrfToken },
    );
    assert.equal(changed.status, 200);
    assert.ok(cookieLifetimes(changed).every(lastsAboutThirtyDays), String(cookieLifetimes(changed)));
  });
});
