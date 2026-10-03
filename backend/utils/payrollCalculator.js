/**
 * Payroll tax and statutory-deduction calculator for salaried employees in India, Financial Year
 * (tax year) 2026-27, i.e. 1 April 2026 to 31 March 2027.
 *
 * Entry point: computeTaxLiability(salaryStructure, investmentsDeclared, taxRegimeChoice, employmentDetails)
 * It computes BOTH tax regimes for the same inputs and returns a structured comparison with the
 * cheaper regime, the annual saving, and the take-home pay under each.
 *
 * =================================================================================================
 * LEGAL BASIS (verified for FY 2026-27; see SOURCES at the end of this comment)
 * =================================================================================================
 *
 *   Statute: the Income-tax Act, 2025 governs income of tax year 2026-27 onwards (it replaced the
 *   Income-tax Act, 1961 from 1 April 2026). Section numbers below are given as "new (old)", e.g.
 *   "s.123 (80C)". The Union Budget 2026 made NO change to slabs, rates, standard deduction, rebate,
 *   surcharge or cess for FY 2026-27, so the FY 2025-26 figures continue.
 *
 *   NEW regime (default regime; s.202, formerly s.115BAC)
 *     Slabs on total income:   0-4L nil | 4-8L 5% | 8-12L 10% | 12-16L 15% | 16-20L 20% |
 *                              20-24L 25% | above 24L 30%    (same for every age)
 *     Standard deduction:      ₹75,000 (s.19, formerly s.16(ia))
 *     Rebate (s.156, formerly s.87A): tax up to ₹60,000 if total income ≤ ₹12,00,000, plus
 *                              marginal relief: above ₹12L, tax may not exceed the income above ₹12L.
 *     Allowed deductions:      employer's NPS contribution up to 14% of salary (s.124, formerly
 *                              80CCD(2)). Not allowed: HRA exemption, professional tax, s.123 (80C),
 *                              s.126 (80D), home-loan interest on a self-occupied house, 80E, 80CCD(1B).
 *     Surcharge:               10% above ₹50L, 15% above ₹1Cr, 25% above ₹2Cr (capped at 25%).
 *
 *   OLD regime (opt-in)
 *     Slabs:                   0-2.5L nil | 2.5-5L 5% | 5-10L 20% | above 10L 30%
 *                              Basic exemption ₹3,00,000 for residents aged 60-79 (senior) and
 *                              ₹5,00,000 for 80+ (super senior).
 *     Standard deduction:      ₹50,000 (s.19)
 *     Professional tax:        deductible as paid (s.19, formerly s.16(iii))
 *     HRA exemption:           least of (a) HRA received, (b) rent paid − 10% of salary,
 *                              (c) 50% of salary in the 8 notified cities, 40% elsewhere; "salary" =
 *                              basic + dearness allowance. From FY 2026-27 the Income-tax Rules, 2026
 *                              list 8 cities at 50%: Mumbai, Delhi, Kolkata, Chennai, Bengaluru,
 *                              Hyderabad, Pune, Ahmedabad (formerly only the first four).
 *     Deductions:              s.123 (80C/80CCC/80CCD(1) aggregate) ≤ ₹1,50,000, including the
 *                              employee's own EPF; employee NPS under 80CCD(1) also ≤ 10% of salary;
 *                              s.124 (80CCD(1B)) additional NPS ≤ ₹50,000; s.124 (80CCD(2)) employer
 *                              NPS ≤ 10% of salary; s.126 (80D) health insurance ≤ ₹25,000 self/family
 *                              (₹50,000 if self or spouse is a senior) and ≤ ₹25,000 parents (₹50,000
 *                              if a parent is a senior); s.129 (80E) education-loan interest, no cap;
 *                              s.22 (24(b)) interest on a self-occupied home loan ≤ ₹2,00,000.
 *     Rebate (s.156):          tax up to ₹12,500 if total income ≤ ₹5,00,000 (no marginal relief).
 *     Surcharge:               10% above ₹50L, 15% above ₹1Cr, 25% above ₹2Cr, 37% above ₹5Cr.
 *
 *   Both regimes
 *     Marginal relief on surcharge: crossing a surcharge threshold may not raise tax + surcharge by
 *       more than the income above that threshold.
 *     Health and Education Cess: 4% of (tax + surcharge).
 *     Rounding: total income to the nearest ₹10, and the final tax to the nearest ₹10 (formerly
 *       ss.288A / 288B; the same rounding continues under the 2025 Act).
 *
 *   EPF (Employees' Provident Fund; Code on Social Security, 2020 / EPF Scheme)
 *     Employee contribution: 12% of monthly basic + DA, computed on wages up to the statutory wage
 *       ceiling. The ceiling was ₹15,000 until 16 September 2026 and is ₹25,000 from 17 September
 *       2026 (MoLE notification S.O. 5109(E) dated 17 Sep 2026). September 2026 is split by days:
 *       1-16 Sep at the ₹15,000 ceiling, 17-30 Sep at the ₹25,000 ceiling. An employee may contribute
 *       on full basic above the ceiling (voluntary, `epfContributionOnFullBasic`). Contributions are
 *       rounded to the nearest rupee.
 *
 *   ESI (Employees' State Insurance; Code on Social Security, 2020 / ESI Act)
 *     Coverage: gross monthly wages ≤ ₹21,000 (≤ ₹25,000 for persons with disability). Unchanged.
 *     Employee contribution: 0.75% of gross wages, rounded UP to the next whole rupee. Employees whose
 *       average daily wage is ≤ ₹176 pay no employee share (the employer still contributes).
 *     Contribution periods: April-September and October-March. An employee covered at the start of
 *       a period stays covered for the whole period even if wages rise. This calculator assumes
 *       uniform monthly salary, so coverage is the same for every month.
 *
 *   Professional tax (state levy, constitutional cap ₹2,500 per year; Article 276(2))
 *     Karnataka (from 1 April 2025): nil below ₹25,000 gross per month; ₹200 per month at
 *       ₹25,000 and above, ₹300 in February (₹2,500 a year).
 *     Maharashtra: men: nil up to ₹7,500; ₹175 for ₹7,501-₹10,000; ₹200 above ₹10,000 (₹300 in
 *       February). Women: nil up to ₹25,000; ₹200 above (₹300 in February).
 *     Other states have their own slabs and are not modelled; pass "NONE" only when the employee's
 *       state of work levies no professional tax. An unknown state is rejected rather than guessed.
 *
 * =================================================================================================
 * SCOPE AND ASSUMPTIONS
 * =================================================================================================
 *   - Resident individual with income from salary only. Other income (interest, capital gains,
 *     rent) and deductions tied to it (80TTA/80TTB, 80G donations, loss set-off) are out of scope.
 *   - Salary is paid uniformly across the 12 months of the year.
 *   - Employer contributions (EPF, NPS) are assumed within the ₹7,50,000 aggregate tax-free limit.
 *   - The result is an estimate for planning and payroll TDS projection, not a tax return; the
 *     employee's actual liability depends on all their income and proofs.
 *
 * SOURCES (checked October 2026)
 *   Slabs/rebate/standard deduction unchanged by Budget 2026: cleartax.in/s/income-tax-slabs
 *   2025 Act section mapping (s.123, s.124, s.126, s.129, s.156, s.19, s.22, s.202): taxgarden.in
 *   Surcharge rates: taxmann.com/post/blog/tax-rates-surcharge-cess
 *   Income-tax Rules 2026 notified, 8-city HRA: mondaq.com (Income Tax Rules, 2026 Notified)
 *   EPF ceiling ₹25,000 from 17 Sep 2026 (S.O. 5109(E)), ESI ceiling unchanged: caclubindia.com
 *   Karnataka PT revision from 1 Apr 2025: greythr product update; Maharashtra slabs: cleartax.in
 */

