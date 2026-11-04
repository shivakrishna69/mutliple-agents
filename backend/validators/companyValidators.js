/**
 * Request validation for the company settings. These check the shape of a request only
 * (validators/requestShape.js); field values (short code, domain, colours, time zone...) are
 * validated by models/CompanySettings.js, the single authority for them.
 */

import {
  bodyNotObjectResult,
  checkVersion,
  hasChanges,
  isPlainObject,
  pickShapedFields,
  validationResult,
} from './requestShape.js';

const SETTINGS_FIELDS = Object.freeze([
  'name',
  'shortCode',
  'emailDomain',
  'logoUrl',
  'brandColors',
  'timeZone',
  'employeeIdDigits',
]);
const SETTINGS_GROUPS = Object.freeze({ brandColors: Object.freeze(['primary', 'accent']) });

/** PATCH /api/company/settings */
export function validateCompanySettingsChanges(requestBody) {
  if (!isPlainObject(requestBody)) return bodyNotObjectResult();
  const validationErrors = [];
  const changes = pickShapedFields(requestBody, SETTINGS_FIELDS, SETTINGS_GROUPS, validationErrors);
  if (!hasChanges(changes)) validationErrors.push({ field: 'body', message: 'nothing to change' });
  const version = checkVersion(requestBody.version, validationErrors);
  return validationResult(validationErrors, { changes, version });
}
