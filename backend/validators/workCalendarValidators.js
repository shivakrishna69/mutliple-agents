/**
 * Request validation for the work calendar endpoints. Pure functions returning
 * { isValid: true, sanitizedInput } or { isValid: false, validationErrors: [{ field, message }] }.
 * Existence checks (offices, holidays) and clashes are in services/workCalendar.js.
 */

import { WORK_CALENDAR_LIMITS } from '../constants/validation.js';
import { WEEKDAYS } from '../models/OfficeLocation.js';
import { daysBetweenCalendarDates, isRealCalendarDate } from '../utils/calendarDates.js';
import { isValidObjectIdString } from './conversationValidators.js';

const LIMITS = WORK_CALENDAR_LIMITS;
const EARLIEST_YEAR = 2000;
const LATEST_YEAR = 2100;

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isWholeNumberBetween = (value, minimum, maximum) =>
  Number.isInteger(value) && value >= minimum && value <= maximum;

function result(validationErrors, sanitizedInput) {
  return validationErrors.length > 0 ? { isValid: false, validationErrors } : { isValid: true, sanitizedInput };
}

function bodyError() {
  return { isValid: false, validationErrors: [{ field: 'body', message: 'must be a JSON object' }] };
}

function checkVersion(rawVersion, validationErrors) {
  if (!Number.isInteger(rawVersion) || rawVersion < 0) {
    validationErrors.push({ field: 'version', message: 'must be the version you loaded' });
  }
  return rawVersion;
}

function checkHolidayName(rawName, validationErrors) {
  const name = typeof rawName === 'string' ? rawName.trim() : '';
  if (name.length < LIMITS.HOLIDAY_NAME_MIN_LENGTH || name.length > LIMITS.HOLIDAY_NAME_MAX_LENGTH) {
    validationErrors.push({
      field: 'name',
      message: `must be ${LIMITS.HOLIDAY_NAME_MIN_LENGTH}-${LIMITS.HOLIDAY_NAME_MAX_LENGTH} characters`,
    });
  }
  return name;
}

function checkDate(rawDate, fieldName, validationErrors) {
  if (!isRealCalendarDate(rawDate))
    validationErrors.push({ field: fieldName, message: 'must be a date as YYYY-MM-DD' });
  return rawDate;
}

/** Office ids for a holiday: an empty list (or none) means every office. */
function checkOfficeIds(rawOfficeIds, validationErrors) {
  if (rawOfficeIds === undefined || rawOfficeIds === null) return [];
  const isValidList =
    Array.isArray(rawOfficeIds) &&
    rawOfficeIds.length <= LIMITS.MAX_OFFICES_PER_HOLIDAY &&
    rawOfficeIds.every(isValidObjectIdString);
  if (!isValidList) {
    validationErrors.push({
      field: 'officeLocationIds',
      message: `must be a list of up to ${LIMITS.MAX_OFFICES_PER_HOLIDAY} office ids (empty for every office)`,
    });
    return [];
  }
  return [...new Set(rawOfficeIds.map((officeId) => officeId.toLowerCase()))];
}

/** PATCH /api/work-calendar/offices/:officeLocationId/weekly-offs */
export function validateWeeklyOffRulesInput(requestBody) {
  if (!isPlainObject(requestBody)) return bodyError();
  const validationErrors = [];
  const rawRules = requestBody.weeklyOffRules;
  const weeklyOffRules = [];
  if (!Array.isArray(rawRules) || rawRules.length > Object.keys(WEEKDAYS).length) {
    validationErrors.push({ field: 'weeklyOffRules', message: 'must be a list of at most one rule per weekday' });
  } else {
    rawRules.forEach((rawRule, ruleIndex) => {
      const fieldPrefix = `weeklyOffRules[${ruleIndex}]`;
      if (!isPlainObject(rawRule) || !isWholeNumberBetween(rawRule.weekday, WEEKDAYS.SUNDAY, WEEKDAYS.SATURDAY)) {
        validationErrors.push({ field: `${fieldPrefix}.weekday`, message: 'must be 0 (Sunday) to 6 (Saturday)' });
        return;
      }
      const rawOccurrences = rawRule.occurrencesInMonth ?? [];
      const isValidOccurrences =
        Array.isArray(rawOccurrences) &&
        rawOccurrences.every((occurrence) => isWholeNumberBetween(occurrence, 1, LIMITS.MAX_WEEKDAY_OCCURRENCE)) &&
        new Set(rawOccurrences).size === rawOccurrences.length;
      if (!isValidOccurrences) {
        validationErrors.push({
          field: `${fieldPrefix}.occurrencesInMonth`,
          message: `must be distinct numbers from 1 to ${LIMITS.MAX_WEEKDAY_OCCURRENCE} (empty for every week)`,
        });
        return;
      }
      weeklyOffRules.push({
        weekday: rawRule.weekday,
        occurrencesInMonth: [...rawOccurrences].sort((first, second) => first - second),
      });
    });
    if (new Set(weeklyOffRules.map((rule) => rule.weekday)).size !== weeklyOffRules.length) {
      validationErrors.push({ field: 'weeklyOffRules', message: 'each weekday may appear in only one rule' });
    }
  }
  const version = checkVersion(requestBody.version, validationErrors);
  return result(validationErrors, { weeklyOffRules, version });
}

