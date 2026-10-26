/**
 * FY 2026-27 rule tables: slabs, rebates, surcharge bands, deduction caps, EPF/ESI/professional tax.
 * The legal basis and sources for every figure are documented in ../payrollCalculator.js.
 */

// =================================================================================================
// Rule tables (FY 2026-27). Rates are integer basis points (1% = 100 bp) so no rate is a binary
// fraction; amounts are rupees.
// =================================================================================================

export const SUPPORTED_FINANCIAL_YEAR = '2026-27';

export const TAX_REGIMES = Object.freeze({ OLD: 'old', NEW: 'new' });

export const AGE_CATEGORIES = Object.freeze({ BELOW_60: 'below60', SENIOR: 'senior', SUPER_SENIOR: 'superSenior' });

/** Slab tables: [upperLimitInclusive (null = no limit), rateBasisPoints]. */
export const NEW_REGIME_SLABS = Object.freeze([
  [400_000, 0],
  [800_000, 500],
  [1_200_000, 1_000],
  [1_600_000, 1_500],
  [2_000_000, 2_000],
  [2_400_000, 2_500],
  [null, 3_000],
]);

export const OLD_REGIME_SLABS_BY_AGE = Object.freeze({
  [AGE_CATEGORIES.BELOW_60]: Object.freeze([
    [250_000, 0],
    [500_000, 500],
    [1_000_000, 2_000],
    [null, 3_000],
  ]),
  [AGE_CATEGORIES.SENIOR]: Object.freeze([
    [300_000, 0],
    [500_000, 500],
    [1_000_000, 2_000],
    [null, 3_000],
  ]),
  [AGE_CATEGORIES.SUPER_SENIOR]: Object.freeze([
    [500_000, 0],
    [1_000_000, 2_000],
    [null, 3_000],
  ]),
});

export const REGIME_RULES = Object.freeze({
  [TAX_REGIMES.NEW]: Object.freeze({
    standardDeduction: 75_000,
    rebateIncomeLimit: 1_200_000,
    maximumRebate: 60_000,
    rebateHasMarginalRelief: true,
    employerNpsCapBasisPoints: 1_400, // 14% of salary (basic + DA)
    // [incomeAbove, surchargeBasisPoints]; capped at 25% under the new regime.
    surchargeBands: Object.freeze([
      [5_000_000, 1_000],
      [10_000_000, 1_500],
      [20_000_000, 2_500],
    ]),
  }),
  [TAX_REGIMES.OLD]: Object.freeze({
    standardDeduction: 50_000,
    rebateIncomeLimit: 500_000,
    maximumRebate: 12_500,
    rebateHasMarginalRelief: false,
    employerNpsCapBasisPoints: 1_000, // 10% of salary (basic + DA), non-government employer
    surchargeBands: Object.freeze([
      [5_000_000, 1_000],
      [10_000_000, 1_500],
      [20_000_000, 2_500],
      [50_000_000, 3_700],
    ]),
  }),
});

export const CESS_BASIS_POINTS = 400; // Health and Education Cess, 4%

export const OLD_REGIME_DEDUCTION_LIMITS = Object.freeze({
  section123Aggregate: 150_000, // 80C + 80CCC + 80CCD(1)
  employeeNpsSalaryCapBasisPoints: 1_000, // 80CCD(1): ≤ 10% of salary, within the ₹1.5L aggregate
  additionalNps: 50_000, // 80CCD(1B)
  healthInsuranceSelfFamily: 25_000,
  healthInsuranceSelfFamilySenior: 50_000,
  healthInsuranceParents: 25_000,
  healthInsuranceParentsSenior: 50_000,
  selfOccupiedHomeLoanInterest: 200_000,
});

/** HRA: 50% of salary in these cities from FY 2026-27 (Income-tax Rules, 2026), 40% elsewhere. */
export const HRA_FIFTY_PERCENT_CITIES = Object.freeze([
  'mumbai',
  'delhi',
  'kolkata',
  'chennai',
  'bengaluru',
  'hyderabad',
  'pune',
  'ahmedabad',
]);
export const HRA_CITY_ALIASES = Object.freeze({
  bangalore: 'bengaluru',
  bombay: 'mumbai',
  calcutta: 'kolkata',
  madras: 'chennai',
  'new delhi': 'delhi',
});

/** EPF statutory wage ceiling over time (monthly wages, basic + DA). */
export const EPF_WAGE_CEILING_SCHEDULE = Object.freeze([
  Object.freeze({ effectiveFrom: '2014-09-01', monthlyCeiling: 15_000 }),
  Object.freeze({ effectiveFrom: '2026-09-17', monthlyCeiling: 25_000 }), // S.O. 5109(E), 17 Sep 2026
]);
export const EPF_EMPLOYEE_RATE_BASIS_POINTS = 1_200; // 12%

export const ESI_RULES = Object.freeze({
  monthlyWageCeiling: 21_000,
  monthlyWageCeilingForPersonsWithDisability: 25_000,
  employeeRateBasisPoints: 75, // 0.75%
  exemptAverageDailyWage: 176,
});

export const PROFESSIONAL_TAX_STATES = Object.freeze({ KARNATAKA: 'KA', MAHARASHTRA: 'MH', NONE: 'NONE' });
export const PROFESSIONAL_TAX_ANNUAL_CAP = 2_500;

/** The months of FY 2026-27, in payroll order. */
export const FINANCIAL_YEAR_MONTHS = Object.freeze(
  [
    [2026, 4],
    [2026, 5],
    [2026, 6],
    [2026, 7],
    [2026, 8],
    [2026, 9],
    [2026, 10],
    [2026, 11],
    [2026, 12],
    [2027, 1],
    [2027, 2],
    [2027, 3],
  ].map(([year, month]) =>
    Object.freeze({
      year,
      month,
      label: `${year}-${String(month).padStart(2, '0')}`,
      daysInMonth: new Date(Date.UTC(year, month, 0)).getUTCDate(),
    }),
  ),
);
