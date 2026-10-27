/**
 * Request validation for the office endpoints. These check the shape of a request only
 * (validators/requestShape.js); field values (time zone, coordinates, shift times, weekly-off
 * rules...) are validated by models/OfficeLocation.js, the single authority for them, and its errors
 * are returned as 400 with field details.
 */

import { isValidObjectIdString } from './conversationValidators.js';
import {
  bodyNotObjectResult,
  checkVersion,
  hasChanges,
  isPlainObject,
  pickShapedFields,
  validationResult,
} from './requestShape.js';

const OFFICE_FIELDS = Object.freeze(['name', 'code', 'coordinates', 'timeZone', 'workday']);
const OFFICE_GROUPS = Object.freeze({
  coordinates: Object.freeze(['lat', 'lng']),
  workday: Object.freeze([
    'shiftStartLocalTime',
    'shiftEndLocalTime',
    'lateGraceMinutes',
    'halfDayAfterMinutes',
    'weeklyOffRules',
  ]),
});

/** POST /api/offices */
export function validateOfficeCreation(requestBody) {
  if (!isPlainObject(requestBody)) return bodyNotObjectResult();
  const validationErrors = [];
  return validationResult(
    validationErrors,
    pickShapedFields(requestBody, OFFICE_FIELDS, OFFICE_GROUPS, validationErrors),
  );
}

/** PATCH /api/offices/:officeLocationId */
export function validateOfficeChanges(requestBody) {
  if (!isPlainObject(requestBody)) return bodyNotObjectResult();
  const validationErrors = [];
  const changes = pickShapedFields(requestBody, OFFICE_FIELDS, OFFICE_GROUPS, validationErrors);
  if (!hasChanges(changes)) validationErrors.push({ field: 'body', message: 'nothing to change' });
  const version = checkVersion(requestBody.version, validationErrors);
  return validationResult(validationErrors, { changes, version });
}

/** PUT /api/employees/:employeeId/office : { officeLocationId } (null clears the assignment) */
export function validateOfficeAssignment(requestBody) {
  if (!isPlainObject(requestBody)) return bodyNotObjectResult();
  const { officeLocationId } = requestBody;
  if (officeLocationId !== null && !isValidObjectIdString(officeLocationId)) {
    return validationResult([{ field: 'officeLocationId', message: 'must be an office id, or null to clear it' }]);
  }
  return validationResult([], { officeLocationId: officeLocationId?.toLowerCase() ?? null });
}
