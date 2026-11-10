/**
 * Request validation for the department endpoints. These check the shape of a request only
 * (validators/requestShape.js) and that references are ids; field values (code, slug, name...) are
 * validated by models/Department.js, the single authority for them.
 */

import { isValidObjectIdString } from './conversationValidators.js';
import {
  bodyNotObjectResult,
  checkVersion,
  hasChanges,
  isPlainObject,
  pickFields,
  validationResult,
} from './requestShape.js';

const DEPARTMENT_FIELDS = Object.freeze([
  'name',
  'code',
  'slug',
  'budgetCode',
  'parentDepartmentId',
  'departmentHeadId',
  'isActive',
  'isSharedService',
]);
const REFERENCE_FIELDS = Object.freeze(['parentDepartmentId', 'departmentHeadId']);

/** The known fields, with each reference an id or null (lowercased, as Mongo ids are). */
function pickDepartmentFields(requestBody, validationErrors) {
  const fields = pickFields(requestBody, DEPARTMENT_FIELDS);
  for (const referenceField of REFERENCE_FIELDS) {
    const reference = fields[referenceField];
    if (reference === undefined || reference === null) continue;
    if (isValidObjectIdString(reference)) fields[referenceField] = reference.toLowerCase();
    else validationErrors.push({ field: referenceField, message: 'must be an id, or null' });
  }
  for (const switchField of ['isActive', 'isSharedService']) {
    if (fields[switchField] !== undefined && typeof fields[switchField] !== 'boolean') {
      validationErrors.push({ field: switchField, message: 'must be true or false' });
    }
  }
  return fields;
}

/** POST /api/departments */
export function validateDepartmentCreation(requestBody) {
  if (!isPlainObject(requestBody)) return bodyNotObjectResult();
  const validationErrors = [];
  return validationResult(validationErrors, pickDepartmentFields(requestBody, validationErrors));
}

/** PATCH /api/departments/:departmentId */
export function validateDepartmentChanges(requestBody) {
  if (!isPlainObject(requestBody)) return bodyNotObjectResult();
  const validationErrors = [];
  const changes = pickDepartmentFields(requestBody, validationErrors);
  if (!hasChanges(changes)) validationErrors.push({ field: 'body', message: 'nothing to change' });
  const version = checkVersion(requestBody.version, validationErrors);
  return validationResult(validationErrors, { changes, version });
}
