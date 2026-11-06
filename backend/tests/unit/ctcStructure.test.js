/**
 * The offer salary structure (services/ctcStructure.js): four salary bands pinned to figures worked
 * out by hand, the policy and statutory variations, refusals, and invariants that must hold to the
 * rupee for any CTC.
 *
 * The pinned bands: new tax regime, Bengaluru (an HRA 50% city), Karnataka professional tax,
 * joining on 1 Dec 2026 (EPF wage ceiling ₹25,000, so PF is capped at ₹3,000 a month), the default
 * policy (Basic 50% of CTC, gratuity outside the CTC).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ONBOARDING_SETTINGS } from '../../constants/validation.js';
import { CtcStructureError, HRA_CITY_KINDS, computeCtcStructure, splitAnnual } from '../../services/ctcStructure.js';
import { PayrollInputError } from '../../utils/payrollCalculator.js';

const POLICY = ONBOARDING_SETTINGS.DEFAULT_COMPENSATION_POLICY;
const BASE_OFFER = Object.freeze({
  taxRegime: 'new',
  workCity: 'Bengaluru',
  professionalTaxState: 'KA',
  gender: null,
  dateOfBirth: new Date('1995-06-15T00:00:00Z'),
  joiningDate: new Date('2026-12-01T00:00:00Z'),
});
const structureFor = (annualCtc, overrides = {}, policy = POLICY) =>
  computeCtcStructure({ ...BASE_OFFER, annualCtc, ...overrides }, policy);

/** Every invariant of a structure, to the rupee. */
function assertInvariants(structure) {
  const { earnings, employerContributions: employer, employeeDeductions: employee, takeHome, annualCtc } = structure;
  const label = `CTC ${annualCtc}`;
  assert.equal(
    earnings.basic.annual + earnings.hra.annual + earnings.specialAllowance.annual,
    earnings.gross.annual,
    label,
  );
  assert.equal(
    earnings.gross.annual + employer.providentFund.annual + employer.esi.annual + employer.gratuity.annual,
    annualCtc,
    label,
  );
  assert.equal(employer.total.annual, employer.providentFund.annual + employer.esi.annual + employer.gratuity.annual);
  assert.equal(
    employee.total.annual,
    employee.providentFund.annual + employee.esi.annual + employee.professionalTax.annual + employee.incomeTax.annual,
  );
  assert.equal(takeHome.annual, earnings.gross.annual - employee.total.annual, label);
  const splits = [...Object.values(earnings), ...Object.values(employer), ...Object.values(employee), takeHome];
  for (const split of splits) {
    assert.ok(Number.isInteger(split.annual) && split.annual >= 0, `${label}: ${JSON.stringify(split)}`);
    assert.equal(split.monthly * 12 + split.annualRemainder, split.annual, label);
    assert.ok(split.annualRemainder >= 0 && split.annualRemainder < 12, label);
  }
}

describe('computeCtcStructure: the pinned salary bands', () => {
  // [CTC, Basic, HRA, employer PF, Gross, Special, employee PF, PT, income tax, take-home (annual)]
  const BANDS = [
    [3_00_000, 1_50_000, 75_000, 18_000, 2_82_000, 57_000, 18_000, 0, 0, 2_64_000],
    [10_00_000, 5_00_000, 2_50_000, 36_000, 9_64_000, 2_14_000, 36_000, 2_500, 0, 9_25_500],
    [25_00_000, 12_50_000, 6_25_000, 36_000, 24_64_000, 5_89_000, 36_000, 2_500, 3_09_140, 21_16_360],
    [50_00_000, 25_00_000, 12_50_000, 36_000, 49_64_000, 12_14_000, 36_000, 2_500, 10_88_570, 38_36_930],
  ];

  for (const [ctc, basic, hra, employerPf, gross, special, employeePf, pt, tax, takeHome] of BANDS) {
    it(`splits ₹${ctc.toLocaleString('en-IN')} exactly`, () => {
      const structure = structureFor(ctc);
      assert.deepEqual(
        {
          basic: structure.earnings.basic.annual,
          hra: structure.earnings.hra.annual,
          employerPf: structure.employerContributions.providentFund.annual,
          gross: structure.earnings.gross.annual,
          special: structure.earnings.specialAllowance.annual,
          employeePf: structure.employeeDeductions.providentFund.annual,
          pt: structure.employeeDeductions.professionalTax.annual,
          tax: structure.employeeDeductions.incomeTax.annual,
          takeHome: structure.takeHome.annual,
        },
        { basic, hra, employerPf, gross, special, employeePf, pt, tax, takeHome },
      );
      assert.equal(structure.employerContributions.esi.annual, 0);
      assert.equal(structure.employerContributions.gratuity.annual, 0);
      assertInvariants(structure);
    });
  }

  it('shows the monthly take-home with the rupees left over, never losing them', () => {
    assert.deepEqual(structureFor(3_00_000).takeHome, { annual: 2_64_000, monthly: 22_000, annualRemainder: 0 });
    assert.deepEqual(structureFor(10_00_000).takeHome, { annual: 9_25_500, monthly: 77_125, annualRemainder: 0 });
    assert.deepEqual(structureFor(25_00_000).takeHome, { annual: 21_16_360, monthly: 1_76_363, annualRemainder: 4 });
    assert.deepEqual(structureFor(50_00_000).takeHome, { annual: 38_36_930, monthly: 3_19_744, annualRemainder: 2 });
  });

  it('caps PF at the ceiling in force on the joining date', () => {
    const structure = structureFor(10_00_000);
    assert.equal(structure.providentFund.monthlyWageCeiling, 25_000);
    assert.equal(structure.employerContributions.providentFund.monthly, 3_000);
  });
});

