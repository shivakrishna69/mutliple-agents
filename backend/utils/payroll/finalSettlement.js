/**
 * Full and final (F&F) settlement of an employee who is leaving: what the company owes them for the
 * last month and on separation, what it recovers, and the income tax to deduct. Pure: the same
 * inputs always give the same figures, to the rupee, and nothing is read from the database (the
 * offboarding service, services/nskBot/offboarding/settlementInputs.js, gathers the inputs).
 *
 * Rules (FINAL_SETTLEMENT_RULES in ./rules.js; amounts in rupees, each line rounded to the rupee):
 *
 *   Salary for the final month   Gross ÷ calendar days of the month × salary days. Salary days run
 *                                from the 1st (or the joining day) to the last working day; 0 when
 *                                that month's payslip has already been issued; HR may set them.
 *   Leave encashment             Basic ÷ 26 × encashable days (the earned leave left; HR may edit).
 *   Gratuity                     15 ÷ 26 × last Basic × completed years, once the person has
 *                                completed 5 years (1 year in fixed-term employment), at most ₹20 lakh.
 *                                Completed years are whole years from the joining day to the end of
 *                                the last working day, with a final part year of more than six months
 *                                counted as a full year (Payment of Gratuity Act, s.4(2)): 4 years and
 *                                7 months is 5 years, and eligible. Fixed-term employment still needs
 *                                one whole year before the part year is counted.
 *   Notice shortfall recovery    Gross ÷ 30 × the notice days not served (the notice period less the
 *                                days from the resignation to the last working day). HR may edit the
 *                                days or waive the recovery.
 *   Statutory deductions         the employee's monthly provident fund and ESI as on the latest
 *                                payslip, prorated to the salary days; professional tax in full when
 *                                any salary is paid; nothing when no salary is.
 *   Income tax (TDS)             the FY tax engine (utils/payrollCalculator.js) on the year's salary
 *                                already paid plus the taxable part of the settlement, under the
 *                                person's regime, less the tax already deducted this year, never
 *                                below zero. Gratuity is exempt up to ₹20 lakh and leave encashment
 *                                up to ₹25 lakh. HR may set the TDS instead; outside the financial
 *                                years the engine supports, they must.
 *
 * Other earnings (a bonus, reimbursements) and deductions (an asset not returned, an advance) are
 * HR's own lines, added as given; an earning says whether it is taxable.
 *
 * The net may be negative: the person then owes the company that amount.
 */

import { addDaysToCalendarDate, daysBetweenCalendarDates } from '../calendarDates.js';
import { computeTaxLiability } from '../payrollCalculator.js';
import { roundToNearestRupee } from './arithmetic.js';
import { FINAL_SETTLEMENT_RULES, GRATUITY_RULES, SUPPORTED_FINANCIAL_YEAR, TAX_REGIMES } from './rules.js';

const R = FINAL_SETTLEMENT_RULES;

export const SETTLEMENT_LINE_CODES = Object.freeze({
  SALARY: 'SALARY',
  LEAVE_ENCASHMENT: 'LEAVE_ENCASHMENT',
  GRATUITY: 'GRATUITY',
  OTHER_EARNING: 'OTHER_EARNING',
  NOTICE_RECOVERY: 'NOTICE_RECOVERY',
  TDS: 'TDS',
  OTHER_DEDUCTION: 'OTHER_DEDUCTION',
});

/** Where the TDS figure came from. */
export const TDS_SOURCES = Object.freeze({
  COMPUTED: 'computed',
  OVERRIDE: 'override',
  // Outside the engine's financial years, with no figure from HR: the settlement is not complete.
  UNAVAILABLE: 'unavailable',
});

