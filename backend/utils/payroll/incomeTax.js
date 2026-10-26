/**
 * Income tax for one regime: HRA, deductions, slabs, rebate, surcharge and cess.
 */

import {
  CESS_BASIS_POINTS,
  HRA_FIFTY_PERCENT_CITIES,
  NEW_REGIME_SLABS,
  OLD_REGIME_DEDUCTION_LIMITS,
  OLD_REGIME_SLABS_BY_AGE,
  REGIME_RULES,
  TAX_REGIMES,
} from './rules.js';
import { applyRate, computeSlabTax, roundToNearestRupee, roundToNearestTen, roundToPaisa } from './arithmetic.js';

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
    rentPaidMinusTenPercentOfSalary: Math.max(
      0,
      roundToPaisa(declared.annualRentPaid - applyRate(salaryForHra, 1_000)),
    ),
    percentOfSalary: applyRate(salaryForHra, isFiftyPercentCity ? 5_000 : 4_000),
  };
  return {
    exemption: Math.min(limits.actualHraReceived, limits.rentPaidMinusTenPercentOfSalary, limits.percentOfSalary),
    limits,
    isFiftyPercentCity,
  };
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

  const healthSelfFamilyLimit = declared.selfOrSpouseIsSenior
    ? limits.healthInsuranceSelfFamilySenior
    : limits.healthInsuranceSelfFamily;
  const healthParentsLimit = declared.parentIsSenior
    ? limits.healthInsuranceParentsSenior
    : limits.healthInsuranceParents;
  const employerNpsLimit = applyRate(salaryForCaps, REGIME_RULES[TAX_REGIMES.OLD].employerNpsCapBasisPoints);

  const deductionLines = [
    {
      section: 's.123 (80C/80CCC/80CCD(1))',
      claimed: roundToPaisa(section123Claimed),
      allowed: roundToPaisa(section123Allowed),
      note: `includes employee EPF ₹${annualEpf}; aggregate cap ₹1,50,000`,
    },
    {
      section: 's.124 (80CCD(1B)) additional NPS',
      claimed: additionalNps,
      allowed: additionalNps,
      note: 'cap ₹50,000',
    },
    {
      section: 's.124 (80CCD(2)) employer NPS',
      claimed: salary.annualEmployerNpsContribution,
      allowed: Math.min(salary.annualEmployerNpsContribution, employerNpsLimit),
      note: '10% of basic + DA',
    },
    {
      section: 's.126 (80D) health insurance, self/family',
      claimed: declared.healthInsuranceSelfFamily,
      allowed: Math.min(declared.healthInsuranceSelfFamily, healthSelfFamilyLimit),
      note: `cap ₹${healthSelfFamilyLimit}`,
    },
    {
      section: 's.126 (80D) health insurance, parents',
      claimed: declared.healthInsuranceParents,
      allowed: Math.min(declared.healthInsuranceParents, healthParentsLimit),
      note: `cap ₹${healthParentsLimit}`,
    },
    {
      section: 's.129 (80E) education-loan interest',
      claimed: declared.educationLoanInterest,
      allowed: declared.educationLoanInterest,
      note: 'no cap',
    },
    {
      section: 's.22 (24(b)) self-occupied home-loan interest',
      claimed: declared.selfOccupiedHomeLoanInterest,
      allowed: Math.min(declared.selfOccupiedHomeLoanInterest, limits.selfOccupiedHomeLoanInterest),
      note: 'cap ₹2,00,000',
    },
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
  return {
    surchargeRatePercent: rateBasisPoints / 100,
    surcharge: roundToPaisa(grossSurcharge - marginalRelief),
    marginalRelief,
  };
}

export function computeRegimeTax(regime, normalizedInputs, statutoryDeductions) {
  const { salary, employment } = normalizedInputs;
  const rules = REGIME_RULES[regime];
  const salaryForCaps = salary.annualBasic + salary.annualDearnessAllowance;

  // ---- Salary income ---------------------------------------------------------------------------
  // The employer's NPS contribution is part of salary income and then deducted (up to the cap).
  const grossSalaryIncome = salary.annualGross + salary.annualEmployerNpsContribution;
  const hra =
    regime === TAX_REGIMES.OLD
      ? computeHraExemption(normalizedInputs)
      : { exemption: 0, limits: null, isFiftyPercentCity: null };
  const salaryAfterExemptions = roundToPaisa(grossSalaryIncome - hra.exemption);
  const standardDeduction = Math.min(rules.standardDeduction, salaryAfterExemptions);
  const professionalTaxDeduction = regime === TAX_REGIMES.OLD ? statutoryDeductions.professionalTax.annualAmount : 0;
  const incomeFromSalary = Math.max(
    0,
    roundToPaisa(salaryAfterExemptions - standardDeduction - professionalTaxDeduction),
  );

  // ---- Deductions ------------------------------------------------------------------------------
  const deductionLines =
    regime === TAX_REGIMES.OLD
      ? computeOldRegimeDeductions(normalizedInputs, statutoryDeductions.epf.annualEmployeeContribution)
      : [
          {
            section: 's.124 (80CCD(2)) employer NPS',
            claimed: salary.annualEmployerNpsContribution,
            allowed: Math.min(
              salary.annualEmployerNpsContribution,
              applyRate(salaryForCaps, rules.employerNpsCapBasisPoints),
            ),
            note: '14% of basic + DA; the only deduction from salary income allowed under the new regime',
          },
        ];
  // Home-loan interest is a loss under "house property" set off against salary; the other lines are
  // deductions from gross total income. Both reduce total income and are capped by it.
  const totalDeductionsAllowed = roundToPaisa(
    deductionLines.reduce((runningTotal, deductionLine) => runningTotal + deductionLine.allowed, 0),
  );
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