/** POST /api/work-calendar/holidays */
export function validateHolidayCreation(requestBody) {
  if (!isPlainObject(requestBody)) return bodyError();
  const validationErrors = [];
  const sanitizedInput = {
    name: checkHolidayName(requestBody.name, validationErrors),
    date: checkDate(requestBody.date, 'date', validationErrors),
    officeLocationIds: checkOfficeIds(requestBody.officeLocationIds, validationErrors),
  };
  return result(validationErrors, sanitizedInput);
}

/** PATCH /api/work-calendar/holidays/:holidayId */
export function validateHolidayChanges(requestBody) {
  if (!isPlainObject(requestBody)) return bodyError();
  const validationErrors = [];
  const changes = {};
  if (requestBody.name !== undefined) changes.name = checkHolidayName(requestBody.name, validationErrors);
  if (requestBody.date !== undefined) changes.date = checkDate(requestBody.date, 'date', validationErrors);
  if (requestBody.officeLocationIds !== undefined) {
    changes.officeLocationIds = checkOfficeIds(requestBody.officeLocationIds, validationErrors);
  }
  if (Object.keys(changes).length === 0) validationErrors.push({ field: 'body', message: 'nothing to change' });
  const version = checkVersion(requestBody.version, validationErrors);
  return result(validationErrors, { changes, version });
}

/** GET /api/work-calendar/holidays?year=YYYY[&officeLocationId=] */
export function validateHolidayListQuery(query) {
  const validationErrors = [];
  const year = Number(query.year);
  if (!isWholeNumberBetween(year, EARLIEST_YEAR, LATEST_YEAR)) {
    validationErrors.push({ field: 'year', message: `must be a year from ${EARLIEST_YEAR} to ${LATEST_YEAR}` });
  }
  const officeLocationId = query.officeLocationId ?? null;
  if (officeLocationId !== null && !isValidObjectIdString(officeLocationId)) {
    validationErrors.push({ field: 'officeLocationId', message: 'must be an office id' });
  }
  return result(validationErrors, {
    firstDate: `${year}-01-01`,
    lastDate: `${year}-12-31`,
    officeLocationId: officeLocationId?.toLowerCase() ?? null,
  });
}

/** GET /api/work-calendar/days?from=YYYY-MM-DD&to=YYYY-MM-DD[&officeLocationId=] */
export function validateCalendarRangeQuery(query) {
  const validationErrors = [];
  const firstDate = checkDate(query.from, 'from', validationErrors);
  const lastDate = checkDate(query.to, 'to', validationErrors);
  if (validationErrors.length === 0) {
    const rangeLengthDays = daysBetweenCalendarDates(firstDate, lastDate) + 1;
    if (rangeLengthDays < 1) validationErrors.push({ field: 'to', message: 'must not be before from' });
    else if (rangeLengthDays > LIMITS.MAX_RANGE_DAYS) {
      validationErrors.push({ field: 'to', message: `the range may cover at most ${LIMITS.MAX_RANGE_DAYS} days` });
    }
  }
  const officeLocationId = query.officeLocationId ?? null;
  if (officeLocationId !== null && !isValidObjectIdString(officeLocationId)) {
    validationErrors.push({ field: 'officeLocationId', message: 'must be an office id' });
  }
  return result(validationErrors, { firstDate, lastDate, officeLocationId: officeLocationId?.toLowerCase() ?? null });
}
