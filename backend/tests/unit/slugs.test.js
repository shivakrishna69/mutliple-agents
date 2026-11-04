/**
 * URL slugs (utils/slugs.js).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { firstFreeSlug, slugify } from '../../utils/slugs.js';

describe('slugify', () => {
  const options = { maxLength: 20, fallback: 'department' };

  it('lowercases, drops accents and joins words with single hyphens', () => {
    assert.equal(slugify('Data Science & AI', options), 'data-science-ai');
    assert.equal(slugify('  Café -- Ops  ', options), 'cafe-ops');
  });

  it('cuts to the length without leaving a trailing hyphen, and falls back when nothing is left', () => {
    assert.equal(slugify('Platform Engineering Team', options), 'platform-engineering');
    assert.equal(slugify('Platform Engineerin Team', options), 'platform-engineerin');
    assert.equal(slugify('数据', options), 'department');
  });
});

describe('firstFreeSlug', () => {
  it('numbers taken slugs from 2 and keeps them within the length', async () => {
    const taken = new Set(['payroll', 'payroll-2', 'abcdefghij']);
    const isTaken = async (slug) => taken.has(slug);
    assert.equal(await firstFreeSlug('support', { maxLength: 10, isTaken }), 'support');
    assert.equal(await firstFreeSlug('payroll', { maxLength: 10, isTaken }), 'payroll-3');
    assert.equal(await firstFreeSlug('abcdefghij', { maxLength: 10, isTaken }), 'abcdefgh-2');
  });
});
