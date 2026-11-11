/**
 * The salary structure of an offer: an annual CTC (cost to company) split into its Indian statutory
 * components, and what the employee takes home. Deterministic: the same inputs and policy always
 * give the same figures, to the rupee.
 *
 * The CTC may include a variable (performance) part, paid as the company's policy decides: it is set
 * aside first, and the rest, the fixed CTC, is what the components below split. HR may also set
 * Basic and HRA themselves (and state the special allowance they expect): Special allowance stays the
 * balancing figure, so a split that cannot add up is refused rather than adjusted.
 *
 * Statutory rules are not repeated here: rates, ceilings and city lists come from
 * utils/payroll/rules.js, and income tax, professional tax and the employee's ESI from the FY
 * 2026-27 tax engine (utils/payrollCalculator.js computeTaxLiability). The company's own choices
 * come from its compensation policy (models/OnboardingSettings.js).
 *
 *   Fixed CTC        = CTC − variable pay
 *   Basic            = Fixed CTC × policy Basic share (or as HR set it)
 *   HRA              = Basic × 50% in the 8 cities of HRA_FIFTY_PERCENT_CITIES, else × 40% (policy),
 *                      or as HR set it
 *   Employer PF      = 12% of monthly Basic, on wages up to the EPF wage ceiling in force on the
 *                      joining date (₹15,000 before 17 Sep 2026, ₹25,000 from then), or on the
 *                      whole Basic when the policy says so; × 12. The employee pays the same.
 *   Gratuity         = Basic × 15 / (26 × 12), only when the policy counts it inside the CTC
 *   Gross            = Fixed CTC − employer PF − gratuity − employer ESI
 *   Employer ESI     = 3.25% of gross, only while gross ≤ ₹21,000 a month (so gross is solved for)
 *   Special allowance= Gross − Basic − HRA  (the balancing figure; never negative)
 *   Take-home        = Gross − employee PF − employee ESI − professional tax − income tax
 *                      (the variable pay is taxed when it is paid, so it is left out of both)
 *
 * Rounding: every annual figure is whole rupees and the annual figures are authoritative. Each is
 * also shown per month as ⌊annual ÷ 12⌋, with the rupees left over (annualRemainder, 0-11) shown
 * rather than lost, so monthly × 12 + annualRemainder = annual exactly. Invariants:
 *   Basic + HRA + Special allowance = Gross
 *   Gross + employer PF + gratuity + employer ESI = Fixed CTC
 *   Fixed CTC + variable pay = CTC
 *   Gross − employee deductions = Take-home
 */

import {
  AGE_CATEGORIES,
  EPF_EMPLOYEE_RATE_BASIS_POINTS,
  ESI_RULES,
  GRATUITY_RULES,
  isHraFiftyPercentCity,
} from '../utils/payroll/rules.js';
import { applyRate, roundToNearestRupee } from '../utils/payroll/arithmetic.js';
import { epfCeilingOn } from '../utils/payroll/statutoryDeductions.js';
import { computeTaxLiability } from '../utils/payrollCalculator.js';

const MONTHS_PER_YEAR = 12;
const BASIS_POINTS = 10_000;
const SENIOR_AGE = 60;
const SUPER_SENIOR_AGE = 80;

export const HRA_CITY_KINDS = Object.freeze({ FIFTY_PERCENT_CITY: 'fifty_percent_city', OTHER_CITY: 'other_city' });

/**
 * The offer cannot be split as asked; `code`:
 *   CTC_TOO_LOW            the fixed CTC cannot cover the policy's Basic, HRA and employer contributions
 *   SPLIT_EXCEEDS_GROSS    the Basic and HRA HR set leave a negative special allowance
 *   SPLIT_DOES_NOT_ADD_UP  the special allowance HR stated is not the balancing figure;
 *                          `details.expectedSpecialAllowanceAnnual` is
 */
export class CtcStructureError extends Error {
  constructor(code, details = null) {
    super(code);
    this.name = 'CtcStructureError';
    this.code = code;
    this.details = details;
  }
}

