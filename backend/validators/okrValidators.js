/**
 * Request validation for the OKR endpoints. Pure functions; each returns
 * { isValid: true, sanitizedInput } or { isValid: false, validationErrors: [{ field, message }] }.
 * Business rules (permissions, parent/period consistency, limits) live in services/okrService.js.
 */

import { CALENDAR_DATE_PATTERN, OKR_FIELD_LIMITS } from '../constants/validation.js';
import { KEY_RESULT_UNITS, MILESTONE_STATUSES } from '../models/KeyResult.js';
import { OBJECTIVE_LEVELS, OKR_STATUSES } from '../models/Objective.js';
import { isValidObjectIdString } from './conversationValidators.js';

function isPlainObject(candidateValue) {
  return typeof candidateValue === 'object' && candidateValue !== null && !Array.isArray(candidateValue);
}

function result(validationErrors, sanitizedInput) {
  return validationErrors.length ? { isValid: false, validationErrors } : { isValid: true, sanitizedInput };
}

function bodyError() {
  return { isValid: false, validationErrors: [{ field: 'body', message: 'must be a JSON object' }] };
}

function checkTitle(rawTitle, fieldPath, validationErrors, { required = true } = {}) {
  if (rawTitle === undefined && !required) return undefined;
  const title = typeof rawTitle === 'string' ? rawTitle.trim() : '';
  if (title.length < OKR_FIELD_LIMITS.TITLE_MIN_LENGTH || title.length > OKR_FIELD_LIMITS.TITLE_MAX_LENGTH) {
    validationErrors.push({ field: fieldPath, message: `must be ${OKR_FIELD_LIMITS.TITLE_MIN_LENGTH}-${OKR_FIELD_LIMITS.TITLE_MAX_LENGTH} characters` });
  }
  return title;
}

function checkOptionalText(rawText, fieldPath, maxLength, validationErrors) {
  if (rawText === undefined) return undefined;
  if (rawText === null) return null;
  if (typeof rawText !== 'string' || rawText.trim().length > maxLength) {
    validationErrors.push({ field: fieldPath, message: `must be text of at most ${maxLength} characters` });
    return undefined;
  }
  return rawText.trim() || null;
}

function checkId(rawId, fieldPath, validationErrors) {
  if (!isValidObjectIdString(rawId)) {
    validationErrors.push({ field: fieldPath, message: 'must be a valid id' });
    return undefined;
  }
  return rawId.toLowerCase();
}

function checkVersion(rawVersion, validationErrors) {
  if (rawVersion === undefined) return undefined;
  if (!Number.isInteger(rawVersion) || rawVersion < 0) validationErrors.push({ field: 'version', message: 'must be the version number you edited' });
  return rawVersion;
}

function checkFiniteNumber(rawValue, fieldPath, validationErrors) {
  if (typeof rawValue !== 'number' || !Number.isFinite(rawValue)) validationErrors.push({ field: fieldPath, message: 'must be a number' });
  return rawValue;
}

function checkDueDate(rawDate, fieldPath, validationErrors) {
  if (rawDate === undefined || rawDate === null) return rawDate ?? undefined;
  if (typeof rawDate !== 'string' || !CALENDAR_DATE_PATTERN.test(rawDate)) validationErrors.push({ field: fieldPath, message: 'must be YYYY-MM-DD' });
  return rawDate;
}

/** POST /api/okrs/objectives */
export function validateObjectiveCreation(requestBody) {
  if (!isPlainObject(requestBody)) return bodyError();
  const validationErrors = [];
  const { level, period, departmentId, parentObjectiveId } = requestBody;
  if (!Object.values(OBJECTIVE_LEVELS).includes(level)) validationErrors.push({ field: 'level', message: 'must be company or team' });
  const isValidPeriod = isPlainObject(period) && Number.isInteger(period.year) && period.year >= 2000 && period.year <= 2100 && Number.isInteger(period.quarter) && period.quarter >= 1 && period.quarter <= 4;
  if (!isValidPeriod) validationErrors.push({ field: 'period', message: 'must be { year, quarter (1-4) }' });
  const sanitizedInput = {
    level,
    period: isValidPeriod ? { year: period.year, quarter: period.quarter } : null,
    title: checkTitle(requestBody.title, 'title', validationErrors),
    description: checkOptionalText(requestBody.description, 'description', OKR_FIELD_LIMITS.DESCRIPTION_MAX_LENGTH, validationErrors) ?? null,
    ownerEmployeeId: checkId(requestBody.ownerEmployeeId, 'ownerEmployeeId', validationErrors),
    departmentId: null,
    parentObjectiveId: null,
  };
  if (level === OBJECTIVE_LEVELS.TEAM) {
    sanitizedInput.departmentId = checkId(departmentId, 'departmentId', validationErrors);
    sanitizedInput.parentObjectiveId = checkId(parentObjectiveId, 'parentObjectiveId', validationErrors);
  }
  return result(validationErrors, sanitizedInput);
}

/** PATCH /api/okrs/objectives/:objectiveId */
export function validateObjectiveChanges(requestBody) {
  if (!isPlainObject(requestBody)) return bodyError();
  const validationErrors = [];
  const sanitizedInput = {
    title: checkTitle(requestBody.title, 'title', validationErrors, { required: false }),
    description: checkOptionalText(requestBody.description, 'description', OKR_FIELD_LIMITS.DESCRIPTION_MAX_LENGTH, validationErrors),
    ownerEmployeeId: requestBody.ownerEmployeeId === undefined ? undefined : checkId(requestBody.ownerEmployeeId, 'ownerEmployeeId', validationErrors),
    status: requestBody.status,
    version: checkVersion(requestBody.version, validationErrors),
  };
  if (requestBody.status !== undefined && !Object.values(OKR_STATUSES).includes(requestBody.status)) validationErrors.push({ field: 'status', message: 'must be active or archived' });
  if (Object.entries(sanitizedInput).every(([fieldName, value]) => fieldName === 'version' || value === undefined)) validationErrors.push({ field: 'body', message: 'nothing to change' });
  return result(validationErrors, sanitizedInput);
}

