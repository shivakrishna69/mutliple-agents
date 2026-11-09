/**
 * Signup with email confirmation, password reset, and how both meet invitations, a server without
 * email, and rate limits behind a proxy. Every link is read from the email the backend sent (test
 * mail server) and used through the API, as a person would.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ACCOUNT_EMAIL_MESSAGES,
  PASSWORD_RULE_MESSAGES,
  RATE_LIMIT_MESSAGES,
  VALIDATION_MESSAGES,
} from '../../constants/messages.js';
import { ACCOUNT_EMAIL_SETTINGS, ACCOUNT_LINK_PATHS } from '../../constants/validation.js';
import { EMPLOYMENT_STATUSES, WORK_LOCATION_TYPES } from '../../models/EmployeeProfile.js';
import { insertDepartment, invitationTokenFrom } from './fixtures.js';
import { codeFromEmail, tokenFromEmail } from './mailCatcher.js';
import {
  createSignedInClient,
  endEmailCooldowns,
  latestVerificationToken,
  mongoUnavailableReason,
  startTestServer,
  STRONG_PASSWORD,
  TEST_ADMIN_EMAIL,
  TEST_APP_ORIGIN,
  TEST_MAIL_FROM,
} from './testServer.js';

const skipReason = await mongoUnavailableReason();
const NEW_PASSWORD = 'Brand#New2027';
const COOLDOWN_SECONDS = ACCOUNT_EMAIL_SETTINGS.EMAIL_COOLDOWN_MS / 1000;

const users = (testServer) => testServer.database.collection('users');
const findUser = (testServer, email) => users(testServer).findOne({ email });

function assertCodedError(response, status, code, message) {
  assert.equal(response.status, status, JSON.stringify(response.body));
  assert.equal(response.body.error.code, code);
  assert.equal(response.body.error.message, message);
}

function assertCooldown(response) {
  assertCodedError(response, 429, 'EMAIL_COOLDOWN', ACCOUNT_EMAIL_MESSAGES.EMAIL_COOLDOWN);
  const retryAfterSeconds = response.body.error.context.retryAfterSeconds;
  assert.ok(retryAfterSeconds >= 1 && retryAfterSeconds <= COOLDOWN_SECONDS, `retryAfterSeconds ${retryAfterSeconds}`);
}

describe('confirming the email address', { skip: skipReason ?? false }, () => {
  let testServer;

  before(async () => {
    testServer = await startTestServer();
  });

  after(async () => {
    await testServer?.stop();
  });

  it('keeps an unconfirmed account from signing in, and says why only with the right password', async () => {
    const signup = await testServer.createClient().signup('Lena Fischer', 'lena@example.com');
    assert.equal(signup.status, 202);
    assert.equal(signup.body.message, ACCOUNT_EMAIL_MESSAGES.SIGNUP_CHECK_EMAIL);
    assert.equal(signup.body.data.resendAfterSeconds, COOLDOWN_SECONDS);
    assert.equal((await findUser(testServer, 'lena@example.com')).status, 'unverified');

    const wrongPassword = await testServer.createClient().login('lena@example.com', 'Wrong#Pass2026');
    const unknownEmail = await testServer.createClient().login('nobody@example.com', 'Wrong#Pass2026');
    assert.equal(wrongPassword.status, 401);
    assert.equal(wrongPassword.body.error.message, unknownEmail.body.error.message);

    const rightPassword = await testServer.createClient().login('lena@example.com');
    assertCodedError(rightPassword, 403, 'EMAIL_NOT_VERIFIED', ACCOUNT_EMAIL_MESSAGES.EMAIL_NOT_VERIFIED);
  });

  it('answers a resend within the minute with 429, Retry-After and the wait, for any address alike', async () => {
    const tooSoon = await testServer
      .createClient()
      .post('/api/auth/verify-email/resend', { email: 'lena@example.com' });
    assertCooldown(tooSoon);

    // The wait is also in the Retry-After header.
    const retryAfterHeader = await fetch(`${testServer.baseUrl}/api/auth/verify-email/resend`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: TEST_APP_ORIGIN },
      body: JSON.stringify({ email: 'lena@example.com' }),
    });
    assert.equal(retryAfterHeader.status, 429);
    assert.ok(Number(retryAfterHeader.headers.get('retry-after')) >= 1);

    // An address without an account: the first request is answered like any other, the second waits too.
    const unknownFirst = await testServer
      .createClient()
      .post('/api/auth/verify-email/resend', { email: 'ghost@example.com' });
    assert.equal(unknownFirst.status, 202);
    assert.equal(unknownFirst.body.message, ACCOUNT_EMAIL_MESSAGES.VERIFICATION_RESENT);
    assertCooldown(
      await testServer.createClient().post('/api/auth/verify-email/resend', { email: 'ghost@example.com' }),
    );
    assert.equal(testServer.mailbox.messagesTo('ghost@example.com').length, 0);
  });

  it('sends a new link after the wait, and only the newest link works, once', async () => {
    const firstToken = await latestVerificationToken(testServer, 'lena@example.com', 1);
    await endEmailCooldowns(testServer);
    const resend = await testServer.createClient().post('/api/auth/verify-email/resend', { email: 'lena@example.com' });
    assert.equal(resend.status, 202);
    assert.equal(resend.body.message, ACCOUNT_EMAIL_MESSAGES.VERIFICATION_RESENT);
    const newestToken = await latestVerificationToken(testServer, 'lena@example.com', 2);
    assert.notEqual(newestToken, firstToken);

    const revoked = await testServer.createClient().post('/api/auth/verify-email', { token: firstToken });
    assertCodedError(revoked, 400, 'VERIFICATION_LINK_INVALID', ACCOUNT_EMAIL_MESSAGES.VERIFICATION_LINK_INVALID);

    const client = testServer.createClient();
    const confirmed = await client.post('/api/auth/verify-email', { token: newestToken });
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.body.message, ACCOUNT_EMAIL_MESSAGES.EMAIL_VERIFIED);
    assert.equal((await client.get('/api/auth/me')).status, 200, 'confirming signs the person in');
    const account = await findUser(testServer, 'lena@example.com');
    assert.equal(account.status, 'active');
    assert.ok(account.emailVerifiedAt instanceof Date);

    const reused = await testServer.createClient().post('/api/auth/verify-email', { token: newestToken });
    assertCodedError(reused, 400, 'VERIFICATION_LINK_INVALID', ACCOUNT_EMAIL_MESSAGES.VERIFICATION_LINK_INVALID);
    assert.equal((await testServer.createClient().login('lena@example.com')).status, 200);
  });

  it('replaces an unconfirmed signup and revokes its earlier links first', async () => {
    assert.equal((await testServer.createClient().signup('Raj', 'raj@example.com')).status, 202);
    const firstToken = await latestVerificationToken(testServer, 'raj@example.com', 1);

    await endEmailCooldowns(testServer);
    const again = await testServer.createClient().signup('Raj Malhotra', 'raj@example.com', NEW_PASSWORD);
    assert.equal(again.status, 202);
    const secondToken = await latestVerificationToken(testServer, 'raj@example.com', 2);
    assert.equal(await users(testServer).countDocuments({ email: 'raj@example.com' }), 1);

    const revoked = await testServer.createClient().post('/api/auth/verify-email', { token: firstToken });
    assertCodedError(revoked, 400, 'VERIFICATION_LINK_INVALID', ACCOUNT_EMAIL_MESSAGES.VERIFICATION_LINK_INVALID);
    assert.equal((await testServer.createClient().post('/api/auth/verify-email', { token: secondToken })).status, 200);

    assert.equal((await findUser(testServer, 'raj@example.com')).name, 'Raj Malhotra');
    assert.equal((await testServer.createClient().login('raj@example.com', STRONG_PASSWORD)).status, 401);
    assert.equal((await testServer.createClient().login('raj@example.com', NEW_PASSWORD)).status, 200);
  });

  it('refuses expired, malformed and missing links with messages from the server', async () => {
    assert.equal((await testServer.createClient().signup('Mira Das', 'mira@example.com')).status, 202);
    const token = await latestVerificationToken(testServer, 'mira@example.com');
    const mira = await findUser(testServer, 'mira@example.com');
    await testServer.database
      .collection('accounttokens')
      .updateMany({ userId: mira._id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });

    const expired = await testServer.createClient().post('/api/auth/verify-email', { token });
    assertCodedError(expired, 400, 'VERIFICATION_LINK_INVALID', ACCOUNT_EMAIL_MESSAGES.VERIFICATION_LINK_INVALID);
    const malformed = await testServer.createClient().post('/api/auth/verify-email', { token: 'not-a-token' });
    assertCodedError(malformed, 400, 'VERIFICATION_LINK_INVALID', ACCOUNT_EMAIL_MESSAGES.VERIFICATION_LINK_INVALID);

    const missing = await testServer.createClient().post('/api/auth/verify-email', {});
    assert.equal(missing.status, 400);
    assert.deepEqual(missing.body.error.details, [{ field: 'token', message: VALIDATION_MESSAGES.TOKEN_REQUIRED }]);
    const badEmail = await testServer.createClient().post('/api/auth/verify-email/resend', { email: 'not-an-email' });
    assert.deepEqual(badEmail.body.error.details, [
      { field: 'email', message: VALIDATION_MESSAGES.EMAIL_FORMAT_INVALID },
    ]);
  });

  it('makes the configured first administrator confirm the email too', async () => {
    assert.equal((await testServer.createClient().signup('Ada Admin', TEST_ADMIN_EMAIL)).status, 202);
    const beforeConfirming = await testServer.createClient().login(TEST_ADMIN_EMAIL);
    assertCodedError(beforeConfirming, 403, 'EMAIL_NOT_VERIFIED', ACCOUNT_EMAIL_MESSAGES.EMAIL_NOT_VERIFIED);

    const token = await latestVerificationToken(testServer, TEST_ADMIN_EMAIL);
    const confirmed = await testServer.createClient().post('/api/auth/verify-email', { token });
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.body.data.user.role, 'admin');
  });

  it('sends a branded email with a link to the app, and stores only the link hash', async () => {
    const [message] = testServer.mailbox.messagesTo('mira@example.com');
    assert.equal(message.from.replaceAll('"', ''), TEST_MAIL_FROM, 'sent from MAIL_FROM');
    assert.match(message.subject, /Test Company/);
    const token = tokenFromEmail(message, ACCOUNT_LINK_PATHS.EMAIL_VERIFICATION);
    assert.ok(message.text.includes(`${TEST_APP_ORIGIN}${ACCOUNT_LINK_PATHS.EMAIL_VERIFICATION}/${token}`));
    assert.ok(message.html.includes(`${TEST_APP_ORIGIN}${ACCOUNT_LINK_PATHS.EMAIL_VERIFICATION}/${token}`));

    const storedTokens = await testServer.database.collection('accounttokens').find({}).toArray();
    assert.ok(storedTokens.length > 0);
    assert.equal(JSON.stringify(storedTokens).includes(token), false, 'the raw token is never stored');
    const raj = await findUser(testServer, 'raj@example.com');
    assert.equal(
      await testServer.database.collection('accounttokens').countDocuments({ userId: raj._id }),
      0,
      'used up',
    );
  });
});

describe('confirming with the code from the email', { skip: skipReason ?? false }, () => {
  let testServer;
  const CODE_DIGITS = ACCOUNT_EMAIL_SETTINGS.VERIFICATION_CODE_DIGITS;
  const MAX_ATTEMPTS = ACCOUNT_EMAIL_SETTINGS.VERIFICATION_CODE_MAX_ATTEMPTS;

  /** The code in the newest confirmation email to `email` (waits for the `count`th email). */
  async function latestCode(email, count = 1) {
    return codeFromEmail((await testServer.mailbox.waitForMessages(email, count)).at(-1), CODE_DIGITS);
  }

  const confirmWithCode = (client, email, code) => client.post('/api/auth/verify-email', { email, code });
  const wrongCodeFor = (code) => String((Number(code) + 1) % 10 ** CODE_DIGITS).padStart(CODE_DIGITS, '0');

  before(async () => {
    testServer = await startTestServer();
  });

  after(async () => {
    await testServer?.stop();
  });

  it('confirms the email and signs in with the code, which then stops working', async () => {
    const signup = await testServer.createClient().signup('Kavya Menon', 'kavya@example.com');
    assert.equal(signup.status, 202);
    assert.equal(signup.body.data.codeDigits, CODE_DIGITS);
    const code = await latestCode('kavya@example.com');

    const client = testServer.createClient();
    const confirmed = await confirmWithCode(client, 'Kavya@Example.com', ` ${code} `);
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    assert.equal(confirmed.body.message, ACCOUNT_EMAIL_MESSAGES.EMAIL_VERIFIED);
    assert.equal((await client.get('/api/auth/me')).status, 200);
    assert.equal((await findUser(testServer, 'kavya@example.com')).status, 'active');

    const again = await confirmWithCode(testServer.createClient(), 'kavya@example.com', code);
    assertCodedError(again, 400, 'VERIFICATION_CODE_INVALID', ACCOUNT_EMAIL_MESSAGES.VERIFICATION_CODE_INVALID);
  });

  it('cancels the code and its link after too many wrong codes', async () => {
    assert.equal((await testServer.createClient().signup('Arjun Rao', 'arjun@example.com')).status, 202);
    const code = await latestCode('arjun@example.com');
    const linkToken = await latestVerificationToken(testServer, 'arjun@example.com');

    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1) {
      const wrong = await confirmWithCode(testServer.createClient(), 'arjun@example.com', wrongCodeFor(code));
      assertCodedError(wrong, 400, 'VERIFICATION_CODE_INVALID', ACCOUNT_EMAIL_MESSAGES.VERIFICATION_CODE_INVALID);
    }
    // The last allowed wrong try cancels everything sent in that email.
    await confirmWithCode(testServer.createClient(), 'arjun@example.com', wrongCodeFor(code));
    const rightButTooLate = await confirmWithCode(testServer.createClient(), 'arjun@example.com', code);
    assertCodedError(
      rightButTooLate,
      400,
      'VERIFICATION_CODE_INVALID',
      ACCOUNT_EMAIL_MESSAGES.VERIFICATION_CODE_INVALID,
    );
    const link = await testServer.createClient().post('/api/auth/verify-email', { token: linkToken });
    assertCodedError(link, 400, 'VERIFICATION_LINK_INVALID', ACCOUNT_EMAIL_MESSAGES.VERIFICATION_LINK_INVALID);

    // A new email brings a new code that works.
    await endEmailCooldowns(testServer);
    assert.equal(
      (await testServer.createClient().post('/api/auth/verify-email/resend', { email: 'arjun@example.com' })).status,
      202,
    );
    const newCode = await latestCode('arjun@example.com', 2);
    assert.equal((await confirmWithCode(testServer.createClient(), 'arjun@example.com', newCode)).status, 200);
  });

  it('allows the right code after a few wrong ones, within the limit', async () => {
    assert.equal((await testServer.createClient().signup('Isha Gupta', 'isha@example.com')).status, 202);
    const code = await latestCode('isha@example.com');
    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1) {
      await confirmWithCode(testServer.createClient(), 'isha@example.com', wrongCodeFor(code));
    }
    assert.equal((await confirmWithCode(testServer.createClient(), 'isha@example.com', code)).status, 200);
  });

  it('keeps only the newest code working after a resend', async () => {
    assert.equal((await testServer.createClient().signup('Dev Patel', 'dev@example.com')).status, 202);
    const firstCode = await latestCode('dev@example.com');
    await endEmailCooldowns(testServer);
    await testServer.createClient().post('/api/auth/verify-email/resend', { email: 'dev@example.com' });
    const secondCode = await latestCode('dev@example.com', 2);
    if (firstCode !== secondCode) {
      const old = await confirmWithCode(testServer.createClient(), 'dev@example.com', firstCode);
      assertCodedError(old, 400, 'VERIFICATION_CODE_INVALID', ACCOUNT_EMAIL_MESSAGES.VERIFICATION_CODE_INVALID);
    }
    assert.equal((await confirmWithCode(testServer.createClient(), 'dev@example.com', secondCode)).status, 200);
  });

  it('answers an unknown address like a wrong code, and asks for the code in the right form', async () => {
    const unknown = await confirmWithCode(testServer.createClient(), 'nobody@example.com', '123456');
    assertCodedError(unknown, 400, 'VERIFICATION_CODE_INVALID', ACCOUNT_EMAIL_MESSAGES.VERIFICATION_CODE_INVALID);

    for (const badCode of ['12345', '1234567', '12a456', 123456, null]) {
      const response = await confirmWithCode(testServer.createClient(), 'kavya@example.com', badCode);
      assert.equal(response.status, 400, String(badCode));
      assert.deepEqual(response.body.error.details, [
        { field: 'code', message: VALIDATION_MESSAGES.VERIFICATION_CODE_FORMAT },
      ]);
    }
  });

  it('stores the code only as a keyed hash', async () => {
    assert.equal((await testServer.createClient().signup('Neha Shah', 'neha@example.com')).status, 202);
    const code = await latestCode('neha@example.com');
    const neha = await findUser(testServer, 'neha@example.com');
    const [stored] = await testServer.database.collection('accounttokens').find({ userId: neha._id }).toArray();
    assert.match(stored.codeHash, /^[0-9a-f]{64}$/);
    assert.equal(JSON.stringify(stored).includes(code), false);
    assert.equal(stored.failedCodeAttempts, 0);
  });
});

