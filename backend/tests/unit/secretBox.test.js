/**
 * Sealed secrets (utils/secretBox.js).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { openSecret, sealSecret } from '../../utils/secretBox.js';

const serverSecret = 'a'.repeat(64);
const options = { serverSecret, purpose: 'test-links' };

describe('secret box', () => {
  it('opens what it sealed, and seals the same text differently each time', () => {
    const link = 'https://hr.example.com/invite/abc_DEF-123';
    const first = sealSecret(link, options);
    assert.equal(openSecret(first, options), link);
    assert.notEqual(sealSecret(link, options), first);
    assert.equal(first.includes('abc_DEF'), false);
  });

  it('refuses another secret, another purpose, an altered value and garbage', () => {
    const sealed = sealSecret('secret', options);
    assert.equal(openSecret(sealed, { serverSecret: 'b'.repeat(64), purpose: 'test-links' }), null);
    assert.equal(openSecret(sealed, { serverSecret, purpose: 'other' }), null);
    const parts = sealed.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    assert.equal(openSecret(parts.join('.'), options), null);
    assert.equal(openSecret('not sealed', options), null);
  });
});
