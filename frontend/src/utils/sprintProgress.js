/**
 * Reading a sprint's progress for the leads' team overview. The backend sends the burndown (the
 * points still open at the end of each sprint day so far, backend/services/tasks/teamWorkInsights.js);
 * these add the ideal line and the pace.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const dayNumber = (calendarDate) => Date.parse(`${calendarDate}T00:00:00Z`) / DAY_MS;

/** Every date from `startDate` to `endDate`, both included. */
export function sprintDates(startDate, endDate) {
  const first = dayNumber(startDate);
  return Array.from({ length: Math.max(dayNumber(endDate) - first + 1, 0) }, (_, offset) =>
    new Date((first + offset) * DAY_MS).toISOString().slice(0, 10),
  );
}

/** The ideal: every point open on the first day, none on the last, in a straight line between. */
export function idealRemaining(totalPoints, startDate, endDate, date) {
  const lastIndex = dayNumber(endDate) - dayNumber(startDate);
  if (lastIndex <= 0) return 0;
  const index = Math.min(Math.max(dayNumber(date) - dayNumber(startDate), 0), lastIndex);
  return totalPoints * (1 - index / lastIndex);
}

export const PACE = Object.freeze({ NOT_STARTED: 'NOT_STARTED', ON_TRACK: 'ON_TRACK', BEHIND: 'BEHIND', DONE: 'DONE' });

/**
 * How the sprint is going: the share of its days gone and of its points done, and whether the points
 * still open are at or under the ideal for today.
 * @param {{ startDate: string, endDate: string,
 *           burndown: { today: string, totalPoints: number, days: { date: string, remainingPoints: number }[] } }} sprint
 */
export function sprintPace({ startDate, endDate, burndown }) {
  const { totalPoints, days } = burndown;
  const length = sprintDates(startDate, endDate).length;
  const remaining = days.at(-1)?.remainingPoints ?? totalPoints;
  const daysGoneShare = length ? days.length / length : 0;
  const pointsDoneShare = totalPoints ? (totalPoints - remaining) / totalPoints : 0;
  let pace = PACE.ON_TRACK;
  if (days.length === 0) pace = PACE.NOT_STARTED;
  else if (totalPoints > 0 && remaining === 0) pace = PACE.DONE;
  else if (remaining > idealRemaining(totalPoints, startDate, endDate, days.at(-1).date)) pace = PACE.BEHIND;
  return {
    pace,
    daysGone: days.length,
    sprintLength: length,
    daysGoneShare,
    pointsDone: totalPoints - remaining,
    pointsDoneShare,
  };
}