describe('resetting a forgotten password', { skip: skipReason ?? false }, () => {
  let testServer;
  let signedInClient;
  let resetToken;

  const forgot = (email) => testServer.createClient().post('/api/auth/password/forgot', { email });
  const latestResetToken = async (email, count) =>
    tokenFromEmail((await testServer.mailbox.waitForMessages(email, count)).at(-1), ACCOUNT_LINK_PATHS.PASSWORD_RESET);

  before(async () => {
    testServer = await startTestServer();
    signedInClient = await createSignedInClient(testServer, { name: 'Priya Nair', email: 'priya@example.com' });
  });

  after(async () => {
    await testServer?.stop();
  });

  it('answers an unknown address like any other, sends nothing, and spaces requests out the same way', async () => {
    const first = await forgot('stranger@example.com');
    assert.equal(first.status, 202);
    assert.equal(first.body.message, ACCOUNT_EMAIL_MESSAGES.PASSWORD_RESET_REQUESTED);
    assertCooldown(await forgot('stranger@example.com'));
    assert.equal(testServer.mailbox.messagesTo('stranger@example.com').length, 0);
  });

  it('emails a reset link the page can check before it is used', async () => {
    const requested = await forgot('priya@example.com');
    assert.equal(requested.status, 202);
    assert.equal(requested.body.message, ACCOUNT_EMAIL_MESSAGES.PASSWORD_RESET_REQUESTED);
    assert.equal(requested.body.data.linkValidMinutes, 15);
    assert.match(requested.body.message, /15 minutes/);
    // 1: the signup confirmation; 2: the reset link.
    resetToken = await latestResetToken('priya@example.com', 2);
    const [, resetEmail] = testServer.mailbox.messagesTo('priya@example.com');
    assert.match(resetEmail.text, /expire in 15 minutes/);

    const check = await testServer.createClient().get(`/api/auth/password/reset/${resetToken}`);
    assert.equal(check.status, 200);
    assert.equal(check.body.message, ACCOUNT_EMAIL_MESSAGES.RESET_LINK_VALID);
    const validForMs = new Date(check.body.data.expiresAt).getTime() - Date.now();
    assert.ok(validForMs > 0 && validForMs <= ACCOUNT_EMAIL_SETTINGS.PASSWORD_RESET_VALIDITY_MS);

    assertCooldown(await forgot('priya@example.com'));
  });

  it('refuses a weak password with the rule broken, and keeps the link usable', async () => {
    const weak = await testServer
      .createClient()
      .post('/api/auth/password/reset', { token: resetToken, password: 'short', confirmPassword: 'short' });
    assert.equal(weak.status, 400);
    assert.deepEqual(weak.body.error.details, [{ field: 'password', message: VALIDATION_MESSAGES.PASSWORD_TOO_SHORT }]);
    const noSymbol = await testServer.createClient().post('/api/auth/password/reset', {
      token: resetToken,
      password: 'NoSymbol2027',
      confirmPassword: 'NoSymbol2027',
    });
    assert.deepEqual(noSymbol.body.error.details, [
      { field: 'password', message: PASSWORD_RULE_MESSAGES.specialCharacter },
    ]);
    const mismatch = await testServer.createClient().post('/api/auth/password/reset', {
      token: resetToken,
      password: NEW_PASSWORD,
      confirmPassword: 'Other#Pass2027',
    });
    assert.deepEqual(mismatch.body.error.details, [
      { field: 'confirmPassword', message: VALIDATION_MESSAGES.PASSWORDS_DO_NOT_MATCH },
    ]);
    assert.equal((await testServer.createClient().get(`/api/auth/password/reset/${resetToken}`)).status, 200);
  });

  it('sets the new password, signs every device out, tells the owner, and uses the link up', async () => {
    assert.equal((await signedInClient.get('/api/auth/me')).status, 200);
    const reset = await testServer
      .createClient()
      .post('/api/auth/password/reset', { token: resetToken, password: NEW_PASSWORD, confirmPassword: NEW_PASSWORD });
    assert.equal(reset.status, 200);
    assert.equal(reset.body.message, ACCOUNT_EMAIL_MESSAGES.PASSWORD_RESET_DONE);

    assert.equal((await signedInClient.get('/api/auth/me')).status, 401, 'existing sessions end');
    assert.equal((await testServer.createClient().login('priya@example.com', STRONG_PASSWORD)).status, 401);
    assert.equal((await testServer.createClient().login('priya@example.com', NEW_PASSWORD)).status, 200);

    const [, , changedNotice] = await testServer.mailbox.waitForMessages('priya@example.com', 3);
    assert.match(changedNotice.subject, /password was changed/i);

    const reused = await testServer.createClient().post('/api/auth/password/reset', {
      token: resetToken,
      password: STRONG_PASSWORD,
      confirmPassword: STRONG_PASSWORD,
    });
    assertCodedError(reused, 400, 'RESET_LINK_INVALID', ACCOUNT_EMAIL_MESSAGES.RESET_LINK_INVALID);
    const checkAfter = await testServer.createClient().get(`/api/auth/password/reset/${resetToken}`);
    assertCodedError(checkAfter, 400, 'RESET_LINK_INVALID', ACCOUNT_EMAIL_MESSAGES.RESET_LINK_INVALID);
  });

  it('keeps only the newest reset link working', async () => {
    await endEmailCooldowns(testServer);
    assert.equal((await forgot('priya@example.com')).status, 202);
    const olderToken = await latestResetToken('priya@example.com', 4);
    await endEmailCooldowns(testServer);
    assert.equal((await forgot('priya@example.com')).status, 202);
    const newerToken = await latestResetToken('priya@example.com', 5);

    assertCodedError(
      await testServer.createClient().get(`/api/auth/password/reset/${olderToken}`),
      400,
      'RESET_LINK_INVALID',
      ACCOUNT_EMAIL_MESSAGES.RESET_LINK_INVALID,
    );
    assert.equal((await testServer.createClient().get(`/api/auth/password/reset/${newerToken}`)).status, 200);
  });

  it('lets a reset link work once even when it is used twice at the same moment', async () => {
    // The newest link from the test above (5 emails so far: confirmation, reset, changed, two resets).
    const token = await latestResetToken('priya@example.com', 5);
    const useLink = (password) =>
      testServer.createClient().post('/api/auth/password/reset', { token, password, confirmPassword: password });
    const outcomes = await Promise.all([useLink('First#Pass2027'), useLink('Second#Pass2027')]);
    assert.deepEqual(outcomes.map((outcome) => outcome.status).sort(), [200, 400]);
    const winner =
      outcomes.find((outcome) => outcome.status === 200) === outcomes[0] ? 'First#Pass2027' : 'Second#Pass2027';
    assert.equal((await testServer.createClient().login('priya@example.com', winner)).status, 200);
  });

  it('sends an unconfirmed account a confirmation link instead of a reset link', async () => {
    assert.equal((await testServer.createClient().signup('Noor Ali', 'noor@example.com')).status, 202);
    assert.equal((await forgot('noor@example.com')).status, 202);
    const messages = await testServer.mailbox.waitForMessages('noor@example.com', 2);
    assert.ok(messages.every((message) => message.text.includes(ACCOUNT_LINK_PATHS.EMAIL_VERIFICATION)));
    assert.ok(messages.every((message) => !message.text.includes(ACCOUNT_LINK_PATHS.PASSWORD_RESET)));
  });
});

