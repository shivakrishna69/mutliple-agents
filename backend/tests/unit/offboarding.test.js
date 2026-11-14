/**
 * Offboarding pieces that need no database: who holds the offboarding capabilities and the NSK
 * intent and tool, who may download which document, how HR's adjustments replace the prefill, the
 * request validators, the two PDFs' HTML (escaped, worded per separation), and the attendance and
 * leave audit workbook (its three sheets, read back with exceljs).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';

import { CAPABILITIES, ROLES, hasCapability } from '../../constants/accessRoles.js';
import { NSK_INTENTS, allowedIntentsFor } from '../../constants/nskBot.js';
import { ARTIFACT_KINDS } from '../../models/OffboardingCase.js';
import {
  AUDIT_SHEETS,
  auditPeriod,
  buildAttendanceAuditWorkbook,
  dailyLogOf,
  leaveDaysOf,
  portionOf,
  summaryOf,
} from '../../services/nskBot/offboarding/attendanceAudit.js';
import {
  compileRelievingLetterHtml,
  compileSettlementStatementHtml,
} from '../../services/nskBot/offboarding/offboardingDocuments.js';
import { settlementInputOf, toCaseSummary } from '../../services/nskBot/offboarding/offboardingService.js';
import { toolsAvailableTo } from '../../services/nskBot/nskTools.js';
import { computeFinalSettlement } from '../../utils/payroll/finalSettlement.js';
import {
  validateOffboardingCancel,
  validateOffboardingExecute,
  validateOffboardingPreview,
} from '../../validators/offboardingValidators.js';

const ID = '0123456789abcdef01234567';
const C = CAPABILITIES;
const holders = (capability) => Object.values(ROLES).filter((role) => hasCapability(role, capability));

describe('offboarding access', () => {
  it('gives each capability to the roles the plan names', () => {
    assert.deepEqual(holders(C.RUN_OFFBOARDING).sort(), [ROLES.ADMIN, ROLES.HR].sort());
    assert.deepEqual(holders(C.VIEW_FINAL_SETTLEMENT).sort(), [ROLES.ADMIN, ROLES.FINANCE, ROLES.HR].sort());
    assert.deepEqual(holders(C.VIEW_IT_OFFBOARDING).sort(), [ROLES.ADMIN, ROLES.HR, ROLES.IT_ADMIN].sort());
  });

  it('opens the offboarding intent and tool to HR and administrators only, never through headship', () => {
    for (const role of Object.values(ROLES)) {
      const allowed = role === ROLES.HR || role === ROLES.ADMIN;
      assert.equal(allowedIntentsFor(role).includes(NSK_INTENTS.OFFBOARDING_WORKFLOW), allowed, role);
      assert.equal(toolsAvailableTo(role).includes('find_offboarding_employee'), allowed, role);
      assert.equal(
        allowedIntentsFor(role, { headsDepartment: true }).includes(NSK_INTENTS.OFFBOARDING_WORKFLOW),
        allowed,
      );
      assert.equal(toolsAvailableTo(role, { headsDepartment: true }).includes('find_offboarding_employee'), allowed);
    }
  });

  it('marks which documents each role may download', () => {
    const offboardingCase = {
      _id: ID,
      __v: 2,
      employeeId: ID,
      status: 'COMPLETED',
      prefill: { salary: { source: 'payslip', payslipPeriod: '2026-10' }, finalMonthAlreadyPaid: false },
      settlement: { tax: { source: 'computed', financialYear: '2026-27', regime: 'new' }, isComplete: true },
      adjustments: {},
      settlementDueDate: '2026-11-24',
      artifacts: Object.values(ARTIFACT_KINDS).map((kind) => ({ _id: ID, kind, fileName: `${kind}.pdf` })),
    };
    const downloadable = (role) =>
      Object.fromEntries(toCaseSummary(offboardingCase, role).artifacts.map((item) => [item.kind, item.downloadable]));
    for (const role of [ROLES.HR, ROLES.ADMIN]) {
      assert.deepEqual(downloadable(role), {
        RELIEVING_LETTER: true,
        SETTLEMENT_STATEMENT: true,
        ATTENDANCE_AUDIT: true,
      });
    }
    assert.deepEqual(downloadable(ROLES.FINANCE), {
      RELIEVING_LETTER: false,
      SETTLEMENT_STATEMENT: true,
      ATTENDANCE_AUDIT: false,
    });
    for (const role of [ROLES.IT_ADMIN, ROLES.EMPLOYEE]) {
      assert.ok(
        Object.values(downloadable(role)).every((value) => value === false),
        role,
      );
    }
  });
});

describe('offboarding settlement input', () => {
  const prefill = {
    salary: { source: 'payslip', monthlyGross: 100000, monthlyBasic: 50000, regime: 'old', statutory: [] },
    noticePeriodDays: 60,
    encashableDays: 12,
    paidThisYear: { gross: 0, basic: 0, tdsDeducted: 0 },
    finalMonthAlreadyPaid: true,
  };
  const snapshot = { dateOfJoining: '2020-06-01' };
  const separation = { noticeDate: '2026-10-01', lastWorkingDay: '2026-11-20' };

  it('uses the prefill where HR changed nothing', () => {
    const input = settlementInputOf({ snapshot, separation, prefill, adjustments: {} });
    assert.deepEqual(input.salary, { monthlyGross: 100000, monthlyBasic: 50000 });
    assert.equal(input.encashableDays, 12);
    assert.equal(input.finalMonthAlreadyPaid, true);
    assert.equal(input.tax.regime, 'old');
    assert.equal(input.tax.tdsOverride, null);
  });

  it('puts HR’s figures in place of what they change', () => {
    const input = settlementInputOf({
      snapshot,
      separation,
      prefill,
      adjustments: {
        monthlyGross: 90000,
        encashableDays: 0,
        salaryDays: 5,
        tdsOverride: 0,
        noticeRecoveryWaived: true,
      },
    });
    assert.deepEqual(input.salary, { monthlyGross: 90000, monthlyBasic: 50000 });
    assert.equal(input.encashableDays, 0);
    assert.equal(input.salaryDays, 5);
    assert.equal(input.tax.tdsOverride, 0);
    assert.equal(input.noticeRecoveryWaived, true);
  });
});

describe('offboarding validators', () => {
  const body = (overrides = {}) => ({
    employeeId: ID,
    separation: { kind: 'RESIGNATION', noticeDate: '2026-10-01', lastWorkingDay: '2026-11-20' },
    ...overrides,
  });
  const fieldsOf = (result) => result.validationErrors.map((error) => error.field);

  it('accepts a preview and fills in the defaults', () => {
    const result = validateOffboardingPreview(body());
    assert.equal(result.isValid, true);
    assert.equal(result.sanitizedInput.version, null);
    assert.equal(result.sanitizedInput.adjustments.noticeRecoveryWaived, false);
    assert.deepEqual(result.sanitizedInput.adjustments.otherEarnings, []);
    assert.equal(result.sanitizedInput.separation.reason, null);
  });

  it('refuses bad ids, dates, kinds, amounts and unknown fields, naming each', () => {
    const result = validateOffboardingPreview({
      employeeId: 'nope',
      separation: { kind: 'FIRED', noticeDate: '2026-02-30', lastWorkingDay: '2026-11-20', extra: 1 },
      adjustments: {
        monthlyGross: -1,
        salaryDays: 2.5,
        tdsOverride: 10.123,
        unknown: true,
        otherDeductions: [{ label: '', amount: 5, taxable: true }],
      },
      surprise: 1,
    });
    assert.equal(result.isValid, false);
    const fields = fieldsOf(result);
    for (const field of [
      'employeeId',
      'separation.kind',
      'separation.noticeDate',
      'separation.extra',
      'adjustments.monthlyGross',
      'adjustments.salaryDays',
      'adjustments.tdsOverride',
      'adjustments.unknown',
      'adjustments.otherDeductions[0].label',
      'adjustments.otherDeductions[0].taxable',
      'surprise',
    ]) {
      assert.ok(fields.includes(field), `${field} in ${fields.join(', ')}`);
    }
  });

  it('refuses a Basic above the gross and too many lines', () => {
    const result = validateOffboardingPreview(
      body({
        adjustments: {
          monthlyGross: 1000,
          monthlyBasic: 2000,
          otherEarnings: Array.from({ length: 11 }, () => ({ label: 'x', amount: 1 })),
        },
      }),
    );
    assert.deepEqual(fieldsOf(result).sort(), ['adjustments.monthlyBasic', 'adjustments.otherEarnings'].sort());
  });

  it('requires the version to execute or cancel', () => {
    assert.equal(validateOffboardingExecute({ caseId: ID }).isValid, false);
    assert.equal(validateOffboardingExecute({ caseId: ID, version: 0 }).isValid, true);
    assert.equal(validateOffboardingCancel({ caseId: ID }, {}).isValid, false);
    assert.equal(validateOffboardingCancel({ caseId: ID }, { version: '3' }).sanitizedInput.version, 3);
  });
});

describe('offboarding documents', () => {
  const company = { name: 'NSK', legalName: 'NSK <Legal> Ltd', registeredAddress: '1 Road', brandColor: '#c75000' };
  const signatory = { name: 'Anita Rao', title: 'Head of People' };
  const employee = {
    name: 'Rahul <script>alert(1)</script>',
    employeeCode: 'NSK0104',
    designation: 'Analyst',
    departmentName: 'Engineering',
    dateOfJoining: '2020-06-01',
  };
  const separation = { kind: 'RESIGNATION', noticeDate: '2026-10-01', lastWorkingDay: '2026-11-20' };
  const service = { years: 6, months: 5, days: 20 };

  it('escapes every value in the relieving letter and words it per separation', () => {
    const html = compileRelievingLetterHtml({ company, signatory, employee, separation, service, reference: 'OFF-1' });
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /Rahul &lt;script&gt;/);
    assert.match(html, /NSK &lt;Legal&gt; Ltd/);
    assert.match(html, /resignation submitted on 1 October 2026/);
    assert.match(html, /20 November 2026/);
    assert.match(html, /6 years, 5 months, 20 days/);
    assert.match(html, /Anita Rao/);
    const retirement = compileRelievingLetterHtml({
      company,
      signatory,
      employee,
      separation: { ...separation, kind: 'RETIREMENT' },
      service,
      reference: 'OFF-1',
    });
    assert.match(retirement, /on retirement/);
    assert.doesNotMatch(retirement, /resignation/);
  });

  it('shows the banner, the lines and what is payable, or recoverable when the net is negative', () => {
    const settlement = computeFinalSettlement({
      dateOfJoining: '2020-06-01',
      lastWorkingDay: '2026-11-20',
      resignationDate: '2026-10-01',
      salary: { monthlyGross: 100000, monthlyBasic: 50000 },
      encashableDays: 0,
      noticePeriodDays: 60,
      otherDeductions: [{ label: 'Asset <b>not</b> returned', amount: 900000 }],
      tax: { regime: 'new', paidThisYear: { gross: 0, basic: 0, tdsDeducted: 0 }, tdsOverride: 0 },
    });
    const html = compileSettlementStatementHtml({
      company,
      signatory,
      employee,
      separation,
      settlement,
      complianceNote: 'Pay by 24 November 2026',
      issuedOn: '2026-11-14',
      reference: 'OFF-1',
    });
    assert.match(html, /Pay by 24 November 2026/);
    assert.match(html, /Asset &lt;b&gt;not&lt;\/b&gt; returned/);
    assert.match(html, /Net amount recoverable from the employee/);
    assert.match(html, /Income tax: as determined by HR/);
    assert.match(html, /Received and accepted by the employee/);
  });
});

describe('attendance and leave audit', () => {
  const period = { firstDate: '2026-11-02', lastDate: '2026-11-08' };
  const calendar = {
    weeklyOffRules: [{ weekday: 0, occurrencesInMonth: [] }],
    holidaysByDate: new Map([['2026-11-06', 'Founders Day']]),
  };
  const leaveTypeById = new Map([[ID, { code: 'CL', name: 'Casual Leave' }]]);
  const request = (overrides) => ({
    leaveTypeId: ID,
    startDayPortion: 'full',
    endDayPortion: 'full',
    borderCharges: [],
    createdAt: new Date('2026-10-20T00:00:00Z'),
    decision: { at: new Date('2026-10-21T00:00:00Z') },
    ...overrides,
  });
  const requests = [
    request({
      startDate: '2026-11-03',
      endDate: '2026-11-04',
      endDayPortion: 'second_half',
      days: [
        { date: '2026-11-03', chargedCentidays: 100 },
        { date: '2026-11-04', chargedCentidays: 50 },
      ],
      status: 'APPROVED',
      reason: 'Fever',
      borderCharges: [{ date: '2026-11-08', chargedCentidays: 100 }],
    }),
    request({
      startDate: '2026-11-05',
      endDate: '2026-11-05',
      days: [{ date: '2026-11-05', chargedCentidays: 100 }],
      status: 'REJECTED',
      reason: 'Trip',
    }),
    request({
      startDate: '2026-10-30',
      endDate: '2026-11-02',
      days: [
        { date: '2026-10-30', chargedCentidays: 100 },
        { date: '2026-11-02', chargedCentidays: 100 },
      ],
      status: 'PENDING',
      reason: 'Wedding',
    }),
  ];
  const attendance = [
    {
      date: '2026-11-07',
      timeZone: 'Asia/Kolkata',
      checkInTime: new Date('2026-11-07T04:00:00Z'),
      checkOutTime: new Date('2026-11-07T12:00:00Z'),
      workedMinutes: 480,
      workMode: 'office',
      calculationStatus: 'Late',
      lateByMinutes: 15,
      regularization: { reason: 'Badge failed' },
    },
  ];

  it('covers the audit months up to the last working day, or today when that is earlier', () => {
    assert.deepEqual(auditPeriod('2026-11-20', '2026-12-31'), { firstDate: '2026-08-21', lastDate: '2026-11-20' });
    assert.deepEqual(auditPeriod('2027-01-31', '2026-11-30'), { firstDate: '2026-08-31', lastDate: '2026-11-30' });
  });

  it('reads which half of a day is leave', () => {
    const halfEnd = requests[0];
    assert.equal(portionOf(halfEnd, '2026-11-04', 50), 'second_half');
    assert.equal(portionOf(halfEnd, '2026-11-03', 100), 'full');
  });

  it('lists every leave day in the period, whatever the request became, sandwich days marked', () => {
    const rows = leaveDaysOf(requests, leaveTypeById, period);
    assert.deepEqual(
      rows.map((row) => [row.date, row.status, row.portion, row.days, row.sandwich]),
      [
        ['2026-11-02', 'PENDING', 'full', 1, false],
        ['2026-11-03', 'APPROVED', 'full', 1, false],
        ['2026-11-04', 'APPROVED', 'second_half', 0.5, false],
        ['2026-11-05', 'REJECTED', 'full', 1, false],
        ['2026-11-08', 'APPROVED', 'full', 1, true],
      ],
    );
    assert.equal(rows[0].reason, 'Wedding');
  });

  it('logs each day with its attendance, approved or pending leave, and kind', () => {
    const leaveDays = leaveDaysOf(requests, leaveTypeById, period);
    const days = dailyLogOf({ period, calendar, attendance, leaveDays });
    const status = Object.fromEntries(days.map((day) => [day.date, day.status]));
    assert.deepEqual(status, {
      '2026-11-02': 'No attendance recorded',
      '2026-11-03': 'On leave',
      '2026-11-04': 'Half-day leave',
      '2026-11-05': 'No attendance recorded',
      '2026-11-06': null,
      '2026-11-07': 'Present (late)',
      '2026-11-08': 'On leave',
    });
    const pendingDay = days.find((day) => day.date === '2026-11-02');
    assert.equal(pendingDay.leave.status, 'PENDING');
    assert.equal(days.find((day) => day.date === '2026-11-05').leave, null);
    const worked = days.find((day) => day.date === '2026-11-07');
    assert.deepEqual([worked.punchIn, worked.punchOut, worked.regularized], ['09:30', '17:30', true]);
    assert.equal(days.find((day) => day.date === '2026-11-06').holidayName, 'Founders Day');

    const summary = summaryOf({ days, leaveDays });
    assert.equal(summary.calendarDays, 7);
    assert.equal(summary.holidays, 1);
    assert.equal(summary.weeklyOffs, 1);
    assert.equal(summary.present, 1);
    assert.equal(summary.late, 1);
    assert.equal(summary.regularized, 1);
    assert.equal(summary.hoursWorked, 8);
    assert.equal(summary.leaveTakenDays, 2.5);
    assert.deepEqual(summary.leaveTakenByType, [{ type: 'Casual Leave (CL)', days: 2.5 }]);
    assert.equal(summary.leavePendingDays, 1);
    assert.equal(summary.leaveRejectedOrCancelledDays, 1);
  });

  it('writes the three sheets with every reason and full or half day', async () => {
    const leaveDays = leaveDaysOf(requests, leaveTypeById, period);
    const days = dailyLogOf({ period, calendar, attendance, leaveDays });
    const bytes = await buildAttendanceAuditWorkbook(
      {
        employee: {
          name: 'Rahul',
          employeeCode: 'NSK0104',
          designation: 'Analyst',
          departmentName: null,
          officeName: null,
        },
        period,
        days,
        leaveDays,
        summary: summaryOf({ days, leaveDays }),
      },
      { companyName: 'NSK', generatedAt: new Date('2026-11-14T10:00:00Z') },
    );
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes);
    assert.deepEqual(
      workbook.worksheets.map((sheet) => sheet.name),
      [AUDIT_SHEETS.SUMMARY, AUDIT_SHEETS.DAILY_LOG, AUDIT_SHEETS.LEAVE_BREAKDOWN],
    );
    const rowsOf = (name) => {
      const rows = [];
      workbook.getWorksheet(name).eachRow((row) => rows.push(row.values.slice(1)));
      return rows;
    };
    const leave = rowsOf(AUDIT_SHEETS.LEAVE_BREAKDOWN);
    assert.equal(leave[0][0], 'Date');
    assert.equal(leave.length, 6);
    assert.ok(leave.some((row) => row.includes('Fever') && row.includes('Second half') && row.includes(0.5)));
    assert.ok(leave.some((row) => row.includes('Trip') && row.includes('Rejected')));
    assert.ok(leave.some((row) => row.includes('Non-working day charged (sandwich rule)')));
    const daily = rowsOf(AUDIT_SHEETS.DAILY_LOG);
    assert.equal(daily.length, 8);
    assert.ok(daily.some((row) => row.includes('Holiday: Founders Day')));
    assert.ok(daily.some((row) => row.includes('Badge failed')));
    const summary = rowsOf(AUDIT_SHEETS.SUMMARY);
    assert.ok(summary.some((row) => row[0] === 'Leave taken (approved, days)' && row[1] === 2.5));
    assert.equal(workbook.getWorksheet(AUDIT_SHEETS.DAILY_LOG).views[0].ySplit, 1);
  });
});
