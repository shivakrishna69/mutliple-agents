/**
 * What the full and final settlement of one employee starts from (the prefill), read from the
 * portal's records; HR's adjustments then change any of it (offboardingService.js), and
 * utils/payroll/finalSettlement.js computes the figures.
 *
 *   salary             the latest issued payslip's gross and Basic (+ DA) a month, and its provident
 *                      fund, ESI and professional tax; without a payslip, the accepted offer's salary
 *                      structure (the dispatched offer whose employee this is); without either, none
 *                      (HR must enter the salary)
 *   tax regime         the latest payslip's, else the offer's, else the new regime
 *   notice period      the accepted offer's, else the onboarding settings' default
 *   encashable days    the available balance of every leave type that may be encashed
 *   paid this year     the gross, Basic (+ DA) and TDS of the payslips issued in the financial year of
 *                      the last working day
 *   final month paid   whether that month's payslip has already been issued (then no salary days
 *                      are owed for it)
 */

import LeaveType from '../../../models/LeaveType.js';
import OnboardingDraft, { DRAFT_STATUSES } from '../../../models/OnboardingDraft.js';
import Payslip, { PAYSLIP_STATUSES } from '../../../models/Payslip.js';
import { SALARY_SOURCES } from '../../../models/OffboardingCase.js';
import { financialYearOf } from '../../../utils/payroll/finalSettlement.js';
import { TAX_REGIMES } from '../../../utils/payroll/rules.js';
import { getEmployeeBalances } from '../../leaveBalances.js';
import { getOnboardingSettings } from '../../onboardingService.js';

// Payslip lines that make up the Basic for gratuity and encashment (Basic + dearness allowance).
const BASIC_CODES = Object.freeze(['BASIC', 'DA']);
// Payslip deductions carried into the final month, and whether they follow the salary days.
const STATUTORY_LINES = Object.freeze([
  { code: 'EPF', label: 'Provident fund', prorated: true },
  { code: 'ESI', label: 'ESI', prorated: true },
  { code: 'PROFESSIONAL_TAX', label: 'Professional tax', prorated: false },
]);
const TDS_CODE = 'TDS';

const sumOf = (lines, codes) =>
  lines.filter((line) => codes.includes(line.code)).reduce((sum, line) => sum + line.amount, 0);

function fromPayslip(payslip) {
  return {
    source: SALARY_SOURCES.PAYSLIP,
    payslipId: payslip._id.toString(),
    payslipPeriod: `${payslip.period.year}-${String(payslip.period.month).padStart(2, '0')}`,
    monthlyGross: payslip.grossEarnings,
    monthlyBasic: sumOf(payslip.earnings, BASIC_CODES),
    regime: payslip.taxSummary.regime,
    statutory: STATUTORY_LINES.map((line) => ({ ...line, amount: sumOf(payslip.deductions, [line.code]) })).filter(
      (line) => line.amount > 0,
    ),
  };
}

function fromOffer(draft) {
  const { earnings, employeeDeductions } = draft.structure;
  const monthly = {
    EPF: employeeDeductions?.providentFund?.monthly ?? 0,
    ESI: employeeDeductions?.esi?.monthly ?? 0,
    PROFESSIONAL_TAX: employeeDeductions?.professionalTax?.monthly ?? 0,
  };
  return {
    source: SALARY_SOURCES.OFFER,
    offerId: draft._id.toString(),
    monthlyGross: earnings.gross.monthly,
    monthlyBasic: earnings.basic.monthly,
    regime: draft.compensation.taxRegime,
    statutory: STATUTORY_LINES.map((line) => ({ ...line, amount: monthly[line.code] })).filter(
      (line) => line.amount > 0,
    ),
  };
}

const NO_SALARY = Object.freeze({
  source: SALARY_SOURCES.NONE,
  monthlyGross: 0,
  monthlyBasic: 0,
  regime: null,
  statutory: [],
});

/** The accepted offer: the dispatched draft that created this person's account. */
function acceptedOfferOf(profile) {
  return OnboardingDraft.findOne({ status: DRAFT_STATUSES.DISPATCHED, 'dispatch.employeeUserId': profile.userId })
    .sort({ 'dispatch.dispatchedAt': -1 })
    .select('structure compensation.taxRegime terms.noticePeriodDays')
    .lean();
}

async function encashableDaysOf(profile, now) {
  const [balances, encashableTypes] = await Promise.all([
    getEmployeeBalances({ employeeId: profile._id, leaveYear: null, now }),
    LeaveType.find({ 'encashment.isEncashable': true }).select('_id').lean(),
  ]);
  const encashable = new Set(encashableTypes.map((leaveType) => leaveType._id.toString()));
  const days = balances.balances
    .filter((balance) => encashable.has(balance.leaveType.id))
    .reduce((sum, balance) => sum + Math.max(balance.availableDays, 0), 0);
  return Math.round(days * 100) / 100;
}

async function paidThisYearOf(profile, financialYear) {
  const payslips = await Payslip.find({ employeeId: profile._id, status: PAYSLIP_STATUSES.ISSUED, financialYear })
    .select('earnings deductions grossEarnings')
    .lean();
  return {
    gross: payslips.reduce((sum, payslip) => sum + payslip.grossEarnings, 0),
    basic: payslips.reduce((sum, payslip) => sum + sumOf(payslip.earnings, BASIC_CODES), 0),
    tdsDeducted: payslips.reduce((sum, payslip) => sum + sumOf(payslip.deductions, [TDS_CODE]), 0),
    payslips: payslips.length,
  };
}

/**
 * @param {{ profile: object, lastWorkingDay: string, now: Date }} input  profile: a lean EmployeeProfile
 * @returns {Promise<object>}  stored on the case as `prefill`
 */
export async function loadSettlementPrefill({ profile, lastWorkingDay, now }) {
  const [year, month] = lastWorkingDay.split('-').map(Number);
  const [latestPayslip, offer, settings, encashableDays, paidThisYear, finalMonthPayslip] = await Promise.all([
    Payslip.findOne({ employeeId: profile._id, status: PAYSLIP_STATUSES.ISSUED })
      .sort({ 'period.year': -1, 'period.month': -1 })
      .select('period earnings deductions grossEarnings taxSummary.regime')
      .lean(),
    acceptedOfferOf(profile),
    getOnboardingSettings(),
    encashableDaysOf(profile, now),
    paidThisYearOf(profile, financialYearOf(lastWorkingDay)),
    Payslip.exists({
      employeeId: profile._id,
      status: PAYSLIP_STATUSES.ISSUED,
      'period.year': year,
      'period.month': month,
    }),
  ]);
  let salary = NO_SALARY;
  if (latestPayslip) salary = fromPayslip(latestPayslip);
  else if (offer) salary = fromOffer(offer);
  return {
    salary: { ...salary, regime: salary.regime ?? TAX_REGIMES.NEW },
    noticePeriodDays: offer?.terms?.noticePeriodDays ?? settings.offerTerms.noticePeriodDays,
    noticePeriodSource: offer ? SALARY_SOURCES.OFFER : 'settings',
    encashableDays,
    paidThisYear,
    finalMonthAlreadyPaid: Boolean(finalMonthPayslip),
  };
}