// =================================================================================================
// Rule tables (FY 2026-27). Rates are integer basis points (1% = 100 bp) so no rate is a binary
// fraction; amounts are rupees.
// =================================================================================================

export const SUPPORTED_FINANCIAL_YEAR = '2026-27';

export const TAX_REGIMES = Object.freeze({ OLD: 'old', NEW: 'new' });

export const AGE_CATEGORIES = Object.freeze({ BELOW_60: 'below60', SENIOR: 'senior', SUPER_SENIOR: 'superSenior' });

/** Slab tables: [upperLimitInclusive (null = no limit), rateBasisPoints]. */
const NEW_REGIME_SLABS = Object.freeze([
  [400_000, 0],
  [800_000, 500],
  [1_200_000, 1_000],
  [1_600_000, 1_500],
  [2_000_000, 2_000],
  [2_400_000, 2_500],
  [null, 3_000],
]);

const OLD_REGIME_SLABS_BY_AGE = Object.freeze({
  [AGE_CATEGORIES.BELOW_60]: Object.freeze([[250_000, 0], [500_000, 500], [1_000_000, 2_000], [null, 3_000]]),
  [AGE_CATEGORIES.SENIOR]: Object.freeze([[300_000, 0], [500_000, 500], [1_000_000, 2_000], [null, 3_000]]),
  [AGE_CATEGORIES.SUPER_SENIOR]: Object.freeze([[500_000, 0], [1_000_000, 2_000], [null, 3_000]]),
});

const REGIME_RULES = Object.freeze({
  [TAX_REGIMES.NEW]: Object.freeze({
    standardDeduction: 75_000,
    rebateIncomeLimit: 1_200_000,
    maximumRebate: 60_000,
    rebateHasMarginalRelief: true,
    employerNpsCapBasisPoints: 1_400, // 14% of salary (basic + DA)
    // [incomeAbove, surchargeBasisPoints]; capped at 25% under the new regime.
    surchargeBands: Object.freeze([[5_000_000, 1_000], [10_000_000, 1_500], [20_000_000, 2_500]]),
  }),
  [TAX_REGIMES.OLD]: Object.freeze({
    standardDeduction: 50_000,
    rebateIncomeLimit: 500_000,
    maximumRebate: 12_500,
    rebateHasMarginalRelief: false,
    employerNpsCapBasisPoints: 1_000, // 10% of salary (basic + DA), non-government employer
    surchargeBands: Object.freeze([[5_000_000, 1_000], [10_000_000, 1_500], [20_000_000, 2_500], [50_000_000, 3_700]]),
  }),
});

const CESS_BASIS_POINTS = 400; // Health and Education Cess, 4%