describe('computeCtcStructure: policy and statutory variations', () => {
  it('uses the ₹15,000 PF ceiling (₹1,800 a month) for a joining date before 17 Sep 2026', () => {
    const structure = structureFor(10_00_000, { joiningDate: new Date('2026-08-01T00:00:00Z') });
    assert.equal(structure.providentFund.monthlyWageCeiling, 15_000);
    assert.equal(structure.employerContributions.providentFund.monthly, 1_800);
    assert.equal(structure.employeeDeductions.providentFund.annual, 21_600);
    assertInvariants(structure);
  });

  it('takes PF on the whole Basic when the policy says so', () => {
    const structure = structureFor(10_00_000, {}, { ...POLICY, pfOnFullBasic: true });
    assert.equal(structure.providentFund.monthlyWageCeiling, null);
    // 12% of ₹41,666.67 a month.
    assert.equal(structure.employerContributions.providentFund.monthly, 5_000);
    assertInvariants(structure);
  });

  it('gives 40% HRA outside the 8 cities, and recognises old city names', () => {
    const elsewhere = structureFor(10_00_000, { workCity: 'Coimbatore' });
    assert.equal(elsewhere.hra.cityKind, HRA_CITY_KINDS.OTHER_CITY);
    assert.equal(elsewhere.earnings.hra.annual, 2_00_000);
    assertInvariants(elsewhere);
    assert.equal(structureFor(10_00_000, { workCity: '  bangalore ' }).hra.cityKind, HRA_CITY_KINDS.FIFTY_PERCENT_CITY);
  });

  it('counts gratuity inside the CTC when the policy includes it (15/26 of a month’s Basic a year)', () => {
    const structure = structureFor(10_00_000, {}, { ...POLICY, includeGratuityInCtc: true });
    // 5,00,000 × 15 / 312 = 24,038.46 -> ₹24,038
    assert.equal(structure.employerContributions.gratuity.annual, 24_038);
    assert.equal(structure.earnings.gross.annual, 10_00_000 - 36_000 - 24_038);
    assertInvariants(structure);
  });

  it('adds the employer’s ESI (3.25% of gross) for a gross within ₹21,000 a month', () => {
    const structure = structureFor(2_40_000);
    assert.equal(structure.esiCovered, true);
    const { gross } = structure.earnings;
    const employerEsi = structure.employerContributions.esi.annual;
    assert.ok(Math.abs(employerEsi - gross.annual * 0.0325) < 1, `${employerEsi} vs 3.25% of ${gross.annual}`);
    assert.ok(structure.employeeDeductions.esi.annual > 0);
    assertInvariants(structure);
  });

  it('applies the old regime and Maharashtra’s professional tax by gender', () => {
    const old = structureFor(10_00_000, { taxRegime: 'old' });
    assert.equal(old.taxRegime, 'old');
    assert.ok(old.employeeDeductions.incomeTax.annual > 0);
    assertInvariants(old);
    const maharashtra = (gender, ctc) =>
      structureFor(ctc, { professionalTaxState: 'MH', workCity: 'Mumbai', gender }).employeeDeductions.professionalTax;
    // ₹22,500 gross a month: nil for women up to ₹25,000, ₹200 (₹300 in February) for men.
    assert.equal(maharashtra('female', 2_87_000).annual, 0);
    assert.equal(maharashtra('male', 2_87_000).annual, 2_500);
    assert.throws(() => maharashtra(null, 2_87_000), PayrollInputError);
  });

  it('takes no professional tax where the state levies none', () => {
    assert.equal(
      structureFor(10_00_000, { professionalTaxState: 'NONE' }).employeeDeductions.professionalTax.annual,
      0,
    );
  });

  it('refuses a CTC that cannot cover the policy’s Basic, HRA and employer contributions', () => {
    const heavyPolicy = { ...POLICY, basicShareBasisPoints: 7_000, hraFiftyPercentCityBasisPoints: 5_000 };
    assert.throws(
      () => structureFor(3_00_000, {}, heavyPolicy),
      (error) => error instanceof CtcStructureError && error.code === 'CTC_TOO_LOW',
    );
  });
});

describe('computeCtcStructure: no rounding leaks', () => {
  it('accounts for every rupee of a CTC that does not divide by 12', () => {
    for (const ctc of [10_00_001, 7_77_777, 12_34_567]) assertInvariants(structureFor(ctc));
  });

  it('holds every invariant for 500 random CTCs between ₹2.5 lakh and ₹2 crore', () => {
    // A fixed-seed generator, so a failure can be reproduced.
    let seed = 20261106;
    const next = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    const cities = ['Bengaluru', 'Pune', 'Jaipur', 'Kochi'];
    const states = ['KA', 'NONE'];
    for (let run = 0; run < 500; run += 1) {
      const ctc = 2_50_000 + Math.floor(next() * (2_00_00_000 - 2_50_000));
      const structure = structureFor(ctc, {
        workCity: cities[run % cities.length],
        professionalTaxState: states[run % states.length],
        taxRegime: run % 3 === 0 ? 'old' : 'new',
      });
      assertInvariants(structure);
    }
  });

  it('splits an annual amount into whole monthly rupees and the remainder', () => {
    assert.deepEqual(splitAnnual(1_00_005), { annual: 1_00_005, monthly: 8_333, annualRemainder: 9 });
    assert.deepEqual(splitAnnual(0), { annual: 0, monthly: 0, annualRemainder: 0 });
  });
});
