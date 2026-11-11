/**
 * The arithmetic of attendance analytics (services/attendanceAnalytics.js): how each day of a
 * person's month is judged and what counts toward completion, and how arrival times are bucketed.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DAY_KINDS } from '../../constants/calendarDays.js';
import { bucketArrivals, judgeMonth } from '../../services/attendanceAnalytics.js';

const DATES = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07'];
const KINDS = { '2026-10-04': DAY_KINDS.WEEKLY_OFF, '2026-10-02': DAY_KINDS.HOLIDAY };

describe('attendance analytics', () => {
  it('judges each day and counts completion over the days expected', () => {
    const month = judgeMonth({
      dates: DATES,
      today: '2026-10-06',
      joinedOn: null,
      hasOffice: true,
      dayKindOf: (date) => KINDS[date] ?? DAY_KINDS.WORKING,
      leaveOf: (date) => ({ '2026-10-03': 'FULL', '2026-10-05': 'FIRST' })[date] ?? null,
      punchOf: (date) => ({ '2026-10-01': { calculationStatus: 'Late' } })[date] ?? null,
    });
    assert.deepEqual(
      month.days.map((day) => day.status),
      ['late', 'holiday', 'leave', 'weekly_off', 'absent', 'upcoming', 'upcoming'],
    );
    // Expected: 1 Oct (1) + 5 Oct (half, the other half on leave); today without a punch is not yet.
    assert.equal(month.expectedDays, 1.5);
    assert.equal(month.presentDays, 1);
    assert.equal(month.lateDays, 1);
    assert.equal(month.completion, 0.667);
  });

  it('counts today once punched, leaves out days before joining, and has no completion without an office', () => {
    const punched = judgeMonth({
      dates: DATES,
      today: '2026-10-06',
      joinedOn: '2026-10-06',
      hasOffice: true,
      dayKindOf: () => DAY_KINDS.WORKING,
      leaveOf: () => null,
      punchOf: (date) => (date === '2026-10-06' ? { calculationStatus: 'Normal' } : null),
    });
    assert.deepEqual(
      punched.days.slice(4, 7).map((day) => day.status),
      ['not_joined', 'on_time', 'upcoming'],
    );
    assert.equal(punched.completion, 1);
    const halfDay = judgeMonth({
      dates: ['2026-10-01'],
      today: '2026-10-06',
      joinedOn: null,
      hasOffice: true,
      dayKindOf: () => DAY_KINDS.WORKING,
      leaveOf: () => null,
      punchOf: () => ({ calculationStatus: 'Half_Day' }),
    });
    assert.equal(halfDay.days[0].status, 'late', 'a half day also came after the grace period');

    const noOffice = judgeMonth({
      dates: DATES,
      today: '2026-10-06',
      joinedOn: null,
      hasOffice: false,
      dayKindOf: () => {
        throw new Error('no calendar without an office');
      },
      leaveOf: () => null,
      punchOf: () => null,
    });
    assert.equal(noOffice.completion, null);
    assert.ok(noOffice.days.every((day) => day.status === 'upcoming'));
  });

  it('buckets arrivals per slot and day, from the first busy slot to the last, with medians', () => {
    const arrivals = bucketArrivals({
      dates: ['2026-10-05', '2026-10-06'],
      slotMinutes: 30,
      arrivals: [
        { date: '2026-10-05', minutes: 9 * 60 + 5 },
        { date: '2026-10-05', minutes: 9 * 60 + 25 },
        { date: '2026-10-05', minutes: 10 * 60 + 40 },
        { date: '2026-10-06', minutes: 9 * 60 + 50 },
        { date: '2026-10-06', minutes: 9 * 60 + 55 },
        { date: '2026-09-30', minutes: 6 * 60 },
      ],
    });
    assert.deepEqual(
      arrivals.slots.map((slot) => [slot.start, slot.counts]),
      [
        ['09:00', [2, 0]],
        ['09:30', [0, 2]],
        ['10:00', [0, 0]],
        ['10:30', [1, 0]],
      ],
    );
    assert.deepEqual(arrivals.medians, [
      { date: '2026-10-05', count: 3, median: '09:25' },
      { date: '2026-10-06', count: 2, median: '09:53' },
    ]);
    assert.deepEqual(bucketArrivals({ dates: ['2026-10-05'], slotMinutes: 30, arrivals: [] }).slots, []);
  });
});