describe('resetting a password with the code from the email', { skip: skipReason ?? false }, () => {
  let testServer;
  const CODE_DIGITS = ACCOUNT_EMAIL_SETTINGS.VERIFICATION_CODE_DIGITS;
  const MAX_ATTEMPTS = ACCOUNT_EMAIL_SETTINGS.VERIFICATION_CODE_MAX_ATTEMPTS;

  /** Asks for a reset, and returns the code and link token of the email it sends (the newest). */
  async function requestReset(email) {
    await endEmailCooldowns(testServer);
    const before = testServer.mailbox.messagesTo(email).length;
    assert.equal((await testServer.createClient().post('/api/auth/password/forgot', { email })).status, 202);
    const resetEmail = (await testServer.mailbox.waitForMessages(email, before + 1)).at(-1);
    return {
      code: codeFromEmail(resetEmail, CODE_DIGITS),
      token: tokenFromEmail(resetEmail, ACCOUNT_LINK_PATHS.PASSWORD_RESET),
      resetEmail,
    };
  }

  const resetWithCode = (email, code, password = NEW_PASSWORD) =>
    testServer.createClient().post('/api/auth/password/reset', { email, code, password, confirmPassword: password });
  const resetWithLink = (token, password = NEW_PASSWORD) =>
    testServer.createClient().post('/api/auth/password/reset', { token, password, confirmPassword: password });
  const checkLink = (token) => testServer.createClient().get(`/api/auth/password/reset/${token}`);
  const wrongCodeFor = (code) => String((Number(code) + 1) % 10 ** CODE_DIGITS).padStart(CODE_DIGITS, '0');
  const assertCodeRefused = (response) =>
    assertCodedError(response, 400, 'RESET_CODE_INVALID', ACCOUNT_EMAIL_MESSAGES.RESET_CODE_INVALID);
  const assertLinkRefused = (response) =>
    assertCodedError(response, 400, 'RESET_LINK_INVALID', ACCOUNT_EMAIL_MESSAGES.RESET_LINK_INVALID);

  // Each group starts its own server: together they use more emailed codes and links from one IP
  // than the per-IP limit (RATE_LIMITS.ACCOUNT_LINK_USES_PER_CLIENT_IP) allows in a window.
  const useOwnServer = () => {
    before(async () => {
      testServer = await startTestServer();
    });
    after(async () => {
      await testServer?.stop();
    });
  };

  describe('using the code', () => {
    useOwnServer();

    it('emails a code and a link together, and the code sets the new password and ends every session', async () => {
      const signedIn = await createSignedInClient(testServer, { name: 'Arjun Das', email: 'arjun@example.com' });
      const { code, resetEmail } = await requestReset('arjun@example.com');
      assert.match(resetEmail.subject, new RegExp(`^${code} is your .+ password reset code$`));
      assert.match(resetEmail.text, /The code and the link work once and expire in 15 minutes/);

      const reset = await resetWithCode('Arjun@Example.com', ` ${code} `);
      assert.equal(reset.status, 200, JSON.stringify(reset.body));
      assert.equal(reset.body.message, ACCOUNT_EMAIL_MESSAGES.PASSWORD_RESET_DONE);
      assert.equal((await signedIn.get('/api/auth/me')).status, 401, 'existing sessions end');
      assert.equal((await testServer.createClient().login('arjun@example.com', NEW_PASSWORD)).status, 200);
    });

    it('expires the link the moment the code is used, and the code cannot be used twice', async () => {
      await createSignedInClient(testServer, { name: 'Bela Roy', email: 'bela@example.com' });
      const { code, token } = await requestReset('bela@example.com');
      assert.equal((await resetWithCode('bela@example.com', code)).status, 200);

      assertLinkRefused(await checkLink(token));
      assertLinkRefused(await resetWithLink(token, 'Other#Pass2027'));
      assertCodeRefused(await resetWithCode('bela@example.com', code, 'Other#Pass2027'));
      assert.equal((await testServer.createClient().login('bela@example.com', NEW_PASSWORD)).status, 200);
    });

    it('expires the code the moment the link is used', async () => {
      await createSignedInClient(testServer, { name: 'Chen Wu', email: 'chen@example.com' });
      const { code, token } = await requestReset('chen@example.com');
      assert.equal((await resetWithLink(token)).status, 200);
      assertCodeRefused(await resetWithCode('chen@example.com', code, 'Other#Pass2027'));
    });
  });

  describe('wrong codes and bad input', () => {
    useOwnServer();

    it(`invalidates both the code and the link after ${MAX_ATTEMPTS} wrong codes`, async () => {
      await createSignedInClient(testServer, { name: 'Dina Shah', email: 'dina@example.com' });
      const { code, token } = await requestReset('dina@example.com');
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        assertCodeRefused(await resetWithCode('dina@example.com', wrongCodeFor(code)));
      }
      assertCodeRefused(await resetWithCode('dina@example.com', code));
      assertLinkRefused(await checkLink(token));
      assertLinkRefused(await resetWithLink(token));
      assert.equal((await testServer.createClient().login('dina@example.com', STRONG_PASSWORD)).status, 200);
    });

    it('keeps the code and link working after fewer wrong codes than the limit', async () => {
      await createSignedInClient(testServer, { name: 'Eli Moss', email: 'eli@example.com' });
      const { code } = await requestReset('eli@example.com');
      for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1) {
        assertCodeRefused(await resetWithCode('eli@example.com', wrongCodeFor(code)));
      }
      assert.equal((await resetWithCode('eli@example.com', code)).status, 200);
    });

    it('keeps only the newest code working', async () => {
      await createSignedInClient(testServer, { name: 'Fay Lim', email: 'fay@example.com' });
      const older = await requestReset('fay@example.com');
      const newer = await requestReset('fay@example.com');
      assertCodeRefused(await resetWithCode('fay@example.com', older.code));
      assertLinkRefused(await checkLink(older.token));
      assert.equal((await resetWithCode('fay@example.com', newer.code)).status, 200);
    });

    it('answers an unknown or unconfirmed address like a wrong code', async () => {
      assertCodeRefused(await resetWithCode('nobody@example.com', '123456'));
      assert.equal((await testServer.createClient().signup('Gia Paul', 'gia@example.com')).status, 202);
      const confirmationCode = codeFromEmail(
        (await testServer.mailbox.waitForMessages('gia@example.com', 1)).at(-1),
        CODE_DIGITS,
      );
      // A confirmation code is not a reset code.
      assertCodeRefused(await resetWithCode('gia@example.com', confirmationCode));
    });

    it('checks the code form and the new password before using the code up', async () => {
      await createSignedInClient(testServer, { name: 'Hari Iyer', email: 'hari@example.com' });
      const { code } = await requestReset('hari@example.com');
      const badForm = await resetWithCode('hari@example.com', '12ab');
      assert.deepEqual(badForm.body.error.details, [
        { field: 'code', message: VALIDATION_MESSAGES.VERIFICATION_CODE_FORMAT },
      ]);
      const weak = await resetWithCode('hari@example.com', code, 'short');
      assert.deepEqual(weak.body.error.details, [
        { field: 'password', message: VALIDATION_MESSAGES.PASSWORD_TOO_SHORT },
      ]);
      const noEmail = await testServer
        .createClient()
        .post('/api/auth/password/reset', { code, password: NEW_PASSWORD, confirmPassword: NEW_PASSWORD });
      assert.deepEqual(noEmail.body.error.details, [{ field: 'email', message: VALIDATION_MESSAGES.EMAIL_REQUIRED }]);
      assert.equal(
        (await resetWithCode('hari@example.com', code)).status,
        200,
        'refused tries did not use the code up',
      );
    });
  });
});

