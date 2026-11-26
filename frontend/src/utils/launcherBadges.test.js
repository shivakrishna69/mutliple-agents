/**
 * The launcher's counts and search (utils/launcherBadges.js): each count read from the daily briefing's
 * queues, a missing or empty one left out, "99+" above the maximum, and the search matching labels,
 * keywords and addresses in any case.
 */

import { describe, expect, it } from 'vitest';
import { badgeText, badgesFromQueues, filterTiles } from './launcherBadges.js';

describe('badgesFromQueues', () => {
  it('maps the briefing queues onto the Leave, Attendance, Support Console and CA Portal tiles', () => {
    expect(
      badgesFromQueues({
        LEAVE_DECISIONS: 3,
        ATTENDANCE_CORRECTIONS: 1,
        SUPPORT_WAITING: 2,
        FORM16_PENDING: 4,
        OFFERS_PENDING: 5,
      }),
    ).toEqual({ '/leave': 3, '/attendance': 1, '/console': 2, '/tax/ca-portal': 4 });
  });

  it('leaves out a queue that is 0 or missing (its area could not be read), and has nothing without a briefing', () => {
    expect(badgesFromQueues({ LEAVE_DECISIONS: 0, SUPPORT_WAITING: 1 })).toEqual({ '/console': 1 });
    expect(badgesFromQueues(null)).toEqual({});
    expect(badgesFromQueues(undefined)).toEqual({});
  });
});

describe('badgeText', () => {
  it('shows nothing at 0 or without a count, the number up to 99, then 99+', () => {
    expect(badgeText(0)).toBeNull();
    expect(badgeText(undefined)).toBeNull();
    expect(badgeText(null)).toBeNull();
    expect(badgeText(-2)).toBeNull();
    expect(badgeText(7)).toBe('7');
    expect(badgeText(99)).toBe('99');
    expect(badgeText(100)).toBe('99+');
  });
});

describe('filterTiles', () => {
  const TILES = [
    { label: 'Payroll & Form 16', path: '/payroll', keywords: ['payslip', 'salary', 'tax'] },
    { label: 'Offboarding', path: '/people/offboarding', keywords: ['exit', 'resignation'] },
    { label: 'Leave', path: '/leave', keywords: ['time off'] },
  ];
  const labels = (query) => filterTiles(TILES, query).map((tile) => tile.label);

  it('matches the label, keywords and address, in any case', () => {
    expect(labels('PAY')).toEqual(['Payroll & Form 16']);
    expect(labels('payslip')).toEqual(['Payroll & Form 16']);
    expect(labels('Exit')).toEqual(['Offboarding']);
    expect(labels('people')).toEqual(['Offboarding']);
    expect(labels('form 16')).toEqual(['Payroll & Form 16']);
  });

  it('shows every tile for an empty search, and none when nothing matches', () => {
    expect(labels('   ')).toHaveLength(3);
    expect(labels('zebra')).toEqual([]);
  });
});
