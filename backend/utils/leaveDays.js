/**
 * Leave amounts are stored as whole hundredths of a day ("centidays": 1.25 days = 125), so adding
 * up a year of ledger entries never drifts the way binary fractions do. These helpers convert at the
 * API boundary and round.
 */

import { LEAVE_LIMITS } from '../constants/validation.js';

const { CENTIDAYS_PER_DAY } = LEAVE_LIMITS;

/** True when `days` is a finite number with at most two decimal places. */
export function isWholeCentidays(days) {
  return (
    typeof days === 'number' &&
    Number.isFinite(days) &&
    Math.abs(Math.round(days * CENTIDAYS_PER_DAY) - days * CENTIDAYS_PER_DAY) < 1e-6
  );
}

/** 1.25 -> 125. Callers validate with isWholeCentidays first. */
export function daysToCentidays(days) {
  return Math.round(days * CENTIDAYS_PER_DAY);
}

/** 125 -> 1.25 */
export function centidaysToDays(centidays) {
  return centidays / CENTIDAYS_PER_DAY;
}

/** Rounds to the nearest multiple of `stepCentidays`; exactly halfway rounds up. */
export function roundCentidaysToStep(centidays, stepCentidays) {
  return Math.floor(centidays / stepCentidays + 0.5) * stepCentidays;
}
