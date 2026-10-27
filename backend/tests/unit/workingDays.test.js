/**
 * The working-day calculator (services/workingDays.js). Every expectation is counted by hand on
 * October 2026: the 1st is a Thursday, the 2nd (Gandhi Jayanti) a Friday holiday, and the
 * Saturdays fall on the 3rd, 10th, 17th, 24th and 31st.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { WEEKDAYS, defaultWeeklyOffRules } from '../../models/OfficeLocation.js';
import {
  DAY_KINDS,
  DAY_PORTIONS,
  LeaveRangeError,
  calculateLeaveDays,
  classifyCalendarDay,
  isWeeklyOff,
} from '../../services/workingDays.js';

const SATURDAY_AND_SUNDAY_OFFICE = {
  weeklyOffRules: defaultWeeklyOffRules(),
  holidaysByDate: new Map([['2026-10-02', 'Gandhi Jayanti']]),
};
const SECOND_AND_FOURTH_SATURDAY_OFFICE = {
  weeklyOffRules: [
    { weekday: WEEKDAYS.SUNDAY, occurrencesInMonth: [] },
    { weekday: WEEKDAYS.SATURDAY, occurrencesInMonth: [2, 4] },
  ],
  holidaysByDate: new Map(),
};

const totalFor = (range, calendar = SATURDAY_AND_SUNDAY_OFFICE) => calculateLeaveDays(range, calendar).totalDays;

describe('weekly offs and holidays', () => {
  it('applies every-week and nth-week rules', () => {
    assert.equal(isWeeklyOff('2026-10-03', SATURDAY_AND_SUNDAY_OFFICE.weeklyOffRules), true);
    assert.equal(isWeeklyOff('2026-10-05', SATURDAY_AND_SUNDAY_OFFICE.weeklyOffRules), false);
    const rules = SECOND_AND_FOURTH_SATURDAY_OFFICE.weeklyOffRules;
    assert.deepEqual(
      ['2026-10-03', '2026-10-10', '2026-10-17', '2026-10-24', '2026-10-31'].map((date) => isWeeklyOff(date, rules)),
      [false, true, false, true, false],
    );
  });

  it('names a holiday even when it falls on a weekly off', () => {
    const calendar = { ...SATURDAY_AND_SUNDAY_OFFICE, holidaysByDate: new Map([['2026-10-03', 'Office Day']]) };
    assert.deepEqual(classifyCalendarDay('2026-10-03', calendar), {
      date: '2026-10-03',
      kind: DAY_KINDS.HOLIDAY,
      holidayName: 'Office Day',
    });
  });
});

describe('calculateLeaveDays', () => {
  it('counts only working days without the sandwich rule', () => {
    assert.equal(totalFor({ startDate: '2026-10-05', endDate: '2026-10-09' }), 5);
    // Friday to Monday: Friday and Monday only.
    assert.equal(totalFor({ startDate: '2026-10-09', endDate: '2026-10-12' }), 2);
    // Thursday to Monday around the Friday holiday and the weekend.
    assert.equal(totalFor({ startDate: '2026-10-01', endDate: '2026-10-05' }), 2);
  });

  it('charges weekends and holidays between leave days when the sandwich rule is on', () => {
    assert.equal(totalFor({ startDate: '2026-10-09', endDate: '2026-10-12', sandwich: true }), 4);
    assert.equal(totalFor({ startDate: '2026-10-01', endDate: '2026-10-05', sandwich: true }), 5);
  });

  it('never charges non-working days at the edges of the range', () => {
    // Friday only, and Friday to Sunday: the weekend after the last leave day is free.
    assert.equal(totalFor({ startDate: '2026-10-09', endDate: '2026-10-09', sandwich: true }), 1);
    assert.equal(totalFor({ startDate: '2026-10-09', endDate: '2026-10-11', sandwich: true }), 1);
    // Saturday to Monday: the weekend before the first leave day is free.
    assert.equal(totalFor({ startDate: '2026-10-10', endDate: '2026-10-12', sandwich: true }), 1);
    // A range with no working day costs nothing.
    assert.equal(totalFor({ startDate: '2026-10-10', endDate: '2026-10-11', sandwich: true }), 0);
  });

  it('prices half days at either end', () => {
    assert.equal(
      totalFor({ startDate: '2026-10-05', endDate: '2026-10-05', endDayPortion: DAY_PORTIONS.FIRST_HALF }),
      0.5,
    );
    assert.equal(
      totalFor({ startDate: '2026-10-05', endDate: '2026-10-05', startDayPortion: DAY_PORTIONS.SECOND_HALF }),
      0.5,
    );
    assert.equal(
      totalFor({
        startDate: '2026-10-05',
        endDate: '2026-10-06',
        startDayPortion: DAY_PORTIONS.SECOND_HALF,
        endDayPortion: DAY_PORTIONS.FIRST_HALF,
      }),
      1,
    );
  });

  it('does not sandwich a weekend next to a half day, which counts as half a day worked', () => {
    // Friday afternoon + Monday: 0.5 + 1, the weekend stays free.
    assert.equal(
      totalFor({
        startDate: '2026-10-09',
        endDate: '2026-10-12',
        startDayPortion: DAY_PORTIONS.SECOND_HALF,
        sandwich: true,
      }),
      1.5,
    );
    // Friday + Monday morning: 1 + 0.5.
    assert.equal(
      totalFor({
        startDate: '2026-10-09',
        endDate: '2026-10-12',
        endDayPortion: DAY_PORTIONS.FIRST_HALF,
        sandwich: true,
      }),
      1.5,
    );
  });

  it('still sandwiches a weekend between full days when the range starts or ends with a half day', () => {
    // Thursday afternoon, Friday, weekend, Monday: 0.5 + 1 + 2 + 1 (Friday and Monday are full days).
    assert.equal(
      totalFor({
        startDate: '2026-10-08',
        endDate: '2026-10-12',
        startDayPortion: DAY_PORTIONS.SECOND_HALF,
        sandwich: true,
      }),
      4.5,
    );
  });

  it('follows the office rules for alternate Saturdays', () => {
    // Monday 5th to Saturday 17th: ten weekdays plus the 3rd Saturday (17th); the 2nd Saturday
    // (10th) and Sunday (11th) are off.
    assert.equal(totalFor({ startDate: '2026-10-05', endDate: '2026-10-17' }, SECOND_AND_FOURTH_SATURDAY_OFFICE), 11);
  });

  it('reports each day with its kind and charge', () => {
    const { days } = calculateLeaveDays(
      { startDate: '2026-10-01', endDate: '2026-10-03', sandwich: true },
      SATURDAY_AND_SUNDAY_OFFICE,
    );
    assert.deepEqual(
      days.map(({ date, kind, holidayName, chargedDays }) => [date, kind, holidayName, chargedDays]),
      [
        ['2026-10-01', DAY_KINDS.WORKING, null, 1],
        ['2026-10-02', DAY_KINDS.HOLIDAY, 'Gandhi Jayanti', 0],
        ['2026-10-03', DAY_KINDS.WEEKLY_OFF, null, 0],
      ],
    );
  });

  it('rejects ranges it cannot price', () => {
    const codeOf = (range) => {
      try {
        calculateLeaveDays(range, SATURDAY_AND_SUNDAY_OFFICE);
      } catch (error) {
        assert.ok(error instanceof LeaveRangeError);
        return error.code;
      }
      return assert.fail('expected a LeaveRangeError');
    };
    assert.equal(codeOf({ startDate: '2026-10-09', endDate: '2026-10-05' }), 'END_BEFORE_START');
    assert.equal(codeOf({ startDate: '2026-02-30', endDate: '2026-03-02' }), 'INVALID_DATE');
    assert.equal(codeOf({ startDate: '2026-04-01', endDate: '2027-04-02' }), 'RANGE_TOO_LONG');
    assert.equal(
      codeOf({ startDate: '2026-10-05', endDate: '2026-10-05', startDayPortion: DAY_PORTIONS.FIRST_HALF }),
      'INVALID_PORTION',
    );
    assert.equal(
      codeOf({
        startDate: '2026-10-05',
        endDate: '2026-10-05',
        startDayPortion: DAY_PORTIONS.SECOND_HALF,
        endDayPortion: DAY_PORTIONS.FIRST_HALF,
      }),
      'INVALID_PORTION',
    );
  });
});
