/** Phone numbers as people type them, read into international form, and the picker's countries (utils/phoneNumbers.js). */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { isSupportedPhoneCountry, listPhoneCountries, normalizePhoneNumber } from '../../utils/phoneNumbers.js';

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
      '0123456789', // 10 digits, but no Indian number starts with 1 after the trunk 0
      '98765', // too short for any Indian number
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

  it('reads Indian landlines as well as mobiles', () => {
    assert.equal(normalizePhoneNumber('080 2345 6789'), '+918023456789');
  });

  it('reads a national number as one of the country picked beside it', () => {
    assert.equal(normalizePhoneNumber('(415) 555-2671', 'US'), '+14155552671');
    assert.equal(normalizePhoneNumber('020 7946 0958', 'GB'), '+442079460958');
  });

  it('keeps the country code a number is written with, whatever country was picked', () => {
    assert.equal(normalizePhoneNumber('+91 98765 43210', 'US'), '+919876543210');
  });

  it('refuses a country it does not know', () => {
    for (const country of ['XX', 'in', 'IND', '', null, { $ne: '' }]) {
      assert.equal(normalizePhoneNumber('98765 43210', country), null, JSON.stringify(country));
      assert.equal(isSupportedPhoneCountry(country), false, JSON.stringify(country));
    }
  });
});

describe('listPhoneCountries', () => {
  it('lists every supported country once, by name, with its calling code', () => {
    const countries = listPhoneCountries();
    assert.ok(countries.length > 200);
    assert.deepEqual(
      countries.find((country) => country.code === 'IN'),
      { code: 'IN', name: 'India', callingCode: '91' },
    );
    assert.equal(new Set(countries.map((country) => country.code)).size, countries.length);
    const names = countries.map((country) => country.name);
    assert.deepEqual(
      names,
      [...names].sort((first, second) => first.localeCompare(second, 'en')),
    );
    assert.ok(
      countries.every((country) => isSupportedPhoneCountry(country.code) && /^\d{1,3}$/.test(country.callingCode)),
    );
  });
});
