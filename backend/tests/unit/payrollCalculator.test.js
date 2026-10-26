/**
 * FY 2026-27 tax and statutory deductions. Every expected figure is worked out by hand from the
 * rules documented in utils/payrollCalculator.js, so a failure means the law as coded changed.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { computeTaxLiability, PayrollInputError } from '../../utils/payrollCalculator.js';

const NO_PROFESSIONAL_TAX = { professionalTaxState: 'NONE', isEpfMember: false };

function computeWithoutStatutoryDeductions(salaryStructure, investmentsDeclared = null, regimeChoice = 'new') {
  return computeTaxLiability(salaryStructure, investmentsDeclared, regimeChoice, NO_PROFESSIONAL_TAX);
}

function captureInputError(callback) {
  try {
    callback();
  } catch (error) {
    assert.ok(error instanceof PayrollInputError, `expected PayrollInputError, got ${error?.name}`);
    return error.fieldErrors.map((fieldError) => fieldError.field);
  }
  assert.fail('expected a PayrollInputError');
}

describe('new regime', () => {
  it('rebates the whole tax at exactly ₹12,00,000 taxable income', () => {
    // 12,75,000 gross − 75,000 standard deduction = 12,00,000; slab tax 20,000 + 40,000 = 60,000.
    const { regimes } = computeWithoutStatutoryDeductions({ annualGross: 1_275_000, annualBasic: 600_000 });
    assert.equal(regimes.new.taxableIncome, 1_200_000);
    assert.equal(regimes.new.slabTax, 60_000);
    assert.equal(regimes.new.rebate, 60_000);
    assert.equal(regimes.new.totalTax, 0);
  });

  it('applies rebate marginal relief just above ₹12,00,000', () => {
    // Taxable 12,10,000: slab tax 61,500, but tax may not exceed the 10,000 above the limit; + 4% cess.
    const { regimes } = computeWithoutStatutoryDeductions({ annualGross: 1_285_000, annualBasic: 600_000 });
    assert.equal(regimes.new.taxableIncome, 1_210_000);
    assert.equal(regimes.new.slabTax, 61_500);
    assert.equal(regimes.new.rebateMarginalRelief, 51_500);
    assert.equal(regimes.new.taxAfterRebate, 10_000);
    assert.equal(regimes.new.cess, 400);
    assert.equal(regimes.new.totalTax, 10_400);
  });

  it('limits the 10% surcharge with marginal relief just above ₹50 lakh', () => {
    // Taxable 50,01,000: slab tax 10,80,300; surcharge 1,08,030 is cut so that tax + surcharge
    // (10,81,000) exceeds the tax at 50L (10,80,000) by no more than the 1,000 of extra income.
    const { regimes } = computeWithoutStatutoryDeductions({ annualGross: 5_076_000, annualBasic: 2_000_000 });
    assert.equal(regimes.new.taxableIncome, 5_001_000);
    assert.equal(regimes.new.slabTax, 1_080_300);
    assert.equal(regimes.new.surchargeRatePercent, 10);
    assert.equal(regimes.new.surchargeMarginalRelief, 107_330);
    assert.equal(regimes.new.surcharge, 700);
    assert.equal(regimes.new.cess, 43_240);
    assert.equal(regimes.new.totalTax, 1_124_240);
  });
});

describe('old regime', () => {
  it('taxes ₹12,25,000 at the old slabs with cess', () => {
    // 12,75,000 − 50,000 = 12,25,000; 12,500 + 1,00,000 + 67,500 = 1,80,000; + 7,200 cess.
    const { regimes } = computeWithoutStatutoryDeductions({ annualGross: 1_275_000, annualBasic: 600_000 });
    assert.equal(regimes.old.taxableIncome, 1_225_000);
    assert.equal(regimes.old.slabTax, 180_000);
    assert.equal(regimes.old.totalTax, 187_200);
  });

  it('caps s.123 (80C) investments at ₹1,50,000', () => {
    const { regimes } = computeWithoutStatutoryDeductions(
      { annualGross: 1_275_000, annualBasic: 600_000 },
      { section123Investments: 200_000 },
      'old',
    );
    const section123Line = regimes.old.deductions.find((line) => line.section.startsWith('s.123'));
    assert.equal(section123Line.claimed, 200_000);
    assert.equal(section123Line.allowed, 150_000);
    assert.equal(regimes.old.taxableIncome, 1_075_000);
  });

  it('uses 50% of salary for HRA in Bengaluru (alias "Bangalore") and 40% elsewhere', () => {
    // Basic 6,00,000; HRA received 3,00,000; rent 4,00,000 → rent − 10% of salary = 3,40,000.
    const salaryStructure = { annualGross: 1_200_000, annualBasic: 600_000, annualHraReceived: 300_000 };
    const metro = computeWithoutStatutoryDeductions(salaryStructure, {
      annualRentPaid: 400_000,
      rentedCity: 'Bangalore',
    });
    assert.equal(metro.regimes.old.hraExemption.isFiftyPercentCity, true);
    assert.equal(metro.regimes.old.hraExemption.exemption, 300_000);

    const nonMetro = computeWithoutStatutoryDeductions(salaryStructure, {
      annualRentPaid: 400_000,
      rentedCity: 'Jaipur',
    });
    assert.equal(nonMetro.regimes.old.hraExemption.isFiftyPercentCity, false);
    assert.equal(nonMetro.regimes.old.hraExemption.exemption, 240_000);
  });

  it('gives no HRA exemption under the new regime', () => {
    const { regimes } = computeWithoutStatutoryDeductions(
      { annualGross: 1_200_000, annualBasic: 600_000, annualHraReceived: 300_000 },
      { annualRentPaid: 400_000, rentedCity: 'Mumbai' },
    );
    assert.equal(regimes.new.hraExemption.exemption, 0);
  });
});

describe('regime recommendation', () => {
  it('recommends the cheaper regime and reports the saving', () => {
    const { recommendation, chosenRegime } = computeWithoutStatutoryDeductions(
      { annualGross: 1_275_000, annualBasic: 600_000 },
      null,
      'old',
    );
    assert.equal(recommendation.recommendedRegime, 'new');
    assert.equal(recommendation.annualSavingVersusOtherRegime, 187_200);
    assert.equal(chosenRegime.isMostTaxEfficient, false);
    assert.equal(chosenRegime.additionalTaxVersusRecommended, 187_200);
  });

  it('breaks a tie in favour of the new regime', () => {
    // Both regimes rebate the tax to zero at ₹5,00,000 gross.
    const { regimes, recommendation } = computeWithoutStatutoryDeductions({
      annualGross: 500_000,
      annualBasic: 250_000,
    });
    assert.equal(regimes.old.totalTax, 0);
    assert.equal(regimes.new.totalTax, 0);
    assert.equal(recommendation.recommendedRegime, 'new');
    assert.equal(recommendation.annualSavingVersusOtherRegime, 0);
  });
});

describe('statutory deductions', () => {
  it('splits September 2026 EPF across the ₹15,000 → ₹25,000 wage-ceiling change', () => {
    // Monthly basic 30,000. Apr–Aug: 12% of 15,000 = 1,800 × 5. September: 16 days capped at
    // 8,000 + 14 days capped at 11,666.67 → 12% of 19,666.67 = 2,360. Oct–Mar: 3,000 × 6.
    const { statutoryDeductions } = computeTaxLiability({ annualGross: 600_000, annualBasic: 360_000 }, null, 'new', {
      professionalTaxState: 'NONE',
    });
    const epfByMonth = Object.fromEntries(
      statutoryDeductions.epf.months.map((epfMonth) => [epfMonth.month, epfMonth.employeeContribution]),
    );
    assert.equal(epfByMonth['2026-08'], 1_800);
    assert.equal(epfByMonth['2026-09'], 2_360);
    assert.equal(epfByMonth['2026-10'], 3_000);
    assert.equal(statutoryDeductions.epf.annualEmployeeContribution, 29_360);
  });

  it('charges 0.75% ESI up to ₹21,000 monthly gross and none above', () => {
    const covered = computeWithoutStatutoryDeductions({ annualGross: 240_000, annualBasic: 120_000 });
    assert.equal(covered.statutoryDeductions.esi.isCovered, true);
    assert.equal(covered.statutoryDeductions.esi.months[0].employeeContribution, 150);
    assert.equal(covered.statutoryDeductions.esi.annualEmployeeContribution, 1_800);

    const notCovered = computeWithoutStatutoryDeductions({ annualGross: 252_012, annualBasic: 120_000 });
    assert.equal(notCovered.statutoryDeductions.esi.isCovered, false);
    assert.equal(notCovered.statutoryDeductions.esi.annualEmployeeContribution, 0);
  });

  it('applies Karnataka professional tax of ₹200 a month and ₹300 in February', () => {
    const { statutoryDeductions } = computeTaxLiability({ annualGross: 600_000, annualBasic: 300_000 }, null, 'new', {
      professionalTaxState: 'KA',
      isEpfMember: false,
    });
    const february = statutoryDeductions.professionalTax.months.find((ptMonth) => ptMonth.month === '2027-02');
    assert.equal(february.amount, 300);
    assert.equal(statutoryDeductions.professionalTax.annualAmount, 2_500);
  });

  it('applies the Maharashtra slabs by gender', () => {
    const salaryStructure = { annualGross: 108_000, annualBasic: 60_000 }; // ₹9,000 a month
    const male = computeTaxLiability(salaryStructure, null, 'new', {
      professionalTaxState: 'MH',
      gender: 'male',
      isEpfMember: false,
    });
    assert.equal(male.statutoryDeductions.professionalTax.annualAmount, 2_100);

    const female = computeTaxLiability(salaryStructure, null, 'new', {
      professionalTaxState: 'MH',
      gender: 'female',
      isEpfMember: false,
    });
    assert.equal(female.statutoryDeductions.professionalTax.annualAmount, 0);
  });
});

describe('input validation', () => {
  it('reports every invalid field at once', () => {
    const invalidFields = captureInputError(() =>
      computeTaxLiability({ annualBasic: 100.123 }, null, 'flat', { professionalTaxState: 'TN' }),
    );
    assert.ok(invalidFields.includes('salaryStructure.annualGross'));
    assert.ok(invalidFields.includes('salaryStructure.annualBasic'));
    assert.ok(invalidFields.includes('taxRegimeChoice'));
    assert.ok(invalidFields.includes('employmentDetails.professionalTaxState'));
  });

  it('rejects basic + HRA above gross', () => {
    const invalidFields = captureInputError(() =>
      computeWithoutStatutoryDeductions({ annualGross: 500_000, annualBasic: 400_000, annualHraReceived: 200_000 }),
    );
    assert.deepEqual(invalidFields, ['salaryStructure']);
  });

  it('requires gender for Maharashtra and only accepts FY 2026-27', () => {
    const invalidFields = captureInputError(() =>
      computeTaxLiability({ annualGross: 600_000, annualBasic: 300_000 }, null, 'new', {
        professionalTaxState: 'MH',
        financialYear: '2025-26',
      }),
    );
    assert.ok(invalidFields.includes('employmentDetails.gender'));
    assert.ok(invalidFields.includes('employmentDetails.financialYear'));
  });

  it('requires the rented city when claiming HRA', () => {
    const invalidFields = captureInputError(() =>
      computeWithoutStatutoryDeductions(
        { annualGross: 1_200_000, annualBasic: 600_000, annualHraReceived: 300_000 },
        { annualRentPaid: 400_000 },
      ),
    );
    assert.deepEqual(invalidFields, ['investmentsDeclared.rentedCity']);
  });
});
