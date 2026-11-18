/**
 * Rupee amounts in words, the Indian way (utils/rupeesInWords.js), as the offer letter writes the CTC.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { RUPEES_IN_WORDS_MAX, rupeesInWords } from '../../utils/rupeesInWords.js';

describe('rupees in words', () => {
  it('writes lakh and crore amounts', () => {
    assert.equal(rupeesInWords(1_80_000), 'Rupees One Lakh Eighty Thousand only');
    assert.equal(rupeesInWords(25_00_000), 'Rupees Twenty-Five Lakh only');
    assert.equal(rupeesInWords(25_12_345), 'Rupees Twenty-Five Lakh Twelve Thousand Three Hundred Forty-Five only');
    assert.equal(rupeesInWords(1_00_00_000), 'Rupees One Crore only');
    assert.equal(rupeesInWords(10_00_00_000), 'Rupees Ten Crore only');
    assert.equal(rupeesInWords(250_00_00_000), 'Rupees Two Hundred Fifty Crore only');
  });

  it('writes small amounts and the teens', () => {
    assert.equal(rupeesInWords(0), 'Rupees Zero only');
    assert.equal(rupeesInWords(7), 'Rupees Seven only');
    assert.equal(rupeesInWords(13), 'Rupees Thirteen only');
    assert.equal(rupeesInWords(20), 'Rupees Twenty only');
    assert.equal(rupeesInWords(101), 'Rupees One Hundred One only');
    assert.equal(rupeesInWords(1_019), 'Rupees One Thousand Nineteen only');
  });

  it('refuses what is not whole rupees in range', () => {
    for (const amount of [-1, 1.5, Number.NaN, RUPEES_IN_WORDS_MAX + 1, '100']) {
      assert.throws(() => rupeesInWords(amount), RangeError);
    }
    assert.match(rupeesInWords(RUPEES_IN_WORDS_MAX), /^Rupees Nine Thousand Nine Hundred Ninety-Nine Crore/);
  });
});
