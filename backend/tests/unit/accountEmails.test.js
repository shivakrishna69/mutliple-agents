/**
 * The account emails (services/accountEmails.js) and the link tokens (utils/secureTokens.js): every
 * value is escaped, each email carries its link in both versions and states how long it works, and
 * tokens have the shape and storage form the services rely on.
 */

import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAccountExistsEmail,
  buildPasswordChangedEmail,
  buildPasswordResetEmail,
  buildVerificationEmail,
  describeDuration,
} from '../../services/accountEmails.js';
import { createSecureToken, hashSecureToken, isWellFormedSecureToken } from '../../utils/secureTokens.js';

const HOSTILE_TEXT = '<script>alert(1)</script> & "quoted"';
const LINK = 'https://hr.example.com/verify-email/abc_DEF-123';

function assertSafeAndLinked(email, url) {
  assert.equal(email.html.includes('<script>'), false, 'interpolated text is escaped');
  assert.equal(email.html.includes(url), true, 'the HTML version has the link');
  assert.equal(email.text.includes(url), true, 'the plain-text version has the link');
  assert.equal(email.text.includes(HOSTILE_TEXT), true, 'plain text keeps the name as typed');
}

describe('describeDuration', () => {
  it('states validity periods in whole hours, or minutes when they are not whole hours', () => {
    assert.equal(describeDuration(24 * 60 * 60 * 1000), '24 hours');
    assert.equal(describeDuration(60 * 60 * 1000), '1 hour');
    assert.equal(describeDuration(30 * 60 * 1000), '30 minutes');
    assert.equal(describeDuration(60 * 1000), '1 minute');
  });
});

describe('account emails', () => {
  it('asks to confirm the address with a code or a link, both working once for the stated time', () => {
    const email = buildVerificationEmail({
      name: HOSTILE_TEXT,
      companyName: 'Acme',
      verificationUrl: LINK,
      verificationCode: '042917',
      validityMs: 24 * 60 * 60 * 1000,
    });
    assertSafeAndLinked(email, LINK);
    assert.equal(email.subject, '042917 is your Acme confirmation code');
    assert.match(email.text, /: 042917$/m);
    assert.ok(email.html.includes('>042917</p>'), 'the code is shown in the HTML version');
    assert.match(email.text, /expire in 24 hours/);
  });

  it('offers a password reset that expires, and says what to do if it was not asked for', () => {
    const resetUrl = 'https://hr.example.com/reset-password/xyz';
    const email = buildPasswordResetEmail({
      name: HOSTILE_TEXT,
      companyName: 'Acme',
      resetUrl,
      validityMs: 60 * 60 * 1000,
    });
    assertSafeAndLinked(email, resetUrl);
    assert.match(email.text, /expires in 1 hour/);
    assert.match(email.text, /didn't ask/);
  });

  it('reports a password change with its time and a way to act on it', () => {
    const signInUrl = 'https://hr.example.com/login';
    const email = buildPasswordChangedEmail({
      name: HOSTILE_TEXT,
      companyName: 'Acme',
      signInUrl,
      changedAt: new Date('2026-11-05T09:30:00Z'),
    });
    assertSafeAndLinked(email, signInUrl);
    assert.match(email.text, /2026-11-05 09:30 UTC/);
  });

  it('tells the owner of an existing account about a signup with their address', () => {
    const forgotPasswordUrl = 'https://hr.example.com/forgot-password';
    const email = buildAccountExistsEmail({
      name: HOSTILE_TEXT,
      companyName: 'Acme',
      signInUrl: 'https://hr.example.com/login',
      forgotPasswordUrl,
    });
    assertSafeAndLinked(email, forgotPasswordUrl);
    assert.match(email.subject, /already have/);
  });
});

describe('link tokens', () => {
  it('are 43 URL-safe characters, unique, and stored as their SHA-256', () => {
    const first = createSecureToken();
    const second = createSecureToken();
    assert.match(first.rawToken, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(first.rawToken, second.rawToken);
    assert.equal(first.tokenHash, createHash('sha256').update(first.rawToken).digest('hex'));
    assert.equal(hashSecureToken(first.rawToken), first.tokenHash);
  });

  it('refuse anything that is not shaped like one before any lookup', () => {
    assert.equal(isWellFormedSecureToken(createSecureToken().rawToken), true);
    for (const value of [
      '',
      'short',
      `${'a'.repeat(43)}=`,
      'a'.repeat(44),
      '../../etc/passwd',
      null,
      42,
      { $ne: '' },
    ]) {
      assert.equal(isWellFormedSecureToken(value), false, JSON.stringify(value));
    }
  });
});
