/**
 * Payslip data calculation: the first stage of the payslip pipeline (services/payslipService.js).
 *
 *   employee record + salary structure + investments + regime
 *        │  computeTaxLiability (utils/payrollCalculator.js): EPF, ESI and professional tax for every
 *        │  month of FY 2026-27, and the annual tax under the employee's chosen regime
 *        ▼
 *   PayslipFigures: the month's earnings and deductions as printed, totals, net pay in words
 *
 * Pure calculation: no HTML, no I/O, no clock. The HTML compiler (payslipHtmlTemplate.js) only
 * formats these figures, and the Payslip document stores them, so the PDF and the database can
 * never disagree about a number.
 *
 * Arithmetic is done in paise (integers) and converted to rupees at the end, so the printed lines
 * add up exactly to the printed totals.
 *
 * Earnings for the month
 *   Basic, Dearness Allowance and House Rent Allowance are one twelfth of their annual amounts; the
 *   Special Allowance is the rest of the annual gross, also divided by twelve. Monthly gross is the
 *   sum of the printed lines (so it may differ from annualGross / 12 by a paisa of rounding).
 * Deductions for the month
 *   EPF       the month's employee contribution from the payroll calculator, including the
 *             September 2026 split between the ₹15,000 and ₹25,000 wage ceilings
 *   ESI       the month's employee share, when the employee is covered
 *   PT        the month's professional tax for the employee's state (₹300 in February in KA/MH)
 *   TDS       income tax deducted at source: the projected annual tax under the employee's chosen
 *             regime divided evenly over the 12 months (see the note on TDS below)
 *   TDS note: real payroll re-projects TDS each month from year-to-date pay and proofs. This
 *   builder uses the even split of the annual projection, which matches when salary and
 *   declarations do not change during the year.
 */

import { PayrollInputError, computeTaxLiability, SUPPORTED_FINANCIAL_YEAR } from '../utils/payrollCalculator.js';

/** The calendar months of FY 2026-27. */
const FINANCIAL_YEAR_PERIODS = Object.freeze([
  [2026, 4], [2026, 5], [2026, 6], [2026, 7], [2026, 8], [2026, 9], [2026, 10], [2026, 11], [2026, 12], [2027, 1], [2027, 2], [2027, 3],
]);

const MONTH_NAMES = Object.freeze(['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']);

const rupeesToPaise = (rupees) => Math.round(rupees * 100);
const paiseToRupees = (paise) => paise / 100;

// =================================================================================================
// Amount in words (Indian numbering: thousand, lakh, crore)
// =================================================================================================

const UNIT_WORDS = Object.freeze(['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen']);
const TENS_WORDS = Object.freeze(['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety']);

/** 0-99 in words ("Forty-Five"). */
function twoDigitWords(number) {
  if (number < 20) return UNIT_WORDS[number];
  const tens = TENS_WORDS[Math.floor(number / 10)];
  const units = UNIT_WORDS[number % 10];
  return units ? `${tens}-${units}` : tens;
}

/** 0-999 in words ("Three Hundred Forty-Five"). */
function threeDigitWords(number) {
  const hundreds = Math.floor(number / 100);
  const remainder = number % 100;
  return [hundreds ? `${UNIT_WORDS[hundreds]} Hundred` : '', remainder ? twoDigitWords(remainder) : ''].filter(Boolean).join(' ');
}

/** A whole number of rupees in Indian-system words ("One Lakh Twenty Thousand Five Hundred"). */
function wholeNumberInIndianWords(number) {
  if (number === 0) return 'Zero';
  const crores = Math.floor(number / 10_000_000);
  const lakhs = Math.floor((number % 10_000_000) / 100_000);
  const thousands = Math.floor((number % 100_000) / 1_000);
  const hundredsPart = number % 1_000;
  return [
    crores ? `${crores >= 100 ? wholeNumberInIndianWords(crores) : twoDigitWords(crores)} Crore` : '',
    lakhs ? `${twoDigitWords(lakhs)} Lakh` : '',
    thousands ? `${twoDigitWords(thousands)} Thousand` : '',
    hundredsPart ? threeDigitWords(hundredsPart) : '',
  ]
    .filter(Boolean)
    .join(' ');
}

/** "Rupees Forty-Five Thousand Six Hundred and Fifty Paise Only" */
export function amountInIndianWords(paise) {
  const rupees = Math.floor(paise / 100);
  const remainingPaise = paise % 100;
  const rupeesPart = `Rupees ${wholeNumberInIndianWords(rupees)}`;
  return remainingPaise ? `${rupeesPart} and ${twoDigitWords(remainingPaise)} Paise Only` : `${rupeesPart} Only`;
}

// =================================================================================================
// Builder
// =================================================================================================

