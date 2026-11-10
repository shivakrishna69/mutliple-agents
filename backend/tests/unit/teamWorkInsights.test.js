/**
 * The sprint burndown the leads' team overview draws (services/tasks/teamWorkInsights.js): points
 * still open at the end of each sprint day so far.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { burndownSeries } from '../../services/tasks/teamWorkInsights.js';

const SPRINT = { startDate: '2026-11-09', endDate: '2026-11-13' };

describe('sprint burndown', () => {
  it('subtracts points on the day their task is done, and counts early work on the first day', () => {
    const series = burndownSeries({
      ...SPRINT,
      today: '2026-11-11',
      tasks: [
        { storyPoints: 5, doneDate: '2026-11-10' },
        { storyPoints: 3, doneDate: '2026-11-01' },
        { storyPoints: 2, doneDate: null },
        { storyPoints: null, doneDate: '2026-11-09' },
      ],
    });
    assert.equal(series.totalPoints, 10);
    assert.deepEqual(series.days, [
      { date: '2026-11-09', remainingPoints: 7 },
      { date: '2026-11-10', remainingPoints: 2 },
      { date: '2026-11-11', remainingPoints: 2 },
    ]);
  });

  it('stops at the sprint end, and has no days before the sprint starts', () => {
    const tasks = [{ storyPoints: 4, doneDate: null }];
    assert.equal(burndownSeries({ ...SPRINT, today: '2026-12-01', tasks }).days.at(-1).date, '2026-11-13');
    assert.equal(burndownSeries({ ...SPRINT, today: '2026-12-01', tasks }).days.length, 5);
    assert.deepEqual(burndownSeries({ ...SPRINT, today: '2026-11-08', tasks }).days, []);
  });
});
