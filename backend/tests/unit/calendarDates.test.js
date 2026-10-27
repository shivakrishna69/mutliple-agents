import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  addDaysToCalendarDate,
  daysBetweenCalendarDates,
  isRealCalendarDate,
  listCalendarDates,
  weekdayOccurrenceInMonth,
  weekdayOfCalendarDate,
} from '../../utils/calendarDates.js';

describe('calendar date helpers', () => {
  it('accepts only real days written as YYYY-MM-DD', () => {
    assert.equal(isRealCalendarDate('2028-02-29'), true);
    for (const invalid of ['2027-02-29', '2026-02-30', '2026-13-01', '2026-4-01', '01-04-2026', '', null, 20260401]) {
      assert.equal(isRealCalendarDate(invalid), false, `${invalid} should be rejected`);
    }
  });

  it('adds and counts days across month and year ends and leap days', () => {
    assert.equal(addDaysToCalendarDate('2026-12-31', 1), '2027-01-01');
    assert.equal(addDaysToCalendarDate('2028-02-28', 1), '2028-02-29');
    assert.equal(addDaysToCalendarDate('2026-03-01', -1), '2026-02-28');
    assert.equal(daysBetweenCalendarDates('2026-04-01', '2027-03-31'), 364);
    assert.equal(daysBetweenCalendarDates('2026-10-10', '2026-10-01'), -9);
  });

  it('knows the weekday and its occurrence in the month', () => {
    // October 2026 starts on a Thursday, so its Saturdays are the 3rd, 10th, 17th, 24th and 31st.
    assert.equal(weekdayOfCalendarDate('2026-10-01'), 4);
    assert.equal(weekdayOfCalendarDate('2026-10-10'), 6);
    assert.deepEqual(
      ['2026-10-03', '2026-10-10', '2026-10-17', '2026-10-24', '2026-10-31'].map(weekdayOccurrenceInMonth),
      [1, 2, 3, 4, 5],
    );
  });

  it('lists every date in a range, both ends included', () => {
    assert.deepEqual(listCalendarDates('2026-12-30', '2027-01-02'), [
      '2026-12-30',
      '2026-12-31',
      '2027-01-01',
      '2027-01-02',
    ]);
    assert.deepEqual(listCalendarDates('2026-10-05', '2026-10-05'), ['2026-10-05']);
    assert.deepEqual(listCalendarDates('2026-10-05', '2026-10-04'), []);
  });
});
