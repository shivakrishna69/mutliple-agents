/**
 * The computation summary the upload sends (utils/form16.js), and where each person starts
 * (auth/capabilities.js homePathOf): a chartered accountant at the CA portal.
 */

import { describe, expect, it } from 'vitest';
import { homePathOf } from '../auth/capabilities.js';
import { summaryRequestFrom } from './form16.js';

describe('summaryRequestFrom', () => {
  it('sends filled figures as numbers, and the regime and remarks when given', () => {
    expect(
      summaryRequestFrom({
        grossSalary: ' 1850000 ',
        totalDeductions: '',
        taxableIncome: '1775000.5',
        totalTaxPayable: '',
        tdsDeducted: '0',
        taxRegime: 'old',
        caRemarks: '  ok  ',
      }),
    ).toEqual({ grossSalary: 1850000, taxableIncome: 1775000.5, tdsDeducted: 0, taxRegime: 'old', caRemarks: 'ok' });
  });

  it('sends nothing for an empty form, and lets the backend name a figure that is not a number', () => {
    expect(summaryRequestFrom({ taxRegime: '', caRemarks: '   ' })).toEqual({});
    expect(summaryRequestFrom({ grossSalary: '12abc' })).toEqual({ grossSalary: '12abc' });
  });
});

describe('homePathOf', () => {
  it('starts staff at My Access and a chartered accountant at the CA portal', () => {
    expect(homePathOf({ capabilities: ['use_employee_workspace', 'manage_form16'] })).toBe('/my-access');
    expect(homePathOf({ capabilities: ['manage_form16'] })).toBe('/tax/ca-portal');
    expect(homePathOf({ capabilities: [] })).toBe('/account');
    expect(homePathOf(null)).toBe('/account');
  });
});
