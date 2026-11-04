/**
 * A person's day of presence as numbers. Pure functions, no I/O (services/presenceActivity.js
 * loads the data).
 *
 *   availableMinutes / awayMinutes   time in each state within the day (an open interval counts
 *                                    up to now, so today's numbers are "so far")
 *   onlineMinutes                    the two together: the app open on any device
 *   offlineDuringShiftMinutes        the part of the shift (up to now) when the app was not open;
 *                                    null on a day with no shift to be missing from (holiday, weekly
 *                                    off, full-day leave, no office)
 *   firstSeenAt / lastSeenAt         the first and last moment online within the day
 *
 * These describe activity in the app, not work done: someone working away from the app shows offline.
 */

const MINUTE_MS = 60_000;

const toMinutes = (milliseconds) => Math.round(milliseconds / MINUTE_MS);

/** The part of [startMs, endMs) inside [windowStartMs, windowEndMs), or null. */
function overlap(startMs, endMs, windowStartMs, windowEndMs) {
  const clippedStart = Math.max(startMs, windowStartMs);
  const clippedEnd = Math.min(endMs, windowEndMs);
  return clippedEnd > clippedStart ? [clippedStart, clippedEnd] : null;
}

/**
 * @param {{ intervals: { state: string, startedAt: Date, endedAt: Date|null }[], dayStart: Date, dayEnd: Date,
 *   shift: { start: Date, end: Date } | null, now: Date }} day
 *   One person's intervals (they never overlap), the day's bounds in their time zone, and their shift.
 * @returns {{ availableMinutes: number, awayMinutes: number, onlineMinutes: number,
 *   offlineDuringShiftMinutes: number|null, firstSeenAt: Date|null, lastSeenAt: Date|null }}
 */
export function summarizePresenceDay({ intervals, dayStart, dayEnd, shift, now }) {
  const windowEndMs = Math.min(dayEnd.getTime(), now.getTime());
  const millisecondsByState = { available: 0, away: 0 };
  let onlineInShiftMs = 0;
  let firstSeenMs = null;
  let lastSeenMs = null;

  for (const interval of intervals) {
    const endMs = (interval.endedAt ?? now).getTime();
    const inDay = overlap(interval.startedAt.getTime(), endMs, dayStart.getTime(), windowEndMs);
    if (!inDay) continue;
    millisecondsByState[interval.state] += inDay[1] - inDay[0];
    firstSeenMs = firstSeenMs === null ? inDay[0] : Math.min(firstSeenMs, inDay[0]);
    lastSeenMs = lastSeenMs === null ? inDay[1] : Math.max(lastSeenMs, inDay[1]);
    if (shift) {
      const inShift = overlap(inDay[0], inDay[1], shift.start.getTime(), shift.end.getTime());
      if (inShift) onlineInShiftMs += inShift[1] - inShift[0];
    }
  }

  let offlineDuringShiftMinutes = null;
  if (shift) {
    const elapsedShift = overlap(shift.start.getTime(), shift.end.getTime(), dayStart.getTime(), windowEndMs);
    const elapsedShiftMs = elapsedShift ? elapsedShift[1] - elapsedShift[0] : 0;
    offlineDuringShiftMinutes = toMinutes(Math.max(0, elapsedShiftMs - onlineInShiftMs));
  }

  const availableMinutes = toMinutes(millisecondsByState.available);
  const awayMinutes = toMinutes(millisecondsByState.away);
  return {
    availableMinutes,
    awayMinutes,
    onlineMinutes: toMinutes(millisecondsByState.available + millisecondsByState.away),
    offlineDuringShiftMinutes,
    firstSeenAt: firstSeenMs === null ? null : new Date(firstSeenMs),
    lastSeenAt: lastSeenMs === null ? null : new Date(lastSeenMs),
  };
}