/** An annual amount with its monthly share and the rupees the 12 monthly shares leave over. */
export function splitAnnual(annual) {
  const monthly = Math.floor(annual / MONTHS_PER_YEAR);
  return { annual, monthly, annualRemainder: annual - monthly * MONTHS_PER_YEAR };
}

const isoDateOf = (date) => date.toISOString().slice(0, 10);

/** The tax engine's age band on the joining date (old-regime basic exemption depends on it). */
function ageCategoryOn(dateOfBirth, joiningDate) {
  if (!dateOfBirth) return AGE_CATEGORIES.BELOW_60;
  let age = joiningDate.getUTCFullYear() - dateOfBirth.getUTCFullYear();
  const birthdayPassed =
    joiningDate.getUTCMonth() > dateOfBirth.getUTCMonth() ||
    (joiningDate.getUTCMonth() === dateOfBirth.getUTCMonth() && joiningDate.getUTCDate() >= dateOfBirth.getUTCDate());
  if (!birthdayPassed) age -= 1;
  if (age >= SUPER_SENIOR_AGE) return AGE_CATEGORIES.SUPER_SENIOR;
  if (age >= SENIOR_AGE) return AGE_CATEGORIES.SENIOR;
  return AGE_CATEGORIES.BELOW_60;
}

/** Employer and employee PF for the year: 12% of monthly Basic up to the ceiling, rounded per month. */
function providentFundFor(annualBasic, joiningDate, pfOnFullBasic) {
  const monthlyBasic = annualBasic / MONTHS_PER_YEAR;
  const wageCeiling = epfCeilingOn(isoDateOf(joiningDate));
  const contributoryWages = pfOnFullBasic ? monthlyBasic : Math.min(monthlyBasic, wageCeiling);
  const monthly = roundToNearestRupee(applyRate(contributoryWages, EPF_EMPLOYEE_RATE_BASIS_POINTS));
  return { annual: monthly * MONTHS_PER_YEAR, wageCeiling: pfOnFullBasic ? null : wageCeiling };
}

/** Gross and the employer's ESI, which is 3.25% of that same gross while gross is within the ESI ceiling. */
function grossAndEmployerEsi(amountForGrossAndEsi) {
  const ceilingAnnual = ESI_RULES.monthlyWageCeiling * MONTHS_PER_YEAR;
  if (amountForGrossAndEsi > ceilingAnnual) return { gross: amountForGrossAndEsi, employerEsi: 0 };
  const gross = Math.floor((amountForGrossAndEsi * BASIS_POINTS) / (BASIS_POINTS + ESI_RULES.employerRateBasisPoints));
  return { gross, employerEsi: amountForGrossAndEsi - gross };
}

/**
 * @param {{ annualCtc: number, variablePayAnnual?: number, taxRegime: 'new'|'old', workCity: string,
 *   professionalTaxState: string, gender?: string|null, dateOfBirth?: Date|null, joiningDate: Date,
 *   components?: { basicAnnual?: number|null, hraAnnual?: number|null, specialAllowanceAnnual?: number|null } }} offer
 *   amounts in whole rupees a year; joiningDate and dateOfBirth at midnight UTC of their day
 * @param {{ basicShareBasisPoints: number, hraFiftyPercentCityBasisPoints: number,
 *   hraOtherCityBasisPoints: number, pfOnFullBasic: boolean, includeGratuityInCtc: boolean }} policy
 * @returns {object} the structure (see the return statement)
 * @throws {CtcStructureError} CTC_TOO_LOW, SPLIT_EXCEEDS_GROSS, SPLIT_DOES_NOT_ADD_UP
 * @throws {PayrollInputError} from the tax engine (e.g. gender missing for Maharashtra PT)
 */
