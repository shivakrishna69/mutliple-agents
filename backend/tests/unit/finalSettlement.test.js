/**
 * The full and final settlement calculator (utils/payroll/finalSettlement.js), figure by figure:
 * the final month's salary, leave encashment (Basic ÷ 26), gratuity (15 ÷ 26 × Basic × completed
 * years after 5 years, 1 for fixed-term, ₹20 lakh at most), notice shortfall (Gross ÷ 30, editable or
 * waived), statutory deductions, TDS from the FY tax engine or HR, and the settlement due date.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { computeTaxLiability } from '../../utils/payrollCalculator.js';
import {
  computeFinalSettlement,
  defaultSalaryDays,
  financialYearOf,
  gratuityYearsOf,
  serviceLength,
  settlementDueDate,
  TDS_SOURCES,
} from '../../utils/payroll/finalSettlement.js';

const BASE = Object.freeze({
  dateOfJoining: '2020-06-01',
  lastWorkingDay: '2026-11-20',
  resignationDate: '2026-10-01',
  salary: { monthlyGross: 100000, monthlyBasic: 50000 },
  encashableDays: 10,
  noticePeriodDays: 60,
  tax: { regime: 'new', paidThisYear: { gross: 700000, basic: 350000, tdsDeducted: 0 } },
});
const settle = (overrides = {}) => computeFinalSettlement({ ...BASE, ...overrides });
const line = (lines, code) => lines.find((item) => item.code === code);
const weekdaysOnly = (date) => ![0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay());

describe('final settlement: service and dates', () => {
  it('counts completed years to the end of the last working day', () => {
    assert.deepEqual(serviceLength('2021-11-15', '2026-11-14'), { years: 5, months: 0, days: 0 });
    assert.deepEqual(serviceLength('2021-11-16', '2026-11-14'), { years: 4, months: 11, days: 30 });
    assert.deepEqual(serviceLength('2024-01-31', '2024-02-28'), { years: 0, months: 0, days: 29 });
    assert.deepEqual(serviceLength('2026-11-14', '2026-11-14'), { years: 0, months: 0, days: 1 });
  });

  it('names the financial year of a day', () => {
    assert.equal(financialYearOf('2026-04-01'), '2026-27');
    assert.equal(financialYearOf('2027-03-31'), '2026-27');
    assert.equal(financialYearOf('2026-03-31'), '2025-26');
    assert.equal(financialYearOf('2099-12-01'), '2099-00');
  });

  it('owes salary from the 1st, or from the joining day in the month someone joined', () => {
    assert.equal(defaultSalaryDays('2020-06-01', '2026-11-20'), 20);
    assert.equal(defaultSalaryDays('2026-11-10', '2026-11-20'), 11);
  });

  it('sets the due date 2 working days after the last working day, skipping days off', () => {
    assert.equal(settlementDueDate('2026-11-20', weekdaysOnly), '2026-11-24');
    assert.equal(settlementDueDate('2026-11-18', weekdaysOnly), '2026-11-20');
    const withHoliday = (date) => weekdaysOnly(date) && date !== '2026-11-23';
    assert.equal(settlementDueDate('2026-11-20', withHoliday), '2026-11-25');
  });
});

describe('final settlement: earnings', () => {
  it('prorates the final month by calendar days', () => {
    const result = settle();
    assert.equal(result.finalMonth.calendarDays, 30);
    assert.equal(result.finalMonth.salaryDays, 20);
    assert.equal(line(result.earnings, 'SALARY').amount, Math.round((100000 * 20) / 30));
    assert.equal(result.salary.proratedBasic, Math.round((50000 * 20) / 30));
  });

  it('owes no salary days for a month already paid, unless HR sets them', () => {
    const paid = settle({ finalMonthAlreadyPaid: true });
    assert.equal(line(paid.earnings, 'SALARY').amount, 0);
    assert.equal(paid.finalMonth.alreadyPaid, true);
    const edited = settle({ finalMonthAlreadyPaid: true, salaryDays: 3 });
    assert.equal(line(edited.earnings, 'SALARY').amount, 10000);
    assert.equal(edited.finalMonth.salaryDaysEdited, true);
  });

  it('encashes leave at Basic ÷ 26 a day, half days included', () => {
    assert.equal(line(settle().earnings, 'LEAVE_ENCASHMENT').amount, Math.round((50000 / 26) * 10));
    assert.equal(line(settle({ encashableDays: 12.5 }).earnings, 'LEAVE_ENCASHMENT').amount, 24038);
    assert.equal(line(settle({ encashableDays: 0 }).earnings, 'LEAVE_ENCASHMENT'), undefined);
  });

  it('pays gratuity at 15 ÷ 26 × Basic × completed years from 5 years', () => {
    const result = settle();
    assert.equal(result.gratuity.completedYears, 6);
    assert.equal(result.gratuity.amount, Math.round((15 / 26) * 50000 * 6));
    assert.equal(line(result.earnings, 'GRATUITY').amount, 173077);

    // 4 years and exactly 6 months: the part year is not more than six months.
    const fourAndAHalf = settle({ dateOfJoining: '2022-05-20', lastWorkingDay: '2026-11-19' });
    assert.deepEqual(fourAndAHalf.service, { years: 4, months: 6, days: 0 });
    assert.equal(fourAndAHalf.gratuity.completedYears, 4);
    assert.equal(fourAndAHalf.gratuity.eligible, false);
    assert.equal(line(fourAndAHalf.earnings, 'GRATUITY'), undefined);
    const exactlyFive = settle({ dateOfJoining: '2021-11-20', lastWorkingDay: '2026-11-19' });
    assert.equal(exactlyFive.gratuity.eligible, true);
    assert.equal(exactlyFive.gratuity.amount, Math.round((15 / 26) * 50000 * 5));
  });

  it('counts a final part year of more than six months as a full year', () => {
    // 4 years, 6 months and 1 day: more than six months, so 5 years and eligible.
    const justOver = settle({ dateOfJoining: '2022-05-19', lastWorkingDay: '2026-11-19' });
    assert.deepEqual(justOver.service, { years: 4, months: 6, days: 1 });
    assert.equal(justOver.gratuity.completedYears, 5);
    assert.equal(justOver.gratuity.eligible, true);
    assert.equal(justOver.gratuity.amount, Math.round((15 / 26) * 50000 * 5));
    // 240 days into the fifth year.
    const twoForty = settle({ dateOfJoining: '2021-11-21', lastWorkingDay: '2026-07-18' });
    assert.equal(twoForty.gratuity.completedYears, 5);
    assert.equal(twoForty.gratuity.eligible, true);
    // The rule applies to every year: 6 years and 7 months count as 7.
    const sixAndSeven = settle({ dateOfJoining: '2020-04-01', lastWorkingDay: '2026-10-31' });
    assert.equal(sixAndSeven.gratuity.completedYears, 7);
    assert.equal(sixAndSeven.gratuity.amount, Math.round((15 / 26) * 50000 * 7));
    assert.equal(gratuityYearsOf({ years: 2, months: 6, days: 0 }), 2);
    assert.equal(gratuityYearsOf({ years: 2, months: 7, days: 0 }), 3);
  });

  it('pays fixed-term gratuity from 1 year, and never more than ₹20 lakh', () => {
    const fixedTerm = settle({ dateOfJoining: '2025-06-01', isFixedTerm: true });
    assert.equal(fixedTerm.gratuity.eligible, true);
    assert.equal(fixedTerm.gratuity.minimumYears, 1);
    assert.equal(settle({ dateOfJoining: '2025-06-01' }).gratuity.eligible, false);
    // Fixed-term needs a whole year first: 8 months is not rounded up to qualify.
    assert.equal(settle({ dateOfJoining: '2026-03-21', isFixedTerm: true }).gratuity.eligible, false);

    const senior = settle({ dateOfJoining: '1990-01-01', salary: { monthlyGross: 900000, monthlyBasic: 500000 } });
    assert.ok(senior.gratuity.uncapped > 2_000_000);
    assert.equal(senior.gratuity.amount, 2_000_000);
    assert.equal(senior.gratuity.capped, true);
  });

  it('adds HR’s other earnings as given', () => {
    const result = settle({ otherEarnings: [{ label: 'Retention bonus', amount: 15000, taxable: true }] });
    assert.deepEqual(line(result.earnings, 'OTHER_EARNING'), {
      code: 'OTHER_EARNING',
      label: 'Retention bonus',
      amount: 15000,
    });
  });
});

describe('final settlement: deductions', () => {
  it('recovers unserved notice at Gross ÷ 30 a day', () => {
    const { notice, deductions } = settle();
    assert.equal(notice.servedDays, 51);
    assert.equal(notice.shortfallDays, 9);
    assert.equal(notice.recovery, 30000);
    assert.equal(line(deductions, 'NOTICE_RECOVERY').amount, 30000);
    assert.equal(settle({ resignationDate: '2026-09-01' }).notice.recovery, 0);
  });

  it('lets HR edit the shortfall or waive the recovery', () => {
    const edited = settle({ noticeShortfallDays: 3 });
    assert.equal(edited.notice.recovery, 10000);
    assert.equal(edited.notice.computedShortfallDays, 9);
    assert.equal(edited.notice.shortfallEdited, true);
    const waived = settle({ noticeRecoveryWaived: true });
    assert.equal(waived.notice.recovery, 0);
    assert.equal(line(waived.deductions, 'NOTICE_RECOVERY'), undefined);
  });

  it('prorates provident fund and ESI, keeps professional tax whole, and takes nothing without salary', () => {
    const statutory = [
      { code: 'EPF', label: 'Provident fund', amount: 1800, prorated: true },
      { code: 'ESI', label: 'ESI', amount: 150, prorated: true },
      { code: 'PROFESSIONAL_TAX', label: 'Professional tax', amount: 200, prorated: false },
    ];
    const result = settle({ monthlyStatutoryDeductions: statutory });
    assert.equal(line(result.deductions, 'EPF').amount, 1200);
    assert.equal(line(result.deductions, 'ESI').amount, 100);
    assert.equal(line(result.deductions, 'PROFESSIONAL_TAX').amount, 200);
    const unpaid = settle({ monthlyStatutoryDeductions: statutory, finalMonthAlreadyPaid: true });
    for (const code of ['EPF', 'ESI', 'PROFESSIONAL_TAX']) assert.equal(line(unpaid.deductions, code), undefined);
  });

  it('adds HR’s other deductions, and shows what the person owes when the net is negative', () => {
    const result = settle({
      otherDeductions: [{ label: 'Laptop not returned', amount: 500000 }],
      tax: { ...BASE.tax, tdsOverride: 0 },
    });
    assert.ok(result.totals.net < 0);
    assert.equal(result.totals.net, result.totals.earnings - result.totals.deductions);
  });
});

describe('final settlement: income tax', () => {
  it('projects the year with the tax engine and deducts what is not yet paid', () => {
    const paidThisYear = { gross: 1500000, basic: 750000, tdsDeducted: 90000 };
    const result = settle({ tax: { regime: 'new', paidThisYear } });
    const salary = line(result.earnings, 'SALARY').amount;
    const expected = computeTaxLiability(
      { annualGross: paidThisYear.gross + salary, annualBasic: paidThisYear.basic + result.salary.proratedBasic },
      null,
      'new',
      { professionalTaxState: 'NONE' },
    ).regimes.new.totalTax;
    assert.equal(result.tax.projectedAnnualTax, expected);
    assert.equal(result.tax.tds, expected - 90000);
    assert.equal(result.tax.source, TDS_SOURCES.COMPUTED);
    assert.equal(line(result.deductions, 'TDS').amount, expected - 90000);
    // Gratuity and encashment within their limits are not taxed.
    assert.equal(result.tax.taxableSettlement, salary);
  });

  it('never deducts below zero, follows the regime, and taxes only taxable other earnings', () => {
    const overPaid = settle({
      tax: { regime: 'new', paidThisYear: { gross: 700000, basic: 350000, tdsDeducted: 50000 } },
    });
    assert.equal(overPaid.tax.tds, 0);
    const old = settle({ tax: { regime: 'old', paidThisYear: { gross: 1500000, basic: 750000, tdsDeducted: 0 } } });
    assert.equal(old.tax.regime, 'old');
    const taxed = settle({
      otherEarnings: [
        { label: 'Bonus', amount: 10000, taxable: true },
        { label: 'Reimbursement', amount: 5000, taxable: false },
      ],
    });
    assert.equal(taxed.tax.taxableSettlement, line(taxed.earnings, 'SALARY').amount + 10000);
  });

  it('taxes leave encashment above ₹25 lakh', () => {
    const result = settle({ salary: { monthlyGross: 4_000_000, monthlyBasic: 2_600_000 }, encashableDays: 30 });
    const encashment = line(result.earnings, 'LEAVE_ENCASHMENT').amount;
    assert.equal(encashment, 3_000_000);
    assert.equal(result.tax.taxableSettlement, line(result.earnings, 'SALARY').amount + 500_000);
  });

  it('uses HR’s TDS when given, and is incomplete outside the engine’s years without it', () => {
    const override = settle({ tax: { ...BASE.tax, tdsOverride: 1234 } });
    assert.equal(override.tax.tds, 1234);
    assert.equal(override.tax.source, TDS_SOURCES.OVERRIDE);
    const later = settle({ lastWorkingDay: '2027-05-20', resignationDate: '2027-03-21' });
    assert.equal(later.tax.engineSupportsYear, false);
    assert.equal(later.tax.tds, null);
    assert.equal(later.tax.source, TDS_SOURCES.UNAVAILABLE);
    assert.equal(later.isComplete, false);
    assert.equal(line(later.deductions, 'TDS'), undefined);
    const laterWithOverride = settle({
      lastWorkingDay: '2027-05-20',
      resignationDate: '2027-03-21',
      tax: { ...BASE.tax, tdsOverride: 0 },
    });
    assert.equal(laterWithOverride.isComplete, true);
  });
});