describe('invitations and unconfirmed signups', { skip: skipReason ?? false }, () => {
  let testServer;
  let hrClient;
  let departmentId;

  const invite = (name, email) =>
    hrClient.post('/api/people/invitations', {
      name,
      email,
      role: 'employee',
      designation: 'Analyst',
      departmentId,
      workLocationType: WORK_LOCATION_TYPES.ONSITE,
      dateOfJoining: new Date().toISOString().slice(0, 10),
      employmentStatus: EMPLOYMENT_STATUSES.ACTIVE,
    });

  before(async () => {
    testServer = await startTestServer();
    departmentId = await insertDepartment(testServer.database);
    await createSignedInClient(testServer, { name: 'Ada Admin', email: TEST_ADMIN_EMAIL });
    hrClient = await createSignedInClient(testServer, { name: 'Hema HR', email: 'hema@example.com', role: 'hr' });
  });

  after(async () => {
    await testServer?.stop();
  });

  it('lets HR invite someone whose signup was never confirmed; the invitation confirms the address', async () => {
    assert.equal((await testServer.createClient().signup('Sam', 'sam@example.com')).status, 202);
    const unusedSignupToken = await latestVerificationToken(testServer, 'sam@example.com');

    const invitation = await invite('Sam Joseph', 'sam@example.com');
    assert.equal(invitation.status, 201, JSON.stringify(invitation.body));
    const revoked = await testServer.createClient().post('/api/auth/verify-email', { token: unusedSignupToken });
    assertCodedError(revoked, 400, 'VERIFICATION_LINK_INVALID', ACCOUNT_EMAIL_MESSAGES.VERIFICATION_LINK_INVALID);

    const token = await invitationTokenFrom(testServer, invitation, 'sam@example.com');
    const accepted = await testServer.createClient().post(`/api/invitations/${token}/accept`, {
      password: NEW_PASSWORD,
      confirmPassword: NEW_PASSWORD,
      acceptTerms: true,
    });
    assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
    const account = await findUser(testServer, 'sam@example.com');
    assert.equal(account.status, 'active');
    assert.ok(account.emailVerifiedAt instanceof Date);
    assert.equal(account.name, 'Sam Joseph');
  });

  it('answers a signup with an invited address like any other and leaves the invitation alone', async () => {
    assert.equal((await invite('Tara Singh', 'tara@example.com')).status, 201);
    const signup = await testServer.createClient().signup('Tara', 'tara@example.com');
    assert.equal(signup.status, 202);
    assert.equal(signup.body.message, ACCOUNT_EMAIL_MESSAGES.SIGNUP_CHECK_EMAIL);
    const messages = testServer.mailbox.messagesTo('tara@example.com');
    assert.equal(messages.length, 1, 'only the invitation');
    assert.ok(messages[0].text.includes('/invite/'));
    assert.equal((await findUser(testServer, 'tara@example.com')).status, 'invited');
  });
});

