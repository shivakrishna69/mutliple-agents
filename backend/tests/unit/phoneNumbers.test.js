/** Phone numbers as people type them, read into international form (utils/phoneNumbers.js). */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { normalizePhoneNumber } from '../../utils/phoneNumbers.js';

describe('normalizePhoneNumber', () => {
  it('reads Indian mobile numbers however they are typed', () => {
    for (const typed of [
      '9876543210',
      '98765 43210',
      '098765-43210',
      '+91 98765 43210',
      '+91-9876543210',
      '0091 9876543210',
      '919876543210',
      '(+91) 98765.43210',
    ]) {
      assert.equal(normalizePhoneNumber(typed), '+919876543210', typed);
    }
  });

  it('keeps numbers from other countries when written with their country code', () => {
    assert.equal(normalizePhoneNumber('+44 20 7946 0958'), '+442079460958');
    assert.equal(normalizePhoneNumber('001 (415) 555-2671'), '+14155552671');
  });

  it('refuses what cannot be a reachable number', () => {
    for (const typed of [
      '',
      '   ',
      '12345',
      '5876543210', // 10 digits, but no Indian mobile starts with 5, and no country code
      '+0 12345678', // country codes never start with 0
      '+91 98765 43210 ext 4',
      '98765+43210',
      '++919876543210',
      '+1234567890123456', // longer than 15 digits
      'call me',
      null,
      9876543210,
      { $ne: '' },
    ]) {
      assert.equal(normalizePhoneNumber(typed), null, JSON.stringify(typed));
    }
  });
});
