/**
 * Employee ID formatting (services/companySettings.js).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { formatEmployeeCode } from '../../services/companySettings.js';

describe('formatEmployeeCode', () => {
  it('pads the number to the configured digits after the short code', () => {
    assert.equal(formatEmployeeCode({ shortCode: 'NSK', employeeIdDigits: 4 }, 1), 'NSK0001');
    assert.equal(formatEmployeeCode({ shortCode: 'ACME', employeeIdDigits: 6 }, 427), 'ACME000427');
  });

  it('keeps a number longer than the digits whole instead of cutting it', () => {
    assert.equal(formatEmployeeCode({ shortCode: 'NSK', employeeIdDigits: 3 }, 12345), 'NSK12345');
  });
});