describe('without a mail server', { skip: skipReason ?? false }, () => {
  let testServer;
  const createdAt = new Date('2025-01-15T10:00:00Z');

  before(async () => {
    testServer = await startTestServer({
      mail: false,
      // Accounts from before email confirmation: one in use, one invited.
      seedBeforeStart: async (database) => {
        await database.collection('users').insertMany([
          {
            name: 'Old Timer',
            email: 'old.timer@example.com',
            password: '$2a$04$abcdefghijklmnopqrstuuJ8m9N8Z5lZ1JxV4o5bYyq3m2Q5wQyGa',
            role: 'employee',
            status: 'active',
            createdAt,
            updatedAt: createdAt,
          },
          {
            name: 'Invited Ivy',
            email: 'ivy@example.com',
            role: 'employee',
            status: 'invited',
            createdAt,
            updatedAt: createdAt,
          },
        ]);
      },
    });
  });

  after(async () => {
    await testServer?.stop();
  });

  it('counts accounts that existed before as confirmed, from when they were created', async () => {
    assert.deepEqual((await findUser(testServer, 'old.timer@example.com')).emailVerifiedAt, createdAt);
    assert.equal('emailVerifiedAt' in (await findUser(testServer, 'ivy@example.com')), false, 'confirmed on accepting');
  });

  it('refuses signup and the email requests with 503, creating nothing', async () => {
    const expectUnavailable = (response) =>
      assertCodedError(response, 503, 'EMAIL_UNAVAILABLE', ACCOUNT_EMAIL_MESSAGES.EMAIL_UNAVAILABLE);
    expectUnavailable(await testServer.createClient().signup('Nina', 'nina@example.com'));
    expectUnavailable(
      await testServer.createClient().post('/api/auth/verify-email/resend', { email: 'nina@example.com' }),
    );
    expectUnavailable(
      await testServer.createClient().post('/api/auth/password/forgot', { email: 'old.timer@example.com' }),
    );
    assert.equal(await findUser(testServer, 'nina@example.com'), null);
  });
});

