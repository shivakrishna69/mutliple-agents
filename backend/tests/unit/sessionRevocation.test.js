/**
 * Which sessions a password change ends (services/sessionAuthenticator.js): every session started
 * before it, even earlier in the same second, but not the one started by the change itself.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { wasIssuedBeforePasswordChange } from '../../services/sessionAuthenticator.js';

const changedAt = new Date('2026-11-05T10:00:00.500Z');
const changedAtMs = changedAt.getTime();
const sameSecond = Math.floor(changedAtMs / 1000);

describe('wasIssuedBeforePasswordChange', () => {
  it('ends a session started earlier in the same second as the change', () => {
    assert.equal(
      wasIssuedBeforePasswordChange({ issuedAtSeconds: sameSecond, issuedAtMs: changedAtMs - 200 }, changedAt),
      true,
    );
  });

  it('keeps a session started at or after the change, in the same second', () => {
    assert.equal(
      wasIssuedBeforePasswordChange({ issuedAtSeconds: sameSecond, issuedAtMs: changedAtMs }, changedAt),
      false,
    );
    assert.equal(
      wasIssuedBeforePasswordChange({ issuedAtSeconds: sameSecond, issuedAtMs: changedAtMs + 1 }, changedAt),
      false,
    );
  });

  it('compares older tokens without milliseconds in whole seconds', () => {
    assert.equal(wasIssuedBeforePasswordChange({ issuedAtSeconds: sameSecond - 1, issuedAtMs: null }, changedAt), true);
    assert.equal(wasIssuedBeforePasswordChange({ issuedAtSeconds: sameSecond, issuedAtMs: null }, changedAt), false);
  });

  it('keeps every session of an account whose password never changed', () => {
    assert.equal(wasIssuedBeforePasswordChange({ issuedAtSeconds: 0, issuedAtMs: 0 }, null), false);
  });
});