export function computeCtcStructure(offer, policy) {
  const { annualCtc, taxRegime, workCity, professionalTaxState, joiningDate } = offer;
  const variablePay = offer.variablePayAnnual ?? 0;
  const components = offer.components ?? {};
  const basicSet = components.basicAnnual ?? null;
  const hraSet = components.hraAnnual ?? null;
  const fixedCtc = annualCtc - variablePay;

  const basic = basicSet ?? roundToNearestRupee(applyRate(fixedCtc, policy.basicShareBasisPoints));
  const isFiftyPercentCity = isHraFiftyPercentCity(workCity);
  const hraRateBasisPoints = isFiftyPercentCity
    ? policy.hraFiftyPercentCityBasisPoints
    : policy.hraOtherCityBasisPoints;
  const hra = hraSet ?? roundToNearestRupee(applyRate(basic, hraRateBasisPoints));
  const providentFund = providentFundFor(basic, joiningDate, policy.pfOnFullBasic);
  const gratuity = policy.includeGratuityInCtc
    ? roundToNearestRupee(
        (basic * GRATUITY_RULES.daysWagesPerYear) / (GRATUITY_RULES.workingDaysPerMonth * MONTHS_PER_YEAR),
      )
    : 0;
  const { gross, employerEsi } = grossAndEmployerEsi(fixedCtc - providentFund.annual - gratuity);
  const specialAllowance = gross - basic - hra;
  const isSplitSet = basicSet !== null || hraSet !== null;
  if (specialAllowance < 0) throw new CtcStructureError(isSplitSet ? 'SPLIT_EXCEEDS_GROSS' : 'CTC_TOO_LOW');
  const specialStated = components.specialAllowanceAnnual ?? null;
  if (specialStated !== null && specialStated !== specialAllowance) {
    throw new CtcStructureError('SPLIT_DOES_NOT_ADD_UP', { expectedSpecialAllowanceAnnual: specialAllowance });
  }

  const taxAnalysis = computeTaxLiability(
    { annualGross: gross, annualBasic: basic, annualHraReceived: hra },
    null,
    taxRegime,
    {
      professionalTaxState,
      gender: offer.gender ?? undefined,
      ageCategory: ageCategoryOn(offer.dateOfBirth ?? null, joiningDate),
      epfContributionOnFullBasic: policy.pfOnFullBasic,
      isEpfMember: true,
    },
  );
  const incomeTax = taxAnalysis.regimes[taxRegime].totalTax;
  const professionalTax = taxAnalysis.statutoryDeductions.professionalTax.annualAmount;
  const employeeEsi = taxAnalysis.statutoryDeductions.esi.annualEmployeeContribution;
  const employeeDeductionsTotal = providentFund.annual + employeeEsi + professionalTax + incomeTax;

  return {
    annualCtc,
    fixedCtc: splitAnnual(fixedCtc),
    variablePay: splitAnnual(variablePay),
    splitSetBy: { basic: basicSet === null ? 'policy' : 'hr', hra: hraSet === null ? 'policy' : 'hr' },
    taxRegime,
    taxYear: taxAnalysis.financialYear,
    policy: { ...policy },
    hra: {
      cityKind: isFiftyPercentCity ? HRA_CITY_KINDS.FIFTY_PERCENT_CITY : HRA_CITY_KINDS.OTHER_CITY,
      rateBasisPoints: hraRateBasisPoints,
    },
    providentFund: { monthlyWageCeiling: providentFund.wageCeiling, onFullBasic: policy.pfOnFullBasic },
    esiCovered: employerEsi > 0,
    earnings: {
      basic: splitAnnual(basic),
      hra: splitAnnual(hra),
      specialAllowance: splitAnnual(specialAllowance),
      gross: splitAnnual(gross),
    },
    employerContributions: {
      providentFund: splitAnnual(providentFund.annual),
      esi: splitAnnual(employerEsi),
      gratuity: splitAnnual(gratuity),
      total: splitAnnual(providentFund.annual + employerEsi + gratuity),
    },
    employeeDeductions: {
      providentFund: splitAnnual(providentFund.annual),
      esi: splitAnnual(employeeEsi),
      professionalTax: splitAnnual(professionalTax),
      incomeTax: splitAnnual(incomeTax),
      total: splitAnnual(employeeDeductionsTotal),
    },
    takeHome: splitAnnual(gross - employeeDeductionsTotal),
  };
}
