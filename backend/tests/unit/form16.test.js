/**
 * The Form 16 portal's rules without a database: who is eligible (strictly above ₹12,00,000), the
 * financial years offered and their assessment years, the PDF check, and request validation for the
 * upload, the CA's list and the annual CTC editor.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CAPABILITIES, ROLES, assignableRoleDefinitionsFor, hasCapability } from '../../constants/accessRoles.js';
import { FORM16_SETTINGS } from '../../constants/validation.js';
import {
  FORM16_CTC_THRESHOLD,
  assessmentYearOf,
  eligibleProfileFilter,
  isForm16EligibleCtc,
  offeredFinancialYears,
} from '../../services/tax/form16Eligibility.js';
import { isPdfContent } from '../../services/tax/form16Service.js';
import {
  validateCaListQuery,
  validateCompensationChange,
  validateFinancialYearQuery,
  validateForm16Upload,
} from '../../validators/taxValidators.js';

const YEARS = Object.freeze(['2026-27', '2025-26']);
const fieldsOf = (result) => result.validationErrors.map((error) => error.field);

describe('Form 16 eligibility', () => {
  it('is strictly above ₹12,00,000', () => {
    assert.equal(FORM16_CTC_THRESHOLD, 1_200_000);
    assert.equal(isForm16EligibleCtc(1_199_999), false);
    assert.equal(isForm16EligibleCtc(1_200_000), false);
    assert.equal(isForm16EligibleCtc(1_200_001), true);
  });

  it('treats a missing or unreadable CTC as not eligible', () => {
    for (const annualCtc of [null, undefined, Number.NaN, '1500000']) {
      assert.equal(isForm16EligibleCtc(annualCtc), false, String(annualCtc));
    }
  });

  it('filters in the query, with a fresh filter each time', () => {
    const first = eligibleProfileFilter();
    assert.deepEqual(first, { 'compensation.annualCtc': { $gt: 1_200_000 } });
    first['compensation.annualCtc'].$gt = 0;
    assert.equal(eligibleProfileFilter()['compensation.annualCtc'].$gt, 1_200_000);
  });
});

describe('financial years', () => {
  it('offers the current year and the one before, in the company time zone', () => {
    assert.deepEqual(offeredFinancialYears('Asia/Kolkata', new Date('2026-11-20T06:00:00Z')), ['2026-27', '2025-26']);
    // 31 March 20:00 UTC is already 1 April in India.
    assert.deepEqual(offeredFinancialYears('Asia/Kolkata', new Date('2027-03-31T20:00:00Z')), ['2027-28', '2026-27']);
    assert.deepEqual(offeredFinancialYears('UTC', new Date('2027-03-31T20:00:00Z')), ['2026-27', '2025-26']);
    assert.equal(offeredFinancialYears('Asia/Kolkata').length, FORM16_SETTINGS.FINANCIAL_YEARS_OFFERED);
  });

  it('assesses a year in the year after it, across a century', () => {
    assert.equal(assessmentYearOf('2025-26'), '2026-27');
    assert.equal(assessmentYearOf('2098-99'), '2099-00');
  });
});

describe('the CA role', () => {
  it('has the Form 16 portal and nothing else; admins have it too', () => {
    assert.equal(hasCapability(ROLES.CA, CAPABILITIES.MANAGE_FORM16), true);
    assert.equal(hasCapability(ROLES.ADMIN, CAPABILITIES.MANAGE_FORM16), true);
    for (const capability of Object.values(CAPABILITIES).filter((value) => value !== CAPABILITIES.MANAGE_FORM16)) {
      assert.equal(hasCapability(ROLES.CA, capability), false, capability);
    }
    for (const role of [ROLES.HR, ROLES.FINANCE, ROLES.IT_ADMIN, ROLES.AGENT, ROLES.EMPLOYEE]) {
      assert.equal(hasCapability(role, CAPABILITIES.MANAGE_FORM16), false, role);
      assert.equal(hasCapability(role, CAPABILITIES.USE_EMPLOYEE_WORKSPACE), true, role);
      assert.equal(hasCapability(role, CAPABILITIES.VIEW_OWN_FORM16), true, role);
    }
  });

  it('is given only by an admin', () => {
    const assignable = (role) => assignableRoleDefinitionsFor(role).map((definition) => definition.value);
    assert.ok(assignable(ROLES.ADMIN).includes(ROLES.CA));
    assert.ok(!assignable(ROLES.IT_ADMIN).includes(ROLES.CA));
    assert.ok(!assignable(ROLES.IT_ADMIN).includes(ROLES.ADMIN));
  });
});

describe('PDF check', () => {
  it('accepts bytes that start with %PDF- only', () => {
    assert.equal(isPdfContent(Buffer.from('%PDF-1.7\n...')), true);
    assert.equal(isPdfContent(Buffer.from('hello %PDF-1.7')), false);
    assert.equal(isPdfContent(Buffer.from('%PD')), false);
    assert.equal(isPdfContent(Buffer.alloc(0)), false);
    assert.equal(isPdfContent('%PDF-1.7'), false);
  });
});

describe('Form 16 request validation', () => {
  it('defaults to the newest offered year and refuses any other', () => {
    assert.deepEqual(validateFinancialYearQuery({}, YEARS).sanitizedInput, { financialYear: '2026-27' });
    assert.equal(validateFinancialYearQuery({ fy: '2025-26' }, YEARS).sanitizedInput.financialYear, '2025-26');
    for (const fy of ['2024-25', '2026', ['2026-27']]) {
      assert.deepEqual(fieldsOf(validateFinancialYearQuery({ fy }, YEARS)), ['fy']);
    }
  });

  it('checks the list search and status', () => {
    const valid = validateCaListQuery({ fy: '2026-27', search: '  rahul ', status: 'pending' }, YEARS);
    assert.deepEqual(valid.sanitizedInput, { financialYear: '2026-27', search: 'rahul', status: 'pending' });
    assert.equal(validateCaListQuery({ search: '   ' }, YEARS).sanitizedInput.search, null);
    const invalid = validateCaListQuery(
      { search: 'x'.repeat(FORM16_SETTINGS.SEARCH_MAX_LENGTH + 1), status: 'done' },
      YEARS,
    );
    assert.deepEqual(fieldsOf(invalid).sort(), ['search', 'status']);
  });

  it('reads the upload fields and the computation summary JSON', () => {
    const result = validateForm16Upload(
      {
        financialYear: '2025-26',
        partType: 'PART_B',
        computationSummary: JSON.stringify({
          grossSalary: 1850000.456,
          totalDeductions: 75000,
          taxableIncome: 1775000,
          totalTaxPayable: 210000,
          tdsDeducted: 210000,
          taxRegime: 'new',
          caRemarks: '  Verified against Form 26AS  ',
        }),
      },
      YEARS,
    );
    assert.equal(result.isValid, true);
    assert.deepEqual(result.sanitizedInput, {
      financialYear: '2025-26',
      partType: 'PART_B',
      computationSummary: {
        grossSalary: 1850000.46,
        totalDeductions: 75000,
        taxableIncome: 1775000,
        totalTaxPayable: 210000,
        tdsDeducted: 210000,
        taxRegime: 'new',
        caRemarks: 'Verified against Form 26AS',
      },
    });
    assert.deepEqual(validateForm16Upload({}, YEARS).sanitizedInput, {
      financialYear: '2026-27',
      partType: 'CONSOLIDATED',
      computationSummary: {},
    });
  });

  it('refuses a bad part, broken JSON, unknown fields, negative amounts and long remarks', () => {
    assert.deepEqual(fieldsOf(validateForm16Upload({ partType: 'PART_C' }, YEARS)), ['partType']);
    assert.deepEqual(fieldsOf(validateForm16Upload({ computationSummary: '{oops' }, YEARS)), ['computationSummary']);
    assert.deepEqual(fieldsOf(validateForm16Upload({ computationSummary: '[1]' }, YEARS)), ['computationSummary']);
    const summary = JSON.stringify({
      grossSalary: -1,
      bonus: 5,
      taxRegime: 'flat',
      caRemarks: 'x'.repeat(FORM16_SETTINGS.REMARKS_MAX_LENGTH + 1),
      tdsDeducted: FORM16_SETTINGS.AMOUNT_MAX + 1,
    });
    assert.deepEqual(fieldsOf(validateForm16Upload({ computationSummary: summary }, YEARS)).sort(), [
      'computationSummary.bonus',
      'computationSummary.caRemarks',
      'computationSummary.grossSalary',
      'computationSummary.taxRegime',
      'computationSummary.tdsDeducted',
    ]);
  });
});

describe('annual CTC validation', () => {
  it('takes whole rupees in range and an optional date', () => {
    const result = validateCompensationChange({ annualCtc: 1_500_000, effectiveFrom: '2026-04-01' });
    assert.equal(result.isValid, true);
    assert.equal(result.sanitizedInput.annualCtc, 1_500_000);
    assert.equal(result.sanitizedInput.effectiveFrom.toISOString(), '2026-04-01T00:00:00.000Z');
    assert.equal(validateCompensationChange({ annualCtc: 1_500_000 }).sanitizedInput.effectiveFrom, null);
  });

  it('refuses fractions, out-of-range figures and impossible dates', () => {
    assert.deepEqual(fieldsOf(validateCompensationChange({ annualCtc: 1_500_000.5 })), ['annualCtc']);
    assert.deepEqual(fieldsOf(validateCompensationChange({ annualCtc: 10 })), ['annualCtc']);
    assert.deepEqual(fieldsOf(validateCompensationChange({ annualCtc: '1500000' })), ['annualCtc']);
    assert.deepEqual(fieldsOf(validateCompensationChange({ annualCtc: 1_500_000, effectiveFrom: '2026-02-30' })), [
      'effectiveFrom',
    ]);
    assert.deepEqual(fieldsOf(validateCompensationChange([])), ['body']);
  });
});
