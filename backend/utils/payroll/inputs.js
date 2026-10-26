/**
 * Validation and normalisation of the payroll calculator inputs.
 */

import {
  AGE_CATEGORIES,
  HRA_CITY_ALIASES,
  PROFESSIONAL_TAX_STATES,
  SUPPORTED_FINANCIAL_YEAR,
  TAX_REGIMES,
} from './rules.js';

// =================================================================================================
// Input validation
// =================================================================================================

/** Thrown for invalid input; `fieldErrors` lists every problem found. */
export class PayrollInputError extends Error {
  constructor(fieldErrors) {
    super(
      `Invalid payroll input: ${fieldErrors.map((fieldError) => `${fieldError.field}: ${fieldError.message}`).join('; ')}`,
    );
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
    typeof rawValue === 'number' &&
    Number.isFinite(rawValue) &&
    rawValue >= 0 &&
    rawValue <= MAXIMUM_ANNUAL_AMOUNT &&
    Math.abs(Math.round(rawValue * 100) - rawValue * 100) < 1e-6;
  if (!isValidAmount) {
    fieldErrors.push({
      field: fieldPath,
      message: 'must be a non-negative amount in rupees with at most 2 decimal places',
    });
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

export function normalizeInputs(salaryStructure, investmentsDeclared, taxRegimeChoice, employmentDetails) {
  const fieldErrors = [];
  const isObject = (candidateValue) =>
    typeof candidateValue === 'object' && candidateValue !== null && !Array.isArray(candidateValue);
  if (!isObject(salaryStructure)) fieldErrors.push({ field: 'salaryStructure', message: 'must be an object' });
  if (investmentsDeclared !== undefined && investmentsDeclared !== null && !isObject(investmentsDeclared)) {
    fieldErrors.push({ field: 'investmentsDeclared', message: 'must be an object' });
  }
  if (!isObject(employmentDetails)) fieldErrors.push({ field: 'employmentDetails', message: 'must be an object' });
  if (fieldErrors.length > 0) throw new PayrollInputError(fieldErrors);

  const investments = investmentsDeclared ?? {};
  const salary = {
    annualGross: readAmount(salaryStructure, 'annualGross', 'salaryStructure.annualGross', fieldErrors, {
      required: true,
    }),
    annualBasic: readAmount(salaryStructure, 'annualBasic', 'salaryStructure.annualBasic', fieldErrors, {
      required: true,
    }),
    annualDearnessAllowance: readAmount(
      salaryStructure,
      'annualDearnessAllowance',
      'salaryStructure.annualDearnessAllowance',
      fieldErrors,
    ),
    annualHraReceived: readAmount(
      salaryStructure,
      'annualHraReceived',
      'salaryStructure.annualHraReceived',
      fieldErrors,
    ),
    annualEmployerNpsContribution: readAmount(
      salaryStructure,
      'annualEmployerNpsContribution',
      'salaryStructure.annualEmployerNpsContribution',
      fieldErrors,
    ),
  };
  if (salary.annualBasic + salary.annualDearnessAllowance + salary.annualHraReceived > salary.annualGross) {
    fieldErrors.push({
      field: 'salaryStructure',
      message: 'basic + DA + HRA cannot exceed annualGross (gross must include every salary component)',
    });
  }

  const declared = {
    section123Investments: readAmount(
      investments,
      'section123Investments',
      'investmentsDeclared.section123Investments',
      fieldErrors,
    ),
    employeeNpsContribution: readAmount(
      investments,
      'employeeNpsContribution',
      'investmentsDeclared.employeeNpsContribution',
      fieldErrors,
    ),
    healthInsuranceSelfFamily: readAmount(
      investments,
      'healthInsuranceSelfFamily',
      'investmentsDeclared.healthInsuranceSelfFamily',
      fieldErrors,
    ),
    selfOrSpouseIsSenior: readBoolean(
      investments,
      'selfOrSpouseIsSenior',
      'investmentsDeclared.selfOrSpouseIsSenior',
      fieldErrors,
    ),
    healthInsuranceParents: readAmount(
      investments,
      'healthInsuranceParents',
      'investmentsDeclared.healthInsuranceParents',
      fieldErrors,
    ),
    parentIsSenior: readBoolean(investments, 'parentIsSenior', 'investmentsDeclared.parentIsSenior', fieldErrors),
    educationLoanInterest: readAmount(
      investments,
      'educationLoanInterest',
      'investmentsDeclared.educationLoanInterest',
      fieldErrors,
    ),
    selfOccupiedHomeLoanInterest: readAmount(
      investments,
      'selfOccupiedHomeLoanInterest',
      'investmentsDeclared.selfOccupiedHomeLoanInterest',
      fieldErrors,
    ),
    annualRentPaid: readAmount(investments, 'annualRentPaid', 'investmentsDeclared.annualRentPaid', fieldErrors),
    rentedCity: null,
  };
  if (investments.rentedCity !== undefined && investments.rentedCity !== null) {
    if (
      typeof investments.rentedCity !== 'string' ||
      investments.rentedCity.trim().length === 0 ||
      investments.rentedCity.length > 100
    ) {
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
    fieldErrors.push({
      field: 'taxRegimeChoice',
      message: 'must be "old" or "new" (both are always computed; this marks the regime the employee has opted for)',
    });
  }

  const employment = {
    financialYear: employmentDetails.financialYear ?? SUPPORTED_FINANCIAL_YEAR,
    ageCategory: employmentDetails.ageCategory ?? AGE_CATEGORIES.BELOW_60,
    professionalTaxState: employmentDetails.professionalTaxState,
    gender: employmentDetails.gender,
    isPersonWithDisability: readBoolean(
      employmentDetails,
      'isPersonWithDisability',
      'employmentDetails.isPersonWithDisability',
      fieldErrors,
    ),
    epfContributionOnFullBasic: readBoolean(
      employmentDetails,
      'epfContributionOnFullBasic',
      'employmentDetails.epfContributionOnFullBasic',
      fieldErrors,
    ),
    isEpfMember:
      employmentDetails.isEpfMember === undefined
        ? true
        : readBoolean(employmentDetails, 'isEpfMember', 'employmentDetails.isEpfMember', fieldErrors),
  };
  if (employment.financialYear !== SUPPORTED_FINANCIAL_YEAR) {
    fieldErrors.push({
      field: 'employmentDetails.financialYear',
      message: `only ${SUPPORTED_FINANCIAL_YEAR} is supported; other years have different rates`,
    });
  }
  if (!Object.values(AGE_CATEGORIES).includes(employment.ageCategory)) {
    fieldErrors.push({
      field: 'employmentDetails.ageCategory',
      message: 'must be below60, senior (60-79) or superSenior (80+)',
    });
  }
  if (!Object.values(PROFESSIONAL_TAX_STATES).includes(employment.professionalTaxState)) {
    fieldErrors.push({
      field: 'employmentDetails.professionalTaxState',
      message: 'must be KA, MH, or NONE (state with no professional tax); other states are not modelled',
    });
  }
  if (
    employment.professionalTaxState === PROFESSIONAL_TAX_STATES.MAHARASHTRA &&
    !['male', 'female', 'other'].includes(employment.gender)
  ) {
    fieldErrors.push({
      field: 'employmentDetails.gender',
      message: 'is required for Maharashtra professional tax (male, female or other)',
    });
  }

  if (fieldErrors.length > 0) throw new PayrollInputError(fieldErrors);
  return { salary, declared, regimeChoice, employment };
}