const OLD_REGIME_DEDUCTION_LIMITS = Object.freeze({
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
export const HRA_FIFTY_PERCENT_CITIES = Object.freeze(['mumbai', 'delhi', 'kolkata', 'chennai', 'bengaluru', 'hyderabad', 'pune', 'ahmedabad']);
const HRA_CITY_ALIASES = Object.freeze({ bangalore: 'bengaluru', bombay: 'mumbai', calcutta: 'kolkata', madras: 'chennai', 'new delhi': 'delhi' });

/** EPF statutory wage ceiling over time (monthly wages, basic + DA). */
const EPF_WAGE_CEILING_SCHEDULE = Object.freeze([
  Object.freeze({ effectiveFrom: '2014-09-01', monthlyCeiling: 15_000 }),
  Object.freeze({ effectiveFrom: '2026-09-17', monthlyCeiling: 25_000 }), // S.O. 5109(E), 17 Sep 2026
]);
const EPF_EMPLOYEE_RATE_BASIS_POINTS = 1_200; // 12%

const ESI_RULES = Object.freeze({
  monthlyWageCeiling: 21_000,
  monthlyWageCeilingForPersonsWithDisability: 25_000,
  employeeRateBasisPoints: 75, // 0.75%
  exemptAverageDailyWage: 176,
});

export const PROFESSIONAL_TAX_STATES = Object.freeze({ KARNATAKA: 'KA', MAHARASHTRA: 'MH', NONE: 'NONE' });
const PROFESSIONAL_TAX_ANNUAL_CAP = 2_500;

/** The months of FY 2026-27, in payroll order. */
const FINANCIAL_YEAR_MONTHS = Object.freeze(
  [
    [2026, 4], [2026, 5], [2026, 6], [2026, 7], [2026, 8], [2026, 9],
    [2026, 10], [2026, 11], [2026, 12], [2027, 1], [2027, 2], [2027, 3],
  ].map(([year, month]) => Object.freeze({ year, month, label: `${year}-${String(month).padStart(2, '0')}`, daysInMonth: new Date(Date.UTC(year, month, 0)).getUTCDate() })),
);

// =================================================================================================
// Arithmetic helpers
// =================================================================================================

/** amount × rate, with the rate in basis points; rounded to the paisa. */
function applyRate(amount, rateBasisPoints) {
  return roundToPaisa((amount * rateBasisPoints) / 10_000);
}

function roundToPaisa(amount) {
  return Math.round((amount + Number.EPSILON) * 100) / 100;
}

/** Nearest multiple of ₹10; exactly ₹5 rounds up (rounding of total income and of tax). */
function roundToNearestTen(amount) {
  return Math.floor((amount + 5) / 10) * 10;
}

function roundToNearestRupee(amount) {
  return Math.round(amount + Number.EPSILON);
}

/** ESI: fractions of a rupee are rounded up to the next whole rupee. */
function roundUpToRupee(amount) {
  return Math.ceil(roundToPaisa(amount));
}

/** Progressive tax on `taxableIncome` with per-slab detail. */
function computeSlabTax(taxableIncome, slabs) {
  const slabLines = [];
  let lowerBound = 0;
  let slabTax = 0;
  for (const [upperLimit, rateBasisPoints] of slabs) {
    if (taxableIncome <= lowerBound) break;
    const slabTop = upperLimit === null ? taxableIncome : Math.min(taxableIncome, upperLimit);
    const incomeInSlab = slabTop - lowerBound;
    const taxInSlab = applyRate(incomeInSlab, rateBasisPoints);
    slabLines.push({ from: lowerBound, to: slabTop, ratePercent: rateBasisPoints / 100, incomeInSlab, tax: taxInSlab });
    slabTax = roundToPaisa(slabTax + taxInSlab);
    if (upperLimit === null) break;
    lowerBound = upperLimit;
  }
  return { slabTax, slabLines };
}

// =================================================================================================
// Input validation
// =================================================================================================

/** Thrown for invalid input; `fieldErrors` lists every problem found. */
export class PayrollInputError extends Error {
  constructor(fieldErrors) {
    super(`Invalid payroll input: ${fieldErrors.map((fieldError) => `${fieldError.field}: ${fieldError.message}`).join('; ')}`);
    this.name = 'PayrollInputError';
    this.fieldErrors = fieldErrors;
  }
}

const MAXIMUM_ANNUAL_AMOUNT = 1_000_000_000_000; // ₹1 lakh crore: far above any salary, below float precision limits

function readAmount(source, key, fieldPath, fieldErrors, { required = false } = {}) {
  const rawValue = source?.[key];
  if (rawValue === undefined || rawValue === null) {
    if (required) fieldErrors.push({ field: fieldPath, message: 'is required' });
    return 0;
  }
  const isValidAmount =
    typeof rawValue === 'number' && Number.isFinite(rawValue) && rawValue >= 0 && rawValue <= MAXIMUM_ANNUAL_AMOUNT && Math.abs(Math.round(rawValue * 100) - rawValue * 100) < 1e-6;
  if (!isValidAmount) {
    fieldErrors.push({ field: fieldPath, message: 'must be a non-negative amount in rupees with at most 2 decimal places' });
    return 0;
  }
  return rawValue;
}

function readBoolean(source, key, fieldPath, fieldErrors) {
  const rawValue = source?.[key];
  if (rawValue === undefined) return false;
  if (typeof rawValue !== 'boolean') fieldErrors.push({ field: fieldPath, message: 'must be true or false' });
  return rawValue === true;
}

function normalizeInputs(salaryStructure, investmentsDeclared, taxRegimeChoice, employmentDetails) {
  const fieldErrors = [];
  const isObject = (candidateValue) => typeof candidateValue === 'object' && candidateValue !== null && !Array.isArray(candidateValue);
  if (!isObject(salaryStructure)) fieldErrors.push({ field: 'salaryStructure', message: 'must be an object' });
  if (investmentsDeclared !== undefined && investmentsDeclared !== null && !isObject(investmentsDeclared)) {
    fieldErrors.push({ field: 'investmentsDeclared', message: 'must be an object' });
  }
  if (!isObject(employmentDetails)) fieldErrors.push({ field: 'employmentDetails', message: 'must be an object' });
  if (fieldErrors.length > 0) throw new PayrollInputError(fieldErrors);

  const investments = investmentsDeclared ?? {};
  const salary = {
    annualGross: readAmount(salaryStructure, 'annualGross', 'salaryStructure.annualGross', fieldErrors, { required: true }),
    annualBasic: readAmount(salaryStructure, 'annualBasic', 'salaryStructure.annualBasic', fieldErrors, { required: true }),
    annualDearnessAllowance: readAmount(salaryStructure, 'annualDearnessAllowance', 'salaryStructure.annualDearnessAllowance', fieldErrors),
    annualHraReceived: readAmount(salaryStructure, 'annualHraReceived', 'salaryStructure.annualHraReceived', fieldErrors),
    annualEmployerNpsContribution: readAmount(salaryStructure, 'annualEmployerNpsContribution', 'salaryStructure.annualEmployerNpsContribution', fieldErrors),
  };
  if (salary.annualBasic + salary.annualDearnessAllowance + salary.annualHraReceived > salary.annualGross) {
    fieldErrors.push({ field: 'salaryStructure', message: 'basic + DA + HRA cannot exceed annualGross (gross must include every salary component)' });
  }

  const declared = {
    section123Investments: readAmount(investments, 'section123Investments', 'investmentsDeclared.section123Investments', fieldErrors),
    employeeNpsContribution: readAmount(investments, 'employeeNpsContribution', 'investmentsDeclared.employeeNpsContribution', fieldErrors),
    healthInsuranceSelfFamily: readAmount(investments, 'healthInsuranceSelfFamily', 'investmentsDeclared.healthInsuranceSelfFamily', fieldErrors),
    selfOrSpouseIsSenior: readBoolean(investments, 'selfOrSpouseIsSenior', 'investmentsDeclared.selfOrSpouseIsSenior', fieldErrors),
    healthInsuranceParents: readAmount(investments, 'healthInsuranceParents', 'investmentsDeclared.healthInsuranceParents', fieldErrors),
    parentIsSenior: readBoolean(investments, 'parentIsSenior', 'investmentsDeclared.parentIsSenior', fieldErrors),
    educationLoanInterest: readAmount(investments, 'educationLoanInterest', 'investmentsDeclared.educationLoanInterest', fieldErrors),
    selfOccupiedHomeLoanInterest: readAmount(investments, 'selfOccupiedHomeLoanInterest', 'investmentsDeclared.selfOccupiedHomeLoanInterest', fieldErrors),
    annualRentPaid: readAmount(investments, 'annualRentPaid', 'investmentsDeclared.annualRentPaid', fieldErrors),
    rentedCity: null,
  };
  if (investments.rentedCity !== undefined && investments.rentedCity !== null) {
    if (typeof investments.rentedCity !== 'string' || investments.rentedCity.trim().length === 0 || investments.rentedCity.length > 100) {
      fieldErrors.push({ field: 'investmentsDeclared.rentedCity', message: 'must be a city name' });
    } else {
      const cityKey = investments.rentedCity.trim().toLowerCase();
      declared.rentedCity = HRA_CITY_ALIASES[cityKey] ?? cityKey;
    }
  }
  if (declared.annualRentPaid > 0 && salary.annualHraReceived > 0 && declared.rentedCity === null) {
    fieldErrors.push({ field: 'investmentsDeclared.rentedCity', message: 'is required to compute the HRA exemption' });
  }

  const regimeChoice = typeof taxRegimeChoice === 'string' ? taxRegimeChoice.trim().toLowerCase() : taxRegimeChoice;
  if (![TAX_REGIMES.OLD, TAX_REGIMES.NEW].includes(regimeChoice)) {
    fieldErrors.push({ field: 'taxRegimeChoice', message: 'must be "old" or "new" (both are always computed; this marks the regime the employee has opted for)' });
  }

  const employment = {
    financialYear: employmentDetails.financialYear ?? SUPPORTED_FINANCIAL_YEAR,
    ageCategory: employmentDetails.ageCategory ?? AGE_CATEGORIES.BELOW_60,
    professionalTaxState: employmentDetails.professionalTaxState,
    gender: employmentDetails.gender,
    isPersonWithDisability: readBoolean(employmentDetails, 'isPersonWithDisability', 'employmentDetails.isPersonWithDisability', fieldErrors),
    epfContributionOnFullBasic: readBoolean(employmentDetails, 'epfContributionOnFullBasic', 'employmentDetails.epfContributionOnFullBasic', fieldErrors),
    isEpfMember: employmentDetails.isEpfMember === undefined ? true : readBoolean(employmentDetails, 'isEpfMember', 'employmentDetails.isEpfMember', fieldErrors),
  };
  if (employment.financialYear !== SUPPORTED_FINANCIAL_YEAR) {
    fieldErrors.push({ field: 'employmentDetails.financialYear', message: `only ${SUPPORTED_FINANCIAL_YEAR} is supported; other years have different rates` });
  }
  if (!Object.values(AGE_CATEGORIES).includes(employment.ageCategory)) {
    fieldErrors.push({ field: 'employmentDetails.ageCategory', message: 'must be below60, senior (60-79) or superSenior (80+)' });
  }
  if (!Object.values(PROFESSIONAL_TAX_STATES).includes(employment.professionalTaxState)) {
    fieldErrors.push({ field: 'employmentDetails.professionalTaxState', message: 'must be KA, MH, or NONE (state with no professional tax); other states are not modelled' });
  }
  if (employment.professionalTaxState === PROFESSIONAL_TAX_STATES.MAHARASHTRA && !['male', 'female', 'other'].includes(employment.gender)) {
    fieldErrors.push({ field: 'employmentDetails.gender', message: 'is required for Maharashtra professional tax (male, female or other)' });
  }

  if (fieldErrors.length > 0) throw new PayrollInputError(fieldErrors);
  return { salary, declared, regimeChoice, employment };
}

// =================================================================================================
// Statutory payroll deductions
// =================================================================================================

/** The EPF wage ceiling in force on a given ISO date. */
function epfCeilingOn(isoDate) {
  let applicableCeiling = EPF_WAGE_CEILING_SCHEDULE[0].monthlyCeiling;
  for (const ceilingPeriod of EPF_WAGE_CEILING_SCHEDULE) {
    if (ceilingPeriod.effectiveFrom <= isoDate) applicableCeiling = ceilingPeriod.monthlyCeiling;
  }
  return applicableCeiling;
}

/**
 * Employee EPF for one month. When the ceiling changes inside the month (September 2026), the
 * month is split by days: each part's wages (pro-rated) are capped at that part's pro-rated ceiling.
 */
function computeMonthlyEpf(monthlyEpfWages, payrollMonth, contributeOnFullBasic) {
  const monthPrefix = payrollMonth.label;
  const dailyCeilings = [];
  for (let dayOfMonth = 1; dayOfMonth <= payrollMonth.daysInMonth; dayOfMonth += 1) {
    dailyCeilings.push(epfCeilingOn(`${monthPrefix}-${String(dayOfMonth).padStart(2, '0')}`));
  }
  // Group consecutive days with the same ceiling into segments.
  const ceilingSegments = [];
  for (const dailyCeiling of dailyCeilings) {
    const lastSegment = ceilingSegments[ceilingSegments.length - 1];
    if (lastSegment && lastSegment.monthlyCeiling === dailyCeiling) lastSegment.days += 1;
    else ceilingSegments.push({ monthlyCeiling: dailyCeiling, days: 1 });
  }
  let contributoryWages = 0;
  for (const ceilingSegment of ceilingSegments) {
    const dayFraction = ceilingSegment.days / payrollMonth.daysInMonth;
    const segmentWages = monthlyEpfWages * dayFraction;
    const segmentCeiling = ceilingSegment.monthlyCeiling * dayFraction;
    contributoryWages += contributeOnFullBasic ? segmentWages : Math.min(segmentWages, segmentCeiling);
  }
  return {
    month: payrollMonth.label,
    ceilingSegments: ceilingSegments.map((ceilingSegment) => ({ monthlyCeiling: ceilingSegment.monthlyCeiling, days: ceilingSegment.days })),
    contributoryWages: roundToPaisa(contributoryWages),
    employeeContribution: roundToNearestRupee(applyRate(contributoryWages, EPF_EMPLOYEE_RATE_BASIS_POINTS)),
  };
}

function computeMonthlyProfessionalTax(state, gender, monthlyGross, payrollMonth) {
  const isFebruary = payrollMonth.month === 2;
  if (state === PROFESSIONAL_TAX_STATES.KARNATAKA) {
    if (monthlyGross < 25_000) return 0;
    return isFebruary ? 300 : 200;
  }
  if (state === PROFESSIONAL_TAX_STATES.MAHARASHTRA) {
    if (gender === 'female') {
      if (monthlyGross <= 25_000) return 0;
      return isFebruary ? 300 : 200;
    }
    if (monthlyGross <= 7_500) return 0;
    if (monthlyGross <= 10_000) return 175;
    return isFebruary ? 300 : 200;
  }
  return 0;
}

function computeStatutoryDeductions({ salary, employment }) {
  const monthlyGross = salary.annualGross / 12;
  const monthlyEpfWages = (salary.annualBasic + salary.annualDearnessAllowance) / 12;

  // ---- EPF -------------------------------------------------------------------------------------
  const epfMonths = employment.isEpfMember
    ? FINANCIAL_YEAR_MONTHS.map((payrollMonth) => computeMonthlyEpf(monthlyEpfWages, payrollMonth, employment.epfContributionOnFullBasic))
    : [];
  const annualEpf = epfMonths.reduce((runningTotal, epfMonth) => runningTotal + epfMonth.employeeContribution, 0);

  // ---- Professional tax ------------------------------------------------------------------------
  const professionalTaxMonths = FINANCIAL_YEAR_MONTHS.map((payrollMonth) => ({
    month: payrollMonth.label,
    amount: computeMonthlyProfessionalTax(employment.professionalTaxState, employment.gender, monthlyGross, payrollMonth),
  }));
  const annualProfessionalTax = Math.min(
    professionalTaxMonths.reduce((runningTotal, professionalTaxMonth) => runningTotal + professionalTaxMonth.amount, 0),
    PROFESSIONAL_TAX_ANNUAL_CAP,
  );

  // ---- ESI -------------------------------------------------------------------------------------
  const esiWageCeiling = employment.isPersonWithDisability ? ESI_RULES.monthlyWageCeilingForPersonsWithDisability : ESI_RULES.monthlyWageCeiling;
  const isEsiCovered = monthlyGross <= esiWageCeiling;
  // The ₹176 average daily wage is measured over the six-month contribution period (wages ÷ days in
  // the period), the same unit as coverage; a per-month measure would wrongly make February (28
  // days) cross the limit on its own.
  const contributionPeriods = [FINANCIAL_YEAR_MONTHS.slice(0, 6), FINANCIAL_YEAR_MONTHS.slice(6, 12)];
  const esiMonths = isEsiCovered
    ? contributionPeriods.flatMap((periodMonths) => {
        const daysInPeriod = periodMonths.reduce((runningTotal, payrollMonth) => runningTotal + payrollMonth.daysInMonth, 0);
        const averageDailyWage = (monthlyGross * periodMonths.length) / daysInPeriod;
        const isEmployeeShareExempt = averageDailyWage <= ESI_RULES.exemptAverageDailyWage;
        return periodMonths.map((payrollMonth) => ({
          month: payrollMonth.label,
          employeeContribution: isEmployeeShareExempt ? 0 : roundUpToRupee(applyRate(monthlyGross, ESI_RULES.employeeRateBasisPoints)),
          employeeShareExempt: isEmployeeShareExempt,
        }));
      })
    : [];
  const annualEsi = esiMonths.reduce((runningTotal, esiMonth) => runningTotal + esiMonth.employeeContribution, 0);

  return {
    epf: {
      isMember: employment.isEpfMember,
      contributionOnFullBasic: employment.epfContributionOnFullBasic,
      ratePercent: EPF_EMPLOYEE_RATE_BASIS_POINTS / 100,
      monthlyWages: roundToPaisa(monthlyEpfWages),
      annualEmployeeContribution: annualEpf,
      months: epfMonths,
    },
    professionalTax: { state: employment.professionalTaxState, annualAmount: annualProfessionalTax, months: professionalTaxMonths },
    esi: {
      isCovered: isEsiCovered,
      monthlyWageCeiling: esiWageCeiling,
      ratePercent: ESI_RULES.employeeRateBasisPoints / 100,
      annualEmployeeContribution: annualEsi,
      months: esiMonths,
    },
    annualTotal: annualEpf + annualProfessionalTax + annualEsi,
  };
}

// =================================================================================================
// Income tax, per regime
// =================================================================================================

/** HRA exemption (old regime only): least of the three statutory limits. */
function computeHraExemption({ salary, declared }) {
  const salaryForHra = salary.annualBasic + salary.annualDearnessAllowance;
  if (salary.annualHraReceived === 0 || declared.annualRentPaid === 0) {
    return { exemption: 0, limits: null, isFiftyPercentCity: null };
  }
  const isFiftyPercentCity = HRA_FIFTY_PERCENT_CITIES.includes(declared.rentedCity);
  const limits = {
    actualHraReceived: salary.annualHraReceived,
    rentPaidMinusTenPercentOfSalary: Math.max(0, roundToPaisa(declared.annualRentPaid - applyRate(salaryForHra, 1_000))),
    percentOfSalary: applyRate(salaryForHra, isFiftyPercentCity ? 5_000 : 4_000),
  };
  return { exemption: Math.min(limits.actualHraReceived, limits.rentPaidMinusTenPercentOfSalary, limits.percentOfSalary), limits, isFiftyPercentCity };
}

/** Old-regime deductions with each claim capped by its statutory limit. */
function computeOldRegimeDeductions({ salary, declared }, annualEpf) {
  const limits = OLD_REGIME_DEDUCTION_LIMITS;
  const salaryForCaps = salary.annualBasic + salary.annualDearnessAllowance;

  // NPS: the separate ₹50,000 of s.124 (80CCD(1B)) is used first, because it does not compete with
  // the ₹1.5L aggregate; the rest counts under 80CCD(1), capped at 10% of salary, inside the aggregate.
  const additionalNps = Math.min(declared.employeeNpsContribution, limits.additionalNps);
  const npsRemainder = declared.employeeNpsContribution - additionalNps;
  const npsWithinAggregate = Math.min(npsRemainder, applyRate(salaryForCaps, limits.employeeNpsSalaryCapBasisPoints));
  const section123Claimed = annualEpf + declared.section123Investments + npsWithinAggregate;
  const section123Allowed = Math.min(section123Claimed, limits.section123Aggregate);

  const healthSelfFamilyLimit = declared.selfOrSpouseIsSenior ? limits.healthInsuranceSelfFamilySenior : limits.healthInsuranceSelfFamily;
  const healthParentsLimit = declared.parentIsSenior ? limits.healthInsuranceParentsSenior : limits.healthInsuranceParents;
  const employerNpsLimit = applyRate(salaryForCaps, REGIME_RULES[TAX_REGIMES.OLD].employerNpsCapBasisPoints);

  const deductionLines = [
    { section: 's.123 (80C/80CCC/80CCD(1))', claimed: roundToPaisa(section123Claimed), allowed: roundToPaisa(section123Allowed), note: `includes employee EPF ₹${annualEpf}; aggregate cap ₹1,50,000` },
    { section: 's.124 (80CCD(1B)) additional NPS', claimed: additionalNps, allowed: additionalNps, note: 'cap ₹50,000' },
    { section: 's.124 (80CCD(2)) employer NPS', claimed: salary.annualEmployerNpsContribution, allowed: Math.min(salary.annualEmployerNpsContribution, employerNpsLimit), note: '10% of basic + DA' },
    { section: 's.126 (80D) health insurance, self/family', claimed: declared.healthInsuranceSelfFamily, allowed: Math.min(declared.healthInsuranceSelfFamily, healthSelfFamilyLimit), note: `cap ₹${healthSelfFamilyLimit}` },
    { section: 's.126 (80D) health insurance, parents', claimed: declared.healthInsuranceParents, allowed: Math.min(declared.healthInsuranceParents, healthParentsLimit), note: `cap ₹${healthParentsLimit}` },
    { section: 's.129 (80E) education-loan interest', claimed: declared.educationLoanInterest, allowed: declared.educationLoanInterest, note: 'no cap' },
    { section: 's.22 (24(b)) self-occupied home-loan interest', claimed: declared.selfOccupiedHomeLoanInterest, allowed: Math.min(declared.selfOccupiedHomeLoanInterest, limits.selfOccupiedHomeLoanInterest), note: 'cap ₹2,00,000' },
  ];
  return deductionLines;
}

/** Tax + surcharge with marginal relief at every surcharge threshold crossed. */
function applySurcharge(taxableIncome, taxAfterRebate, slabs, surchargeBands) {
  let applicableBand = null;
  for (const surchargeBand of surchargeBands) {
    if (taxableIncome > surchargeBand[0]) applicableBand = surchargeBand;
  }
  if (!applicableBand) return { surchargeRatePercent: 0, surcharge: 0, marginalRelief: 0 };

  const [thresholdIncome, rateBasisPoints] = applicableBand;
  const grossSurcharge = applyRate(taxAfterRebate, rateBasisPoints);
  // Liability at the threshold uses the surcharge rate in force exactly at the threshold.
  const lowerBand = surchargeBands.filter((surchargeBand) => surchargeBand[0] < thresholdIncome).pop();
  const taxAtThreshold = computeSlabTax(thresholdIncome, slabs).slabTax;
  const liabilityAtThreshold = roundToPaisa(taxAtThreshold + (lowerBand ? applyRate(taxAtThreshold, lowerBand[1]) : 0));
  const liabilityCap = roundToPaisa(liabilityAtThreshold + (taxableIncome - thresholdIncome));
  const marginalRelief = Math.max(0, roundToPaisa(taxAfterRebate + grossSurcharge - liabilityCap));
  return { surchargeRatePercent: rateBasisPoints / 100, surcharge: roundToPaisa(grossSurcharge - marginalRelief), marginalRelief };
}

function computeRegimeTax(regime, normalizedInputs, statutoryDeductions) {
  const { salary, employment } = normalizedInputs;
  const rules = REGIME_RULES[regime];
  const salaryForCaps = salary.annualBasic + salary.annualDearnessAllowance;

  // ---- Salary income ---------------------------------------------------------------------------
  // The employer's NPS contribution is part of salary income and then deducted (up to the cap).
  const grossSalaryIncome = salary.annualGross + salary.annualEmployerNpsContribution;
  const hra = regime === TAX_REGIMES.OLD ? computeHraExemption(normalizedInputs) : { exemption: 0, limits: null, isFiftyPercentCity: null };
  const salaryAfterExemptions = roundToPaisa(grossSalaryIncome - hra.exemption);
  const standardDeduction = Math.min(rules.standardDeduction, salaryAfterExemptions);
  const professionalTaxDeduction = regime === TAX_REGIMES.OLD ? statutoryDeductions.professionalTax.annualAmount : 0;
  const incomeFromSalary = Math.max(0, roundToPaisa(salaryAfterExemptions - standardDeduction - professionalTaxDeduction));

  // ---- Deductions ------------------------------------------------------------------------------
  const deductionLines =
    regime === TAX_REGIMES.OLD
      ? computeOldRegimeDeductions(normalizedInputs, statutoryDeductions.epf.annualEmployeeContribution)
      : [
          {
            section: 's.124 (80CCD(2)) employer NPS',
            claimed: salary.annualEmployerNpsContribution,
            allowed: Math.min(salary.annualEmployerNpsContribution, applyRate(salaryForCaps, rules.employerNpsCapBasisPoints)),
            note: '14% of basic + DA; the only deduction from salary income allowed under the new regime',
          },
        ];
  // Home-loan interest is a loss under "house property" set off against salary; the other lines are
  // deductions from gross total income. Both reduce total income and are capped by it.
  const totalDeductionsAllowed = roundToPaisa(deductionLines.reduce((runningTotal, deductionLine) => runningTotal + deductionLine.allowed, 0));
  const taxableIncome = roundToNearestTen(Math.max(0, incomeFromSalary - totalDeductionsAllowed));

  // ---- Tax ---------------------------------------------------------------------------------------
  const slabs = regime === TAX_REGIMES.NEW ? NEW_REGIME_SLABS : OLD_REGIME_SLABS_BY_AGE[employment.ageCategory];
  const { slabTax, slabLines } = computeSlabTax(taxableIncome, slabs);

  let rebate = 0;
  let rebateMarginalRelief = 0;
  if (taxableIncome <= rules.rebateIncomeLimit) {
    rebate = Math.min(slabTax, rules.maximumRebate);
  } else if (rules.rebateHasMarginalRelief) {
    const incomeAboveRebateLimit = taxableIncome - rules.rebateIncomeLimit;
    rebateMarginalRelief = Math.max(0, roundToPaisa(slabTax - incomeAboveRebateLimit));
  }
  const taxAfterRebate = roundToPaisa(slabTax - rebate - rebateMarginalRelief);

  const surchargeResult = applySurcharge(taxableIncome, taxAfterRebate, slabs, rules.surchargeBands);
  const taxPlusSurcharge = roundToPaisa(taxAfterRebate + surchargeResult.surcharge);
  const cess = applyRate(taxPlusSurcharge, CESS_BASIS_POINTS);
  const totalTax = roundToNearestTen(taxPlusSurcharge + cess);

  const takeHomeAnnual = roundToPaisa(salary.annualGross - totalTax - statutoryDeductions.annualTotal);
  return {
    regime,
    grossSalaryIncome,
    hraExemption: hra,
    standardDeduction,
    professionalTaxDeduction,
    incomeFromSalary,
    deductions: deductionLines,
    totalDeductionsAllowed,
    taxableIncome,
    slabs: slabLines,
    slabTax,
    rebate,
    rebateMarginalRelief,
    taxAfterRebate,
    surchargeRatePercent: surchargeResult.surchargeRatePercent,
    surcharge: surchargeResult.surcharge,
    surchargeMarginalRelief: surchargeResult.marginalRelief,
    cess,
    totalTax,
    monthlyTds: roundToNearestRupee(totalTax / 12),
    effectiveTaxRatePercent: grossSalaryIncome > 0 ? roundToPaisa((totalTax / grossSalaryIncome) * 100) : 0,
    takeHomeAnnual,
    takeHomeMonthly: roundToPaisa(takeHomeAnnual / 12),
  };
}

// =================================================================================================
// Public API
// =================================================================================================

/**
 * Computes FY 2026-27 income tax under both regimes, plus EPF, professional tax and ESI, and
 * recommends the cheaper regime.
 *
 * @param {object} salaryStructure  Annual amounts in rupees (≤ 2 decimals):
 *   annualGross (required, every cash salary component), annualBasic (required),
 *   annualDearnessAllowance, annualHraReceived, annualEmployerNpsContribution (paid on top of gross)
 * @param {object|null} investmentsDeclared  Annual amounts claimed (old regime unless noted):
 *   section123Investments (80C-type: PPF, ELSS, life insurance, tuition fees, home-loan principal;
 *   EPF is added automatically), employeeNpsContribution, healthInsuranceSelfFamily,
 *   selfOrSpouseIsSenior, healthInsuranceParents, parentIsSenior, educationLoanInterest,
 *   selfOccupiedHomeLoanInterest, annualRentPaid, rentedCity
 * @param {'old'|'new'} taxRegimeChoice  The regime the employee has opted for; both are computed.
 * @param {object} employmentDetails
 *   professionalTaxState ('KA' | 'MH' | 'NONE', required), gender (required for MH),
 *   ageCategory ('below60' default | 'senior' | 'superSenior'), isPersonWithDisability (ESI ceiling),
 *   epfContributionOnFullBasic (voluntary EPF above the ceiling), isEpfMember (default true),
 *   financialYear (default and only supported: '2026-27')
 * @returns {object} analysis payload (see the returned object below)
 * @throws {PayrollInputError} listing every invalid field
 */
export function computeTaxLiability(salaryStructure, investmentsDeclared, taxRegimeChoice, employmentDetails) {
  const normalizedInputs = normalizeInputs(salaryStructure, investmentsDeclared, taxRegimeChoice, employmentDetails);
  const statutoryDeductions = computeStatutoryDeductions(normalizedInputs);

  const oldRegime = computeRegimeTax(TAX_REGIMES.OLD, normalizedInputs, statutoryDeductions);
  const newRegime = computeRegimeTax(TAX_REGIMES.NEW, normalizedInputs, statutoryDeductions);

  // Ties go to the new regime: it is the default and needs no investment proofs.
  const recommendedRegime = oldRegime.totalTax < newRegime.totalTax ? TAX_REGIMES.OLD : TAX_REGIMES.NEW;
  const annualSaving = Math.abs(oldRegime.totalTax - newRegime.totalTax);
  const chosenRegime = normalizedInputs.regimeChoice;
  const chosenResult = chosenRegime === TAX_REGIMES.OLD ? oldRegime : newRegime;
  const recommendedResult = recommendedRegime === TAX_REGIMES.OLD ? oldRegime : newRegime;

  return {
    financialYear: SUPPORTED_FINANCIAL_YEAR,
    statute: 'Income-tax Act, 2025 (tax year 2026-27)',
    statutoryDeductions,
    regimes: { old: oldRegime, new: newRegime },
    recommendation: {
      recommendedRegime,
      annualTaxUnderRecommended: recommendedResult.totalTax,
      annualSavingVersusOtherRegime: annualSaving,
      reason:
        annualSaving === 0
          ? 'Both regimes give the same tax; the new regime is recommended because it is the default and needs no investment proofs.'
          : `The ${recommendedRegime} regime costs ₹${annualSaving} less in tax for the year.`,
    },
    chosenRegime: {
      regime: chosenRegime,
      annualTax: chosenResult.totalTax,
      isMostTaxEfficient: chosenResult.totalTax <= recommendedResult.totalTax,
      additionalTaxVersusRecommended: chosenResult.totalTax - recommendedResult.totalTax,
    },
    assumptions: [
      'Resident individual; income from salary only.',
      'Salary paid uniformly across the 12 months of FY 2026-27.',
      'Employer EPF/NPS contributions within the ₹7,50,000 aggregate tax-free limit.',
      'Professional tax modelled for Karnataka and Maharashtra only.',
      'Estimate for planning and TDS projection; actual liability depends on all income and proofs.',
    ],
  };
}
