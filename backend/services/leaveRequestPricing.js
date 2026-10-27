/**
 * What a leave request costs, in centidays: its own days under the office calendar
 * (services/workingDays.js), plus "border" charges when the type applies the sandwich rule and
 * approved leave sits on the other side of a run of non-working days.
 *
 * Border charges
 * --------------
 *   Leave on Friday and leave on Monday, as two requests, still sandwich the weekend. When a
 *   request's first (or last) working day is a FULL leave day, the non-working days before (or
 *   after) it are charged, one day each, if the nearest working day beyond them is a FULL day of
 *   another APPROVED request whose type also applies the sandwich rule. The charge belongs to the
 *   request approved second: an approved request that already charges this gap is not charged
 *   again. A gap longer than LEAVE_LIMITS.MAX_SANDWICH_GAP_DAYS is not a sandwich.
 *
 *   The neighbour is found through the day claims (models/LeaveDayClaim.js): a full day is
 *   claimed in both halves by the same request; a half day counts as worked and never triggers
 *   the rule.
 *
 * Prices are recomputed at approval (a holiday may have been added since submission), and a
 * shortened request is repriced from the days it was approved with.
 */

import { HTTP_STATUS } from '../constants/httpStatus.js';
import { DAY_KINDS, DAY_PORTIONS } from '../constants/calendarDays.js';
import { LEAVE_LIMITS } from '../constants/validation.js';
import LeaveDayClaim, { DAY_HALVES } from '../models/LeaveDayClaim.js';
import LeaveRequest, { LEAVE_REQUEST_STATUSES } from '../models/LeaveRequest.js';
import LeaveType from '../models/LeaveType.js';
import { addDaysToCalendarDate, listCalendarDates } from '../utils/calendarDates.js';
import { daysToCentidays } from '../utils/leaveDays.js';
import { ServiceError } from './serviceError.js';
import { loadOfficeCalendar } from './workCalendar.js';
import {
  assertPricableRange,
  calculateLeaveDays,
  classifyCalendarDay,
  LeaveRangeError,
  priceClassifiedDays,
} from './workingDays.js';

const FULL_DAY_CENTIDAYS = LEAVE_LIMITS.CENTIDAYS_PER_DAY;
const GAP_LIMIT = LEAVE_LIMITS.MAX_SANDWICH_GAP_DAYS;

/** A range the calculator refuses, as a 422 with the calculator's code. */
function rangeErrorToServiceError(rangeError) {
  return new ServiceError(HTTP_STATUS.UNPROCESSABLE_CONTENT, rangeError.code, rangeError.message);
}

/** Runs `price`, turning a LeaveRangeError into a ServiceError. */
function withRangeErrors(price) {
  try {
    return price();
  } catch (priceError) {
    if (priceError instanceof LeaveRangeError) throw rangeErrorToServiceError(priceError);
    throw priceError;
  }
}

/** The half days a range occupies, for models/LeaveDayClaim.js. */
export function claimedHalvesOf({ startDate, startDayPortion, endDate, endDayPortion }) {
  return listCalendarDates(startDate, endDate).flatMap((date) => {
    const halves = [];
    if (!(date === startDate && startDayPortion === DAY_PORTIONS.SECOND_HALF)) halves.push(DAY_HALVES.FIRST);
    if (!(date === endDate && endDayPortion === DAY_PORTIONS.FIRST_HALF)) halves.push(DAY_HALVES.SECOND);
    return halves.map((half) => ({ date, half }));
  });
}

/** The office calendar around a range, wide enough to look across a gap on either side. */
function loadPricingCalendar(officeLocationId, startDate, endDate) {
  return loadOfficeCalendar(
    officeLocationId,
    addDaysToCalendarDate(startDate, -(GAP_LIMIT + 1)),
    addDaysToCalendarDate(endDate, GAP_LIMIT + 1),
  );
}

const toPricedDays = (days) =>
  days.map(({ date, kind, holidayName, chargedDays }) => ({
    date,
    kind,
    holidayName,
    chargedCentidays: daysToCentidays(chargedDays),
  }));

/**
 * The APPROVED request that takes `date` as a full day, if it applies the sandwich rule and does
 * not already charge the gap towards `requestId`.
 */
async function sandwichingNeighbourOn({ employeeId, requestId, date }) {
  const claims = await LeaveDayClaim.find({ employeeId, date }).select('leaveRequestId').lean();
  if (claims.length !== Object.keys(DAY_HALVES).length) return null;
  const neighbourId = claims[0].leaveRequestId;
  if (!claims.every((claim) => claim.leaveRequestId.equals(neighbourId)) || neighbourId.equals(requestId)) return null;
  const neighbour = await LeaveRequest.findOne({ _id: neighbourId, status: LEAVE_REQUEST_STATUSES.APPROVED })
    .select('leaveTypeId borderCharges')
    .lean();
  if (!neighbour) return null;
  if (neighbour.borderCharges.some((charge) => charge.neighbourRequestId.equals(requestId))) return null;
  const neighbourType = await LeaveType.findById(neighbour.leaveTypeId).select('usage.sandwichRule').lean();
  return neighbourType?.usage.sandwichRule ? neighbour : null;
}

