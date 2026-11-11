/** The ideal line and the pace the team overview reads from a sprint's burndown (sprintProgress.js). */

import { describe, expect, it } from 'vitest';
import { PACE, idealRemaining, sprintDates, sprintPace } from './sprintProgress.js';

const SPRINT = { startDate: '2026-11-09', endDate: '2026-11-13' };
const withDays = (remaining, totalPoints = 10) => ({
  ...SPRINT,
  burndown: {
    totalPoints,
    days: remaining.map((remainingPoints, index) => ({
      date: sprintDates(SPRINT.startDate, SPRINT.endDate)[index],
      remainingPoints,
    })),
  },
});

describe('sprint progress', () => {
  it('lists the sprint days and draws the ideal from every point to none', () => {
    expect(sprintDates('2026-10-30', '2026-11-02')).toEqual(['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
    expect(idealRemaining(10, SPRINT.startDate, SPRINT.endDate, '2026-11-09')).toBe(10);
    expect(idealRemaining(10, SPRINT.startDate, SPRINT.endDate, '2026-11-11')).toBe(5);
    expect(idealRemaining(10, SPRINT.startDate, SPRINT.endDate, '2026-11-13')).toBe(0);
    expect(idealRemaining(10, SPRINT.startDate, SPRINT.endDate, '2026-12-01')).toBe(0);
  });

  it('is behind with more points open than the ideal, on track at or under it', () => {
    expect(sprintPace(withDays([10, 9, 8])).pace).toBe(PACE.BEHIND);
    expect(sprintPace(withDays([10, 7, 5])).pace).toBe(PACE.ON_TRACK);
    const progress = sprintPace(withDays([10, 7, 5]));
    expect(progress).toMatchObject({ daysGone: 3, sprintLength: 5, pointsDone: 5, pointsDoneShare: 0.5 });
  });

  it('is not started before the first day, and done when no point is open', () => {
    expect(sprintPace(withDays([])).pace).toBe(PACE.NOT_STARTED);
    expect(sprintPace(withDays([4, 0])).pace).toBe(PACE.DONE);
  });
});