const formatRupees = (amount) => `₹${amount.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

/**
 * Builds the month's payslip figures.
 * @param {object} buildInput
 * @param {{ employeeId: string, name: string, designation: string, departmentName: string|null,
 *           officeName: string|null, dateOfJoining: string }} buildInput.employee
 * @param {{ year: number, month: number }} buildInput.period
 * @param {object} buildInput.salaryStructure      as computeTaxLiability (annual amounts)
 * @param {object|null} buildInput.investmentsDeclared
 * @param {'old'|'new'} buildInput.taxRegimeChoice  the regime the employee has opted for; TDS follows it
 * @param {object} buildInput.employmentDetails
 * @returns {object} PayslipFigures
 * @throws {PayrollInputError} invalid salary inputs, a period outside FY 2026-27, or a period before joining
 */
export function buildPayslipFigures({ employee, period, salaryStructure, investmentsDeclared, taxRegimeChoice, employmentDetails }) {
  const isSupportedPeriod = FINANCIAL_YEAR_PERIODS.some(([year, month]) => year === period.year && month === period.month);
  if (!isSupportedPeriod) {
    throw new PayrollInputError([{ field: 'period', message: `must be a month of FY ${SUPPORTED_FINANCIAL_YEAR} (April 2026 to March 2027)` }]);
  }
  const periodLabel = `${period.year}-${String(period.month).padStart(2, '0')}`;
  const daysInMonth = new Date(Date.UTC(period.year, period.month, 0)).getUTCDate();
  const periodEndDate = `${periodLabel}-${String(daysInMonth).padStart(2, '0')}`;
  if (employee.dateOfJoining > periodEndDate) {
    throw new PayrollInputError([{ field: 'period', message: `is before the employee's date of joining (${employee.dateOfJoining})` }]);
  }

  const estimate = computeTaxLiability(salaryStructure, investmentsDeclared, taxRegimeChoice, employmentDetails);
  const chosenRegimeResult = estimate.regimes[estimate.chosenRegime.regime];
  const { epf, esi, professionalTax } = estimate.statutoryDeductions;

  // ---- Earnings (paise) ----------------------------------------------------------------------
  const annualBasic = salaryStructure.annualBasic;
  const annualDearnessAllowance = salaryStructure.annualDearnessAllowance ?? 0;
  const annualHra = salaryStructure.annualHraReceived ?? 0;
  const annualSpecialAllowance = salaryStructure.annualGross - annualBasic - annualDearnessAllowance - annualHra;
  const earningLines = [
    { code: 'BASIC', label: 'Basic Salary', paise: rupeesToPaise(annualBasic / 12) },
    { code: 'DA', label: 'Dearness Allowance', paise: rupeesToPaise(annualDearnessAllowance / 12) },
    { code: 'HRA', label: 'House Rent Allowance', paise: rupeesToPaise(annualHra / 12) },
    { code: 'SPECIAL', label: 'Special Allowance', paise: rupeesToPaise(annualSpecialAllowance / 12) },
  ].filter((earningLine) => earningLine.paise > 0 || earningLine.code === 'BASIC');

  // ---- Deductions (paise) --------------------------------------------------------------------
  const deductionLines = [];
  const epfMonth = epf.months.find((monthEntry) => monthEntry.month === periodLabel);
  if (epfMonth) {
    const ceilingNote = epf.contributionOnFullBasic
      ? 'on full basic + DA (voluntary)'
      : `on wages up to the ceiling (${epfMonth.ceilingSegments.map((segment) => `${formatRupees(segment.monthlyCeiling)} for ${segment.days} days`).join(', ')})`;
    deductionLines.push({ code: 'EPF', label: 'Provident Fund (EPF)', paise: rupeesToPaise(epfMonth.employeeContribution), reference: `12% of ${formatRupees(epfMonth.contributoryWages)} ${ceilingNote}` });
  }
  if (esi.isCovered) {
    const esiMonth = esi.months.find((monthEntry) => monthEntry.month === periodLabel);
    deductionLines.push({
      code: 'ESI',
      label: 'Employees’ State Insurance',
      paise: rupeesToPaise(esiMonth.employeeContribution),
      reference: esiMonth.employeeShareExempt ? 'employee share exempt (average daily wage ≤ ₹176)' : '0.75% of gross wages',
    });
  }
  if (professionalTax.state !== 'NONE') {
    const professionalTaxMonth = professionalTax.months.find((monthEntry) => monthEntry.month === periodLabel);
    deductionLines.push({ code: 'PROFESSIONAL_TAX', label: 'Professional Tax', paise: rupeesToPaise(professionalTaxMonth.amount), reference: `${professionalTax.state === 'KA' ? 'Karnataka' : 'Maharashtra'} slab` });
  }
  deductionLines.push({
    code: 'TDS',
    label: 'Income Tax (TDS)',
    paise: rupeesToPaise(chosenRegimeResult.monthlyTds),
    reference: `${estimate.chosenRegime.regime} regime: projected annual tax ${formatRupees(chosenRegimeResult.totalTax)} ÷ 12`,
  });

  // ---- Totals --------------------------------------------------------------------------------
  const grossPaise = earningLines.reduce((runningTotal, earningLine) => runningTotal + earningLine.paise, 0);
  const deductionsPaise = deductionLines.reduce((runningTotal, deductionLine) => runningTotal + deductionLine.paise, 0);
  const netPaise = grossPaise - deductionsPaise;
  if (netPaise < 0) {
    throw new PayrollInputError([{ field: 'salaryStructure', message: 'deductions exceed gross pay for the month' }]);
  }

  const toAmountLine = ({ paise, ...lineFields }) => ({ ...lineFields, amount: paiseToRupees(paise), reference: lineFields.reference ?? null });
  return {
    financialYear: SUPPORTED_FINANCIAL_YEAR,
    period: { year: period.year, month: period.month, label: `${MONTH_NAMES[period.month - 1]} ${period.year}`, daysInMonth },
    employee,
    earnings: earningLines.map(toAmountLine),
    deductions: deductionLines.map(toAmountLine),
    grossEarnings: paiseToRupees(grossPaise),
    totalDeductions: paiseToRupees(deductionsPaise),
    netPay: paiseToRupees(netPaise),
    netPayInWords: amountInIndianWords(netPaise),
    taxSummary: {
      regime: estimate.chosenRegime.regime,
      annualTaxableIncome: chosenRegimeResult.taxableIncome,
      projectedAnnualTax: chosenRegimeResult.totalTax,
      monthlyTds: chosenRegimeResult.monthlyTds,
      recommendedRegime: estimate.recommendation.recommendedRegime,
    },
  };
}
