/**
 * Statutory payroll deductions: EPF, professional tax and ESI, month by month.
 */

import {
  EPF_EMPLOYEE_RATE_BASIS_POINTS,
  EPF_WAGE_CEILING_SCHEDULE,
  ESI_RULES,
  FINANCIAL_YEAR_MONTHS,
  PROFESSIONAL_TAX_ANNUAL_CAP,
  PROFESSIONAL_TAX_STATES,
} from './rules.js';
import { applyRate, roundToNearestRupee, roundToPaisa, roundUpToRupee } from './arithmetic.js';

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
    ceilingSegments: ceilingSegments.map((ceilingSegment) => ({
      monthlyCeiling: ceilingSegment.monthlyCeiling,
      days: ceilingSegment.days,
    })),
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

export function computeStatutoryDeductions({ salary, employment }) {
  const monthlyGross = salary.annualGross / 12;
  const monthlyEpfWages = (salary.annualBasic + salary.annualDearnessAllowance) / 12;

  // ---- EPF -------------------------------------------------------------------------------------
  const epfMonths = employment.isEpfMember
    ? FINANCIAL_YEAR_MONTHS.map((payrollMonth) =>
        computeMonthlyEpf(monthlyEpfWages, payrollMonth, employment.epfContributionOnFullBasic),
      )
    : [];
  const annualEpf = epfMonths.reduce((runningTotal, epfMonth) => runningTotal + epfMonth.employeeContribution, 0);

  // ---- Professional tax ------------------------------------------------------------------------
  const professionalTaxMonths = FINANCIAL_YEAR_MONTHS.map((payrollMonth) => ({
    month: payrollMonth.label,
    amount: computeMonthlyProfessionalTax(
      employment.professionalTaxState,
      employment.gender,
      monthlyGross,
      payrollMonth,
    ),
  }));
  const annualProfessionalTax = Math.min(
    professionalTaxMonths.reduce((runningTotal, professionalTaxMonth) => runningTotal + professionalTaxMonth.amount, 0),
    PROFESSIONAL_TAX_ANNUAL_CAP,
  );

  // ---- ESI -------------------------------------------------------------------------------------
  const esiWageCeiling = employment.isPersonWithDisability
    ? ESI_RULES.monthlyWageCeilingForPersonsWithDisability
    : ESI_RULES.monthlyWageCeiling;
  const isEsiCovered = monthlyGross <= esiWageCeiling;
  // The ₹176 average daily wage is measured over the six-month contribution period (wages ÷ days in
  // the period), the same unit as coverage; a per-month measure would wrongly make February (28
  // days) cross the limit on its own.
  const contributionPeriods = [FINANCIAL_YEAR_MONTHS.slice(0, 6), FINANCIAL_YEAR_MONTHS.slice(6, 12)];
  const esiMonths = isEsiCovered
    ? contributionPeriods.flatMap((periodMonths) => {
        const daysInPeriod = periodMonths.reduce(
          (runningTotal, payrollMonth) => runningTotal + payrollMonth.daysInMonth,
          0,
        );
        const averageDailyWage = (monthlyGross * periodMonths.length) / daysInPeriod;
        const isEmployeeShareExempt = averageDailyWage <= ESI_RULES.exemptAverageDailyWage;
        return periodMonths.map((payrollMonth) => ({
          month: payrollMonth.label,
          employeeContribution: isEmployeeShareExempt
            ? 0
            : roundUpToRupee(applyRate(monthlyGross, ESI_RULES.employeeRateBasisPoints)),
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
    professionalTax: {
      state: employment.professionalTaxState,
      annualAmount: annualProfessionalTax,
      months: professionalTaxMonths,
    },
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