/**
 * Border charges on one side of a priced range (`step` -1 before it, +1 after it).
 * @returns {Promise<{ date: string, chargedCentidays: number, neighbourRequestId: object }[]>}
 */
async function borderChargesOnSide({ employeeId, requestId, days, calendar, step }) {
  const workingIndexes = days.flatMap((day, dayIndex) => (day.kind === DAY_KINDS.WORKING ? [dayIndex] : []));
  const edgeIndex = step < 0 ? workingIndexes[0] : workingIndexes.at(-1);
  if (edgeIndex === undefined || days[edgeIndex].chargedCentidays !== FULL_DAY_CENTIDAYS) return [];

  // Non-working days of the range itself beyond its edge working day, then outside the range.
  const gapDates = (step < 0 ? days.slice(0, edgeIndex) : days.slice(edgeIndex + 1)).map((day) => day.date);
  let date = addDaysToCalendarDate(step < 0 ? days[0].date : days.at(-1).date, step);
  while (classifyCalendarDay(date, calendar).kind !== DAY_KINDS.WORKING) {
    gapDates.push(date);
    if (gapDates.length > GAP_LIMIT) return [];
    date = addDaysToCalendarDate(date, step);
  }
  if (gapDates.length === 0) return [];
  const neighbour = await sandwichingNeighbourOn({ employeeId, requestId, date });
  if (!neighbour) return [];
  return gapDates
    .sort()
    .map((gapDate) => ({ date: gapDate, chargedCentidays: FULL_DAY_CENTIDAYS, neighbourRequestId: neighbour._id }));
}

async function borderChargesOf({ employeeId, requestId, days, calendar }) {
  const before = await borderChargesOnSide({ employeeId, requestId, days, calendar, step: -1 });
  const after = await borderChargesOnSide({ employeeId, requestId, days, calendar, step: 1 });
  return [...before, ...after];
}

function pricingOf(days, borderCharges) {
  const daysCentidays = days.reduce((total, day) => total + day.chargedCentidays, 0);
  const borderCentidays = borderCharges.reduce((total, charge) => total + charge.chargedCentidays, 0);
  return { days, borderCharges, daysCentidays, chargedCentidays: daysCentidays + borderCentidays };
}

/**
 * Prices a range for an employee under their office calendar and the type's sandwich rule.
 * @param {{ employeeId: object|string, requestId: object, leaveType: object, officeLocationId: object|string,
 *   startDate: string, startDayPortion: string, endDate: string, endDayPortion: string }} range
 * @returns {Promise<{ days: object[], borderCharges: object[], daysCentidays: number, chargedCentidays: number }>}
 * @throws {ServiceError} 422 with the calculator's code for a range it cannot price
 */
export async function priceLeaveRange({ employeeId, requestId, leaveType, officeLocationId, ...range }) {
  const calendar = await loadPricingCalendar(officeLocationId, range.startDate, range.endDate);
  const sandwich = leaveType.usage.sandwichRule;
  const days = toPricedDays(withRangeErrors(() => calculateLeaveDays({ ...range, sandwich }, calendar).days));
  const borderCharges = sandwich ? await borderChargesOf({ employeeId, requestId, days, calendar }) : [];
  return pricingOf(days, borderCharges);
}

/**
 * The price of an approved request cut short at `newEndDate`, from the days it was approved with.
 * Border charges that still apply are kept; none are added.
 * @throws {ServiceError} 422 for an end the calculator cannot price
 */
export async function priceShortenedRequest(request, { newEndDate, newEndDayPortion, sandwich }) {
  const range = {
    startDate: request.startDate,
    startDayPortion: request.startDayPortion,
    endDate: newEndDate,
    endDayPortion: newEndDayPortion,
  };
  withRangeErrors(() => assertPricableRange(range));
  const keptDays = request.days.filter((day) => day.date <= newEndDate);
  const days = toPricedDays(priceClassifiedDays(keptDays, { ...range, sandwich }).days);
  const stillBordering = sandwich ? await borderingNeighbourIds({ ...request, days, endDate: newEndDate }) : new Set();
  const borderCharges = request.borderCharges.filter((charge) =>
    stillBordering.has(charge.neighbourRequestId.toString()),
  );
  return pricingOf(days, borderCharges);
}

/**
 * Ids (strings) of the approved requests that border this one under the sandwich rule today,
 * ignoring whether this one already charges them.
 */
export async function borderingNeighbourIds(request) {
  const calendar = await loadPricingCalendar(request.officeLocationId, request.startDate, request.endDate);
  const charges = await borderChargesOf({
    employeeId: request.employeeId,
    requestId: request._id,
    days: request.days,
    calendar,
  });
  return new Set(charges.map((charge) => charge.neighbourRequestId.toString()));
}