describe('rate limits behind a reverse proxy', { skip: skipReason ?? false }, () => {
  let testServer;

  before(async () => {
    // One proxy in front (like nginx): it appends the real client address to X-Forwarded-For.
    testServer = await startTestServer({ environment: { TRUST_PROXY_HOPS: '1' } });
  });

  after(async () => {
    await testServer?.stop();
  });

  const resendFrom = (forwardedFor, email) =>
    testServer.createClient().request('POST', '/api/auth/verify-email/resend', {
      body: { email },
      headers: { 'X-Forwarded-For': forwardedFor },
    });

  it('counts requests per real client address, whatever the client writes into X-Forwarded-For', async () => {
    const { maxRequests } = (await import('../../constants/rateLimits.js')).RATE_LIMITS
      .ACCOUNT_EMAIL_REQUESTS_PER_CLIENT_IP;
    for (let attempt = 0; attempt < maxRequests; attempt += 1) {
      // A different forged address each time, then the real one the proxy appended.
      const response = await resendFrom(`198.51.100.${attempt}, 203.0.113.7`, `person${attempt}@example.com`);
      assert.equal(response.status, 202, `request ${attempt + 1}`);
    }
    const overBudget = await resendFrom('192.0.2.99, 203.0.113.7', 'one.more@example.com');
    assert.equal(overBudget.status, 429);
    assert.equal(overBudget.body.error.message, RATE_LIMIT_MESSAGES.TOO_MANY_ACCOUNT_EMAIL_REQUESTS);

    const anotherClient = await resendFrom('203.0.113.8', 'someone.else@example.com');
    assert.equal(anotherClient.status, 202, 'another real address has its own budget');
  });
});
