/**
 * Request validation for the office endpoints. These check the shape of a request only: a JSON
 * object, known fields (anything else is dropped), and the version on edits. Field values (time
 * zone, coordinates, shift times, weekly-off rules...) are validated by models/OfficeLocation.js,
 * the single authority for them; its errors are returned as 400 with field details.
 */

import { isValidObjectIdString } from './conversationValidators.js';

const OFFICE_FIELDS = Object.freeze(['name', 'code', 'coordinates', 'timeZone', 'workday']);
const COORDINATE_FIELDS = Object.freeze(['lat', 'lng']);
const WORKDAY_FIELDS = Object.freeze([
  'shiftStartLocalTime',
  'shiftEndLocalTime',
  'lateGraceMinutes',
  'halfDayAfterMinutes',
  'weeklyOffRules',
]);

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

function pickFields(source, fieldNames) {
  return Object.fromEntries(
    fieldNames
      .filter((fieldName) => source[fieldName] !== undefined)
      .map((fieldName) => [fieldName, source[fieldName]]),
  );
}

function result(validationErrors, sanitizedInput) {
  return validationErrors.length > 0 ? { isValid: false, validationErrors } : { isValid: true, sanitizedInput };
}

/** The known office fields of a body; nested groups must be objects. */
function pickOfficeFields(requestBody, validationErrors) {
  const fields = pickFields(requestBody, OFFICE_FIELDS);
  for (const [groupName, groupFields] of [
    ['coordinates', COORDINATE_FIELDS],
    ['workday', WORKDAY_FIELDS],
  ]) {
    if (fields[groupName] === undefined) continue;
    if (!isPlainObject(fields[groupName])) {
      validationErrors.push({ field: groupName, message: 'must be an object' });
      delete fields[groupName];
    } else {
      fields[groupName] = pickFields(fields[groupName], groupFields);
    }
  }
  return fields;
}

/** POST /api/offices */
export function validateOfficeCreation(requestBody) {
  if (!isPlainObject(requestBody)) return result([{ field: 'body', message: 'must be a JSON object' }]);
  const validationErrors = [];
  return result(validationErrors, pickOfficeFields(requestBody, validationErrors));
}

/** PATCH /api/offices/:officeLocationId */
export function validateOfficeChanges(requestBody) {
  if (!isPlainObject(requestBody)) return result([{ field: 'body', message: 'must be a JSON object' }]);
  const validationErrors = [];
  const changes = pickOfficeFields(requestBody, validationErrors);
  const hasChanges = Object.values(changes).some((value) => !isPlainObject(value) || Object.keys(value).length > 0);
  if (!hasChanges) validationErrors.push({ field: 'body', message: 'nothing to change' });
  if (!Number.isInteger(requestBody.version) || requestBody.version < 0) {
    validationErrors.push({ field: 'version', message: 'must be the version you loaded' });
  }
  return result(validationErrors, { changes, version: requestBody.version });
}

/** PUT /api/employees/:employeeId/office : { officeLocationId } (null clears the assignment) */
export function validateOfficeAssignment(requestBody) {
  if (!isPlainObject(requestBody)) return result([{ field: 'body', message: 'must be a JSON object' }]);
  const { officeLocationId } = requestBody;
  if (officeLocationId !== null && !isValidObjectIdString(officeLocationId)) {
    return result([{ field: 'officeLocationId', message: 'must be an office id, or null to clear it' }]);
  }
  return result([], { officeLocationId: officeLocationId?.toLowerCase() ?? null });
}