/** "2026-27" for any day from 1 April 2026 to 31 March 2027. */
export function financialYearOf(calendarDate) {
  const [year, month] = calendarDate.split('-').map(Number);
  const startYear = month >= 4 ? year : year - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

/** Whole years from `dateOfJoining` to the end of `lastWorkingDay`, and the months and days after them. */
export function serviceLength(dateOfJoining, lastWorkingDay) {
  const end = addDaysToCalendarDate(lastWorkingDay, 1);
  const [startYear, startMonth, startDay] = dateOfJoining.split('-').map(Number);
  const [endYear, endMonth, endDay] = end.split('-').map(Number);
  let months = (endYear - startYear) * 12 + (endMonth - startMonth);
  if (endDay < startDay) months -= 1;
  months = Math.max(months, 0);
  const anniversary = addMonths(dateOfJoining, months);
  return { years: Math.floor(months / 12), months: months % 12, days: daysBetweenCalendarDates(anniversary, end) };
}

/** `calendarDate` plus whole months, the day clamped to the month's last day. */
function addMonths(calendarDate, monthCount) {
  const [year, month, day] = calendarDate.split('-').map(Number);
  const target = new Date(Date.UTC(year, month - 1 + monthCount, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}

const daysInMonthOf = (calendarDate) => {
  const [year, month] = calendarDate.split('-').map(Number);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
};

/**
 * The day wages are due: `workingDays` working days after the last working day.
 * @param {string} lastWorkingDay  YYYY-MM-DD
 * @param {(calendarDate: string) => boolean} isWorkingDay
 */
export function settlementDueDate(lastWorkingDay, isWorkingDay, workingDays = R.settlementWorkingDays) {
  let date = lastWorkingDay;
  let counted = 0;
  // A year of days off in a row would be a broken calendar; stop rather than loop.
  for (let step = 0; step < 366 && counted < workingDays; step += 1) {
    date = addDaysToCalendarDate(date, 1);
    if (isWorkingDay(date)) counted += 1;
  }
  return date;
}

/** The final month's salary days: from the 1st (or the joining day) to the last working day. */
export function defaultSalaryDays(dateOfJoining, lastWorkingDay) {
  const firstOfMonth = `${lastWorkingDay.slice(0, 8)}01`;
  const start = dateOfJoining > firstOfMonth ? dateOfJoining : firstOfMonth;
  return Math.max(daysBetweenCalendarDates(start, lastWorkingDay) + 1, 0);
}

/** Years of service gratuity counts: whole years, plus one for a final part year of more than six months. */
export function gratuityYearsOf(service) {
  const moreThanSixMonths = service.months > 6 || (service.months === 6 && service.days > 0);
  return service.years + (moreThanSixMonths ? 1 : 0);
}

function gratuityOf({ monthlyBasic, service, isFixedTerm }) {
  const minimumYears = isFixedTerm ? R.fixedTermGratuityMinimumYears : R.gratuityMinimumYears;
  const completedYears = gratuityYearsOf(service);
  const eligible = isFixedTerm ? service.years >= minimumYears : completedYears >= minimumYears;
  const uncapped = eligible
    ? roundToNearestRupee(
        (GRATUITY_RULES.daysWagesPerYear / GRATUITY_RULES.workingDaysPerMonth) * monthlyBasic * completedYears,
      )
    : 0;
  const amount = Math.min(uncapped, R.gratuityCeiling);
  return { eligible, minimumYears, completedYears, uncapped, amount, capped: uncapped > amount };
}

function noticeOf({ noticePeriodDays, resignationDate, lastWorkingDay, shortfallDaysOverride, waived, monthlyGross }) {
  const servedDays = Math.max(daysBetweenCalendarDates(resignationDate, lastWorkingDay) + 1, 0);
  const computedShortfall = Math.max(noticePeriodDays - servedDays, 0);
  const shortfallDays = shortfallDaysOverride ?? computedShortfall;
  const recovery = waived ? 0 : roundToNearestRupee((monthlyGross / R.noticeRecoveryDaysPerMonth) * shortfallDays);
  return {
    periodDays: noticePeriodDays,
    servedDays,
    computedShortfallDays: computedShortfall,
    shortfallDays,
    shortfallEdited: shortfallDaysOverride !== null && shortfallDaysOverride !== undefined,
    waived,
    recovery,
  };
}

function taxOf({ tax, salary, proratedBasic, encashment, gratuity, otherEarnings, financialYear }) {
  const taxableSettlement =
    salary +
    Math.max(encashment - R.leaveEncashmentExemptionLimit, 0) +
    Math.max(gratuity - R.gratuityCeiling, 0) +
    otherEarnings.filter((line) => line.taxable).reduce((sum, line) => sum + line.amount, 0);
  const regime = tax.regime ?? TAX_REGIMES.NEW;
  const supported = financialYear === SUPPORTED_FINANCIAL_YEAR;
  let projectedAnnualTax = null;
  let computedTds = null;
  if (supported) {
    const annualGross = tax.paidThisYear.gross + taxableSettlement;
    const liability = computeTaxLiability(
      { annualGross, annualBasic: Math.min(tax.paidThisYear.basic + proratedBasic, annualGross) },
      null,
      regime,
      { professionalTaxState: 'NONE' },
    );
    projectedAnnualTax = liability.regimes[regime].totalTax;
    computedTds = Math.max(roundToNearestRupee(projectedAnnualTax - tax.paidThisYear.tdsDeducted), 0);
  }
  const hasOverride = tax.tdsOverride !== null && tax.tdsOverride !== undefined;
  let source = TDS_SOURCES.UNAVAILABLE;
  if (hasOverride) source = TDS_SOURCES.OVERRIDE;
  else if (computedTds !== null) source = TDS_SOURCES.COMPUTED;
  return {
    regime,
    financialYear,
    engineSupportsYear: supported,
    paidThisYear: tax.paidThisYear,
    taxableSettlement,
    projectedAnnualTax,
    computedTds,
    tds: hasOverride ? tax.tdsOverride : computedTds,
    source,
  };
}

/**
 * @param {{
 *   dateOfJoining: string, lastWorkingDay: string, resignationDate: string,   // YYYY-MM-DD
 *   salary: { monthlyGross: number, monthlyBasic: number },
 *   salaryDays?: number|null, finalMonthAlreadyPaid?: boolean,
 *   encashableDays: number, noticePeriodDays: number,
 *   noticeShortfallDays?: number|null, noticeRecoveryWaived?: boolean, isFixedTerm?: boolean,
 *   monthlyStatutoryDeductions?: { code: string, label: string, amount: number, prorated: boolean }[],
 *   otherEarnings?: { label: string, amount: number, taxable: boolean }[],
 *   otherDeductions?: { label: string, amount: number }[],
 *   tax: { regime: 'old'|'new'|null, paidThisYear: { gross: number, basic: number, tdsDeducted: number },
 *          tdsOverride?: number|null }
 * }} input
 */
export function computeFinalSettlement({
  dateOfJoining,
  lastWorkingDay,
  resignationDate,
  salary,
  salaryDays = null,
  finalMonthAlreadyPaid = false,
  encashableDays,
  noticePeriodDays,
  noticeShortfallDays = null,
  noticeRecoveryWaived = false,
  isFixedTerm = false,
  monthlyStatutoryDeductions = [],
  otherEarnings = [],
  otherDeductions = [],
  tax,
}) {
  const { monthlyGross, monthlyBasic } = salary;
  const calendarDays = daysInMonthOf(lastWorkingDay);
  const defaultDays = finalMonthAlreadyPaid
    ? 0
    : Math.min(defaultSalaryDays(dateOfJoining, lastWorkingDay), calendarDays);
  const paidDays = salaryDays ?? defaultDays;
  const share = paidDays / calendarDays;
  const salaryAmount = roundToNearestRupee(monthlyGross * share);
  const proratedBasic = roundToNearestRupee(monthlyBasic * share);

  const service = serviceLength(dateOfJoining, lastWorkingDay);
  const encashment = roundToNearestRupee((monthlyBasic / R.leaveEncashmentDaysPerMonth) * encashableDays);
  const gratuity = gratuityOf({ monthlyBasic, service, isFixedTerm });
  const notice = noticeOf({
    noticePeriodDays,
    resignationDate,
    lastWorkingDay,
    shortfallDaysOverride: noticeShortfallDays,
    waived: noticeRecoveryWaived,
    monthlyGross,
  });
  const statutory = monthlyStatutoryDeductions
    .map((line) => {
      let amount = 0;
      if (paidDays > 0) amount = line.prorated ? roundToNearestRupee(line.amount * share) : line.amount;
      return { code: line.code, label: line.label, amount };
    })
    .filter((line) => line.amount > 0);
  const taxResult = taxOf({
    tax,
    salary: salaryAmount,
    proratedBasic,
    encashment,
    gratuity: gratuity.amount,
    otherEarnings,
    financialYear: financialYearOf(lastWorkingDay),
  });

  const C = SETTLEMENT_LINE_CODES;
  const earnings = [
    { code: C.SALARY, label: 'Salary for the final month', amount: salaryAmount },
    { code: C.LEAVE_ENCASHMENT, label: 'Leave encashment', amount: encashment },
    { code: C.GRATUITY, label: 'Gratuity', amount: gratuity.amount },
    ...otherEarnings.map((line) => ({ code: C.OTHER_EARNING, label: line.label, amount: line.amount })),
  ].filter((line) => line.amount > 0 || line.code === C.SALARY);
  const deductions = [
    ...statutory,
    { code: C.NOTICE_RECOVERY, label: 'Notice period shortfall recovery', amount: notice.recovery },
    { code: C.TDS, label: 'Income tax (TDS)', amount: taxResult.tds ?? 0 },
    ...otherDeductions.map((line) => ({ code: C.OTHER_DEDUCTION, label: line.label, amount: line.amount })),
  ].filter((line) => line.amount > 0);
  const totalEarnings = earnings.reduce((sum, line) => sum + line.amount, 0);
  const totalDeductions = deductions.reduce((sum, line) => sum + line.amount, 0);

  return {
    service,
    finalMonth: {
      calendarDays,
      salaryDays: paidDays,
      salaryDaysEdited: salaryDays !== null,
      alreadyPaid: finalMonthAlreadyPaid,
    },
    salary: { monthlyGross, monthlyBasic, proratedBasic },
    encashment: { days: encashableDays, amount: encashment },
    gratuity,
    notice,
    tax: taxResult,
    earnings,
    deductions,
    totals: { earnings: totalEarnings, deductions: totalDeductions, net: totalEarnings - totalDeductions },
    isComplete: taxResult.tds !== null,
  };
}
