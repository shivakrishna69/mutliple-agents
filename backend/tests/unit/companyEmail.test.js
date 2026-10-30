/**
 * Company email local parts (services/companyEmail.js).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { emailLocalPartFromName } from '../../services/companyEmail.js';

describe('emailLocalPartFromName', () => {
  it('joins the first and last names with a dot, without accents or symbols', () => {
    assert.equal(emailLocalPartFromName('Shiva Krishna'), 'shiva.krishna');
    assert.equal(emailLocalPartFromName('  Ádupa K. Rajeshwari '), 'adupa.rajeshwari');
    assert.equal(emailLocalPartFromName("Mary-Jane O'Neil"), 'mary.neil');
  });

  it('keeps a single name and gives null when nothing usable is left', () => {
    assert.equal(emailLocalPartFromName('Mounika'), 'mounika');
    assert.equal(emailLocalPartFromName('李 明'), null);
  });
});
