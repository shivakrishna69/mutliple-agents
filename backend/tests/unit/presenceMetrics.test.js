/**
 * A day of presence as numbers (services/presenceMetrics.js).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { summarizePresenceDay } from '../../services/presenceMetrics.js';

// A day in Bengaluru: 2026-01-05 00:00 IST is 2026-01-04 18:30 UTC. Shift 09:30-18:30 IST.
const DAY = Object.freeze({
  dayStart: new Date('2026-01-04T18:30:00Z'),
  dayEnd: new Date('2026-01-05T18:30:00Z'),
  shift: { start: new Date('2026-01-05T04:00:00Z'), end: new Date('2026-01-05T13:00:00Z') },
});
const AFTER_THE_DAY = new Date('2026-01-06T00:00:00Z');
const at = (time) => new Date(`2026-01-05T${time}:00Z`);
const interval = (state, from, to) => ({ state, startedAt: at(from), endedAt: to ? at(to) : null });

describe('summarizePresenceDay', () => {
  it('adds up available and away time, and the shift time spent offline', () => {
    const summary = summarizePresenceDay({
      ...DAY,
      now: AFTER_THE_DAY,
      intervals: [
        interval('available', '04:00', '06:00'),
        interval('away', '06:00', '06:30'),
        interval('available', '07:30', '13:00'),
      ],
    });
    assert.deepEqual(summary, {
      availableMinutes: 450,
      awayMinutes: 30,
      onlineMinutes: 480,
      offlineDuringShiftMinutes: 60,
      firstSeenAt: at('04:00'),
      lastSeenAt: at('13:00'),
    });
  });

  it('counts only the part of an interval inside the day, and outside the shift towards online only', () => {
    const summary = summarizePresenceDay({
      ...DAY,
      now: AFTER_THE_DAY,
      intervals: [
        // 23:00 the evening before to 01:00 IST: only the hour after midnight is in this day.
        { state: 'available', startedAt: new Date('2026-01-04T17:30:00Z'), endedAt: new Date('2026-01-04T19:30:00Z') },
        interval('available', '14:00', '15:00'),
      ],
    });
    assert.equal(summary.availableMinutes, 120);
    assert.equal(summary.firstSeenAt.toISOString(), '2026-01-04T18:30:00.000Z');
    assert.equal(summary.offlineDuringShiftMinutes, 540, 'online only outside the shift');
  });

  it('counts an open interval up to now, and only the shift so far', () => {
    const summary = summarizePresenceDay({
      ...DAY,
      now: at('06:00'),
      intervals: [interval('available', '05:00', null)],
    });
    assert.equal(summary.availableMinutes, 60);
    assert.equal(summary.lastSeenAt.toISOString(), at('06:00').toISOString());
    assert.equal(summary.offlineDuringShiftMinutes, 60, '04:00 to 05:00 of the shift so far');
  });

  it('has no shift time to miss on a day off, and nothing at all for a day without presence', () => {
    const dayOff = summarizePresenceDay({ ...DAY, shift: null, now: AFTER_THE_DAY, intervals: [] });
    assert.deepEqual(dayOff, {
      availableMinutes: 0,
      awayMinutes: 0,
      onlineMinutes: 0,
      offlineDuringShiftMinutes: null,
      firstSeenAt: null,
      lastSeenAt: null,
    });
    const absent = summarizePresenceDay({ ...DAY, now: AFTER_THE_DAY, intervals: [] });
    assert.equal(absent.offlineDuringShiftMinutes, 540);
  });
});
