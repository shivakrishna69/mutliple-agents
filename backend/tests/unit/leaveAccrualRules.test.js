/**
 * Leave days, leave years and accrual rules. Amounts are centidays (1.25 days = 125); every
 * expectation is worked out by hand. Leave years start in April unless stated.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { EMPLOYMENT_STATUSES } from '../../models/EmployeeProfile.js';
import { ACCRUAL_METHODS, ACCRUAL_TIMINGS, YEAR_END_EXCESS_ACTIONS } from '../../models/LeaveType.js';
import {
  dueAccrualCredits,
  isAccruingStatus,
  scheduledMonthlyCentidays,
  yearEndMovements,
} from '../../services/leaveAccrualRules.js';
import { leaveYearOfDate, leaveYearRange, monthRange, monthsOfLeaveYear } from '../../services/leaveYear.js';
import { daysToCentidays, isWholeCentidays, roundCentidaysToStep } from '../../utils/leaveDays.js';

const APRIL = 4;
const monthly = (annualQuotaCentidays, accrualTiming) => ({
  accrualMethod: ACCRUAL_METHODS.MONTHLY,
  annualQuotaCentidays,
  accrualTiming,
  proRataRoundingStepCentidays: 50,
});
const CASUAL = monthly(1200, ACCRUAL_TIMINGS.START_OF_MONTH);
const EARNED = monthly(1500, ACCRUAL_TIMINGS.END_OF_MONTH);
const creditsFor = (policy, joiningDate, asOfDate) =>
  dueAccrualCredits({ policy, joiningDate, leaveYear: 2026, startMonth: APRIL, asOfDate }).map(
    ({ accrualPeriod, creditDate, amountCentidays }) => [accrualPeriod, creditDate, amountCentidays],
  );

describe('leave days', () => {
  it('converts to whole hundredths and rounds to a step, halves up', () => {
    assert.equal(isWholeCentidays(1.25), true);
    assert.equal(isWholeCentidays(1.255), false);
    assert.equal(isWholeCentidays('1'), false);
    assert.equal(daysToCentidays(0.1 + 0.2), 30);
    assert.equal(roundCentidaysToStep(74, 50), 50);
    assert.equal(roundCentidaysToStep(75, 50), 100);
  });
});

describe('leave years', () => {
  it('names a leave year by the calendar year it starts in', () => {
    assert.equal(leaveYearOfDate('2026-03-31', APRIL), 2025);
    assert.equal(leaveYearOfDate('2026-04-01', APRIL), 2026);
    assert.deepEqual(leaveYearRange(2026, APRIL), { firstDate: '2026-04-01', lastDate: '2027-03-31' });
    assert.deepEqual(leaveYearRange(2026, 1), { firstDate: '2026-01-01', lastDate: '2026-12-31' });
  });

  it('lists the months of a leave year across the calendar year end', () => {
    const months = monthsOfLeaveYear(2026, APRIL);
    assert.equal(months.length, 12);
    assert.deepEqual([months[0], months[8], months[11]], ['2026-04', '2026-12', '2027-03']);
    assert.deepEqual(monthRange('2028-02'), { firstDate: '2028-02-01', lastDate: '2028-02-29' });
  });
});

describe('monthly schedule', () => {
  it('spreads the quota so the twelve months add up exactly', () => {
    assert.deepEqual(
      [1, 6, 12].map((month) => scheduledMonthlyCentidays(1500, month)),
      [125, 125, 125],
    );
    const tenDays = Array.from({ length: 12 }, (_, index) => scheduledMonthlyCentidays(1000, index + 1));
    assert.deepEqual(tenDays.slice(0, 3), [83, 83, 84]);
    assert.equal(
      tenDays.reduce((total, amount) => total + amount, 0),
      1000,
    );
  });
});

describe('dueAccrualCredits', () => {
  it('credits start-of-month leave on the 1st and end-of-month leave on the last day', () => {
    // As of 27 October 2026: CL has April-October (1st of each), EL April-September (month ends).
    const casual = creditsFor(CASUAL, '2025-01-01', '2026-10-27');
    assert.equal(casual.length, 7);
    assert.deepEqual(casual.at(-1), ['2026-10', '2026-10-01', 100]);
    const earned = creditsFor(EARNED, '2025-01-01', '2026-10-27');
    assert.equal(earned.length, 6);
    assert.deepEqual(earned.at(-1), ['2026-09', '2026-09-30', 125]);
  });

  it('pro-rates the joining month, credited on the joining date for start-of-month leave', () => {
    // Joins 16 October: 16 of 31 days -> 1.00 x 16/31 = 0.52 -> 0.5 day.
    assert.deepEqual(creditsFor(CASUAL, '2026-10-16', '2026-10-15'), []);
    assert.deepEqual(creditsFor(CASUAL, '2026-10-16', '2026-10-16'), [['2026-10', '2026-10-16', 50]]);
    // Joining on the 1st is a full month.
    assert.deepEqual(creditsFor(CASUAL, '2026-10-01', '2026-10-01'), [['2026-10', '2026-10-01', 100]]);
  });

  it('pro-rates the joining month of end-of-month leave at the end of that month', () => {
    // 1.25 x 16/31 = 0.65 -> 0.5 day on 31 October, then the full November.
    assert.deepEqual(creditsFor(EARNED, '2026-10-16', '2026-10-30'), []);
    assert.deepEqual(creditsFor(EARNED, '2026-10-16', '2026-11-30'), [
      ['2026-10', '2026-10-31', 50],
      ['2026-11', '2026-11-30', 125],
    ]);
  });

  it('credits upfront leave once, pro-rated for a joiner', () => {
    const upfront = { ...CASUAL, accrualMethod: ACCRUAL_METHODS.UPFRONT_YEARLY };
    assert.deepEqual(creditsFor(upfront, '2025-06-01', '2026-04-01'), [['2026-04', '2026-04-01', 1200]]);
    // Joins 1 October: 182 of 365 days -> 12 x 182/365 = 5.98 -> 6 days.
    assert.deepEqual(creditsFor(upfront, '2026-10-01', '2026-10-01'), [['2026-10', '2026-10-01', 600]]);
  });

  it('credits nothing without accrual or before the employee joins the year', () => {
    assert.deepEqual(creditsFor({ ...CASUAL, accrualMethod: ACCRUAL_METHODS.NONE }, '2025-01-01', '2026-10-27'), []);
    assert.deepEqual(creditsFor(CASUAL, '2027-05-01', '2027-03-31'), []);
  });
});

describe('who accrues', () => {
  it('stops at termination and during notice when the type says so', () => {
    const freezesOnNotice = { accrueDuringNotice: false };
    assert.equal(isAccruingStatus(EMPLOYMENT_STATUSES.ACTIVE, freezesOnNotice), true);
    assert.equal(isAccruingStatus(EMPLOYMENT_STATUSES.PROBATION, freezesOnNotice), true);
    assert.equal(isAccruingStatus(EMPLOYMENT_STATUSES.NOTICE, freezesOnNotice), false);
    assert.equal(isAccruingStatus(EMPLOYMENT_STATUSES.NOTICE, { accrueDuringNotice: true }), true);
    assert.equal(isAccruingStatus(EMPLOYMENT_STATUSES.TERMINATED, { accrueDuringNotice: true }), false);
  });
});

describe('yearEndMovements', () => {
  it('carries forward up to the cap and lapses or encashes the rest', () => {
    assert.deepEqual(
      yearEndMovements({
        availableCentidays: 4000,
        carryForwardCapCentidays: 3000,
        excessAction: YEAR_END_EXCESS_ACTIONS.ENCASH,
      }),
      { carryForwardCentidays: 3000, lapseCentidays: 0, encashCentidays: 1000 },
    );
    assert.deepEqual(
      yearEndMovements({
        availableCentidays: 500,
        carryForwardCapCentidays: 0,
        excessAction: YEAR_END_EXCESS_ACTIONS.LAPSE,
      }),
      { carryForwardCentidays: 0, lapseCentidays: 500, encashCentidays: 0 },
    );
    assert.deepEqual(
      yearEndMovements({
        availableCentidays: 500,
        carryForwardCapCentidays: null,
        excessAction: YEAR_END_EXCESS_ACTIONS.LAPSE,
      }),
      { carryForwardCentidays: 500, lapseCentidays: 0, encashCentidays: 0 },
    );
  });

  it('carries a negative balance forward in full', () => {
    assert.deepEqual(
      yearEndMovements({
        availableCentidays: -150,
        carryForwardCapCentidays: 0,
        excessAction: YEAR_END_EXCESS_ACTIONS.LAPSE,
      }),
      { carryForwardCentidays: -150, lapseCentidays: 0, encashCentidays: 0 },
    );
  });
});
