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
  'supportEmail',
  'termsUrl',
  'privacyUrl',
  'brandColors',
  'timeZone',
  'employeeIdDigits',
  'presence',
]);
const SETTINGS_GROUPS = Object.freeze({
  brandColors: Object.freeze(['primary', 'accent']),
  presence: Object.freeze(['enabled', 'awayAfterMinutes', 'detailRetentionDays', 'summaryRetentionDays']),
});

/** PATCH /api/company/settings */
export function validateCompanySettingsChanges(requestBody) {
  if (!isPlainObject(requestBody)) return bodyNotObjectResult();
  const validationErrors = [];
  const changes = pickShapedFields(requestBody, SETTINGS_FIELDS, SETTINGS_GROUPS, validationErrors);
  // The model would turn "yes" or 1 into true; a switch must be sent as a switch.
  if (changes.presence?.enabled !== undefined && typeof changes.presence.enabled !== 'boolean') {
    validationErrors.push({ field: 'presence.enabled', message: 'must be true or false' });
  }
  if (!hasChanges(changes)) validationErrors.push({ field: 'body', message: 'nothing to change' });
  const version = checkVersion(requestBody.version, validationErrors);
  return validationResult(validationErrors, { changes, version });
}
