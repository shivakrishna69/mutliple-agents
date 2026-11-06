/**
 * Request shapes of the knowledge base API (routes/departmentKnowledgeRoutes.js). Field values are
 * validated by the model (models/DepartmentAgent.js); this checks the shape: a JSON object, only
 * known fields, their types, and the version an edit is based on.
 */

import { AGENT_STATUSES } from '../models/DepartmentAgent.js';
import { isValidObjectIdString } from './conversationValidators.js';
import { bodyNotObjectResult, checkVersion, isPlainObject, pickFields, validationResult } from './requestShape.js';

const SETTINGS_FIELDS = Object.freeze(['name', 'systemPrompt', 'status', 'managedBy']);

/** PATCH /settings: { name?, systemPrompt?, status?, managedBy? (a user id, or null), version }. */
export function validateKnowledgeSettingsChanges(requestBody) {
  if (!isPlainObject(requestBody)) return bodyNotObjectResult();
  const validationErrors = [];
  const changes = pickFields(requestBody, SETTINGS_FIELDS);
  for (const textField of ['name', 'systemPrompt']) {
    if (changes[textField] !== undefined && typeof changes[textField] !== 'string') {
      validationErrors.push({ field: textField, message: 'must be text' });
    }
  }
  if (changes.status !== undefined && !Object.values(AGENT_STATUSES).includes(changes.status)) {
    validationErrors.push({ field: 'status', message: `must be ${Object.values(AGENT_STATUSES).join(' or ')}` });
  }
  if (changes.managedBy !== undefined && changes.managedBy !== null && !isValidObjectIdString(changes.managedBy)) {
    validationErrors.push({ field: 'managedBy', message: 'must be a user id, or null for no lead' });
  }
  const unknownFields = Object.keys(requestBody).filter((field) => ![...SETTINGS_FIELDS, 'version'].includes(field));
  for (const field of unknownFields) validationErrors.push({ field, message: 'is not a setting' });
  if (Object.keys(changes).length === 0) validationErrors.push({ field: 'body', message: 'nothing to change' });
  const version = checkVersion(requestBody.version, validationErrors);
  return validationResult(validationErrors, { changes, version });
}

/** The :docId route parameter. */
export function documentIdErrors(params) {
  return isValidObjectIdString(params.docId) ? null : [{ field: 'docId', message: 'must be an id' }];
}