/** POST /api/okrs/objectives/:objectiveId/key-results */
export function validateKeyResultCreation(requestBody) {
  if (!isPlainObject(requestBody)) return bodyError();
  const validationErrors = [];
  if (!Object.values(KEY_RESULT_UNITS).includes(requestBody.unit)) validationErrors.push({ field: 'unit', message: `must be one of ${Object.values(KEY_RESULT_UNITS).join(', ')}` });
  const weight = requestBody.weight ?? 1;
  if (!Number.isInteger(weight) || weight < 1 || weight > OKR_FIELD_LIMITS.MAX_WEIGHT) validationErrors.push({ field: 'weight', message: `must be a whole number 1-${OKR_FIELD_LIMITS.MAX_WEIGHT}` });
  const milestones = requestBody.milestones ?? [];
  if (!Array.isArray(milestones) || milestones.length > OKR_FIELD_LIMITS.MAX_MILESTONES_PER_KEY_RESULT) {
    validationErrors.push({ field: 'milestones', message: `must be a list of at most ${OKR_FIELD_LIMITS.MAX_MILESTONES_PER_KEY_RESULT}` });
  }
  const sanitizedMilestones = Array.isArray(milestones)
    ? milestones.map((milestone, milestoneIndex) => ({
        title: checkTitle(milestone?.title, `milestones[${milestoneIndex}].title`, validationErrors),
        dueDate: checkDueDate(milestone?.dueDate, `milestones[${milestoneIndex}].dueDate`, validationErrors) ?? null,
      }))
    : [];
  const startValue = checkFiniteNumber(requestBody.startValue, 'startValue', validationErrors);
  const targetValue = checkFiniteNumber(requestBody.targetValue, 'targetValue', validationErrors);
  if (typeof startValue === 'number' && startValue === targetValue) validationErrors.push({ field: 'targetValue', message: 'must differ from startValue' });
  return result(validationErrors, {
    title: checkTitle(requestBody.title, 'title', validationErrors),
    ownerEmployeeId: checkId(requestBody.ownerEmployeeId, 'ownerEmployeeId', validationErrors),
    unit: requestBody.unit,
    startValue,
    targetValue,
    weight,
    milestones: sanitizedMilestones,
  });
}

/** PATCH /api/okrs/key-results/:keyResultId/progress: exactly one of currentValue / progressPercent. */
export function validateProgressUpdate(requestBody) {
  if (!isPlainObject(requestBody)) return bodyError();
  const validationErrors = [];
  const { currentValue, progressPercent } = requestBody;
  const hasValue = currentValue !== undefined;
  const hasPercent = progressPercent !== undefined;
  if (hasValue === hasPercent) validationErrors.push({ field: 'body', message: 'send exactly one of currentValue or progressPercent' });
  if (hasValue) checkFiniteNumber(currentValue, 'currentValue', validationErrors);
  if (hasPercent && (typeof progressPercent !== 'number' || !Number.isFinite(progressPercent) || progressPercent < 0 || progressPercent > 100)) {
    validationErrors.push({ field: 'progressPercent', message: 'must be a number from 0 to 100' });
  }
  return result(validationErrors, {
    currentValue: hasValue ? currentValue : undefined,
    progressPercent: hasPercent ? progressPercent : undefined,
    note: checkOptionalText(requestBody.note, 'note', OKR_FIELD_LIMITS.CHECK_IN_NOTE_MAX_LENGTH, validationErrors) ?? null,
    version: checkVersion(requestBody.version, validationErrors),
  });
}

/** POST /api/okrs/key-results/:keyResultId/milestones */
export function validateMilestoneCreation(requestBody) {
  if (!isPlainObject(requestBody)) return bodyError();
  const validationErrors = [];
  return result(validationErrors, {
    title: checkTitle(requestBody.title, 'title', validationErrors),
    dueDate: checkDueDate(requestBody.dueDate, 'dueDate', validationErrors) ?? null,
    version: checkVersion(requestBody.version, validationErrors),
  });
}

/** PATCH /api/okrs/key-results/:keyResultId/milestones/:milestoneId */
export function validateMilestoneChanges(requestBody) {
  if (!isPlainObject(requestBody)) return bodyError();
  const validationErrors = [];
  if (requestBody.status !== undefined && !Object.values(MILESTONE_STATUSES).includes(requestBody.status)) validationErrors.push({ field: 'status', message: 'must be pending or done' });
  const sanitizedInput = {
    status: requestBody.status,
    title: checkTitle(requestBody.title, 'title', validationErrors, { required: false }),
    dueDate: requestBody.dueDate === undefined ? undefined : checkDueDate(requestBody.dueDate, 'dueDate', validationErrors) ?? null,
    version: checkVersion(requestBody.version, validationErrors),
  };
  if (sanitizedInput.status === undefined && sanitizedInput.title === undefined && sanitizedInput.dueDate === undefined) validationErrors.push({ field: 'body', message: 'nothing to change' });
  return result(validationErrors, sanitizedInput);
}
