/**
 * Request validation for department task boards. Shapes and ids only: field values (lengths, enums,
 * dates, story points) are checked by the models (models/Task.js, Sprint.js), the single authority
 * for them. Unknown fields are refused, so a typo fails loudly instead of being ignored.
 */

import { TASK_SETTINGS } from '../constants/validation.js';
import { TASK_STATUSES } from '../models/Task.js';
import { SPRINT_STATUSES } from '../models/Sprint.js';
import { ASSIGNEE_FILTERS, BACKLOG } from '../services/tasks/taskService.js';
import { isValidObjectIdString } from './conversationValidators.js';
import { bodyNotObjectResult, checkVersion, isPlainObject, validationResult } from './requestShape.js';

const TASK_FIELDS = Object.freeze([
  'title',
  'description',
  'taskType',
  'priority',
  'assigneeId',
  'storyPoints',
  'sprintId',
]);
const TASK_CHANGE_FIELDS = Object.freeze([...TASK_FIELDS, 'status', 'orderIndex']);
const SPRINT_FIELDS = Object.freeze(['name', 'goal', 'startDate', 'endDate']);

function refuseUnknownFields(body, allowed, validationErrors) {
  for (const field of Object.keys(body)) {
    if (!allowed.includes(field)) validationErrors.push({ field, message: 'is not expected' });
  }
}

/** Copies the known fields, checking the ones that are references, numbers or text. */
function pickTaskFields(body, fieldNames, validationErrors) {
  const fields = {};
  for (const field of fieldNames) {
    if (body[field] === undefined) continue;
    const value = body[field];
    if (field === 'assigneeId' || field === 'sprintId') {
      if (value === null) fields[field] = null;
      else if (isValidObjectIdString(value)) fields[field] = value.toLowerCase();
      else validationErrors.push({ field, message: 'must be an id, or null' });
    } else if (field === 'storyPoints') {
      if (value === null || Number.isInteger(value)) fields[field] = value;
      else validationErrors.push({ field, message: 'must be a whole number, or null' });
    } else if (field === 'orderIndex') {
      if (typeof value === 'number' && Number.isFinite(value)) fields[field] = value;
      else validationErrors.push({ field, message: 'must be a number' });
    } else if (typeof value !== 'string') {
      validationErrors.push({ field, message: 'must be text' });
    } else {
      fields[field] = value;
    }
  }
  return fields;
}

/** POST /tasks: { title, description?, taskType?, priority?, assigneeId?, storyPoints?, sprintId? } */
export function validateTaskCreation(body) {
  if (!isPlainObject(body)) return bodyNotObjectResult();
  const validationErrors = [];
  refuseUnknownFields(body, TASK_FIELDS, validationErrors);
  const fields = pickTaskFields(body, TASK_FIELDS, validationErrors);
  if (typeof fields.title !== 'string' || fields.title.trim() === '') {
    validationErrors.push({ field: 'title', message: 'is required' });
  }
  return validationResult(validationErrors, fields);
}

/** PATCH /tasks/:taskId: { ...changes, version } */
export function validateTaskChanges(body) {
  if (!isPlainObject(body)) return bodyNotObjectResult();
  const validationErrors = [];
  refuseUnknownFields(body, [...TASK_CHANGE_FIELDS, 'version'], validationErrors);
  const changes = pickTaskFields(body, TASK_CHANGE_FIELDS, validationErrors);
  if (changes.status !== undefined && !Object.values(TASK_STATUSES).includes(changes.status)) {
    validationErrors.push({ field: 'status', message: `must be one of ${Object.values(TASK_STATUSES).join(', ')}` });
  }
  if (Object.keys(changes).length === 0) validationErrors.push({ field: 'body', message: 'nothing to change' });
  const version = checkVersion(body.version, validationErrors);
  return validationResult(validationErrors, { changes, version });
}

/** GET /tasks?sprintId=&assignee=&status= */
export function validateTaskQuery(query) {
  const validationErrors = [];
  const { sprintId, assignee, status } = query;
  const read = (value) => (typeof value === 'string' && value !== '' ? value : null);
  const filters = { sprintId: read(sprintId), assignee: read(assignee), status: read(status) };
  if (filters.sprintId && filters.sprintId !== BACKLOG && !isValidObjectIdString(filters.sprintId)) {
    validationErrors.push({ field: 'sprintId', message: `must be a sprint id, or "${BACKLOG}"` });
  }
  const assigneeWords = Object.values(ASSIGNEE_FILTERS);
  if (filters.assignee && !assigneeWords.includes(filters.assignee) && !isValidObjectIdString(filters.assignee)) {
    validationErrors.push({ field: 'assignee', message: `must be a user id, or one of ${assigneeWords.join(', ')}` });
  }
  if (filters.status && !Object.values(TASK_STATUSES).includes(filters.status)) {
    validationErrors.push({ field: 'status', message: `must be one of ${Object.values(TASK_STATUSES).join(', ')}` });
  }
  return validationResult(validationErrors, filters);
}

/** POST /tasks/:taskId/comments: { body } */
export function validateComment(body) {
  if (!isPlainObject(body)) return bodyNotObjectResult();
  const validationErrors = [];
  refuseUnknownFields(body, ['body'], validationErrors);
  const text = typeof body.body === 'string' ? body.body.trim() : '';
  if (!text) validationErrors.push({ field: 'body', message: 'is required' });
  else if (text.length > TASK_SETTINGS.COMMENT_MAX_LENGTH) {
    validationErrors.push({ field: 'body', message: `must be at most ${TASK_SETTINGS.COMMENT_MAX_LENGTH} characters` });
  }
  return validationResult(validationErrors, { body: text });
}

/** POST /sprints: { name, goal?, startDate, endDate } */
export function validateSprintCreation(body) {
  if (!isPlainObject(body)) return bodyNotObjectResult();
  const validationErrors = [];
  refuseUnknownFields(body, SPRINT_FIELDS, validationErrors);
  const fields = pickTaskFields(body, SPRINT_FIELDS, validationErrors);
  for (const field of ['name', 'startDate', 'endDate']) {
    if (typeof fields[field] !== 'string' || fields[field].trim() === '') {
      validationErrors.push({ field, message: 'is required' });
    }
  }
  return validationResult(validationErrors, fields);
}

/** PATCH /sprints/:sprintId: { name?, goal?, startDate?, endDate?, status?, version } */
export function validateSprintChanges(body) {
  if (!isPlainObject(body)) return bodyNotObjectResult();
  const validationErrors = [];
  refuseUnknownFields(body, [...SPRINT_FIELDS, 'status', 'version'], validationErrors);
  const changes = pickTaskFields(body, [...SPRINT_FIELDS, 'status'], validationErrors);
  if (changes.status !== undefined && !Object.values(SPRINT_STATUSES).includes(changes.status)) {
    validationErrors.push({ field: 'status', message: `must be one of ${Object.values(SPRINT_STATUSES).join(', ')}` });
  }
  if (Object.keys(changes).length === 0) validationErrors.push({ field: 'body', message: 'nothing to change' });
  const version = checkVersion(body.version, validationErrors);
  return validationResult(validationErrors, { changes, version });
}

/** PUT /task-leads: { leadUserIds: [id], version } */
export function validateTaskLeads(body) {
  if (!isPlainObject(body)) return bodyNotObjectResult();
  const validationErrors = [];
  refuseUnknownFields(body, ['leadUserIds', 'version'], validationErrors);
  const { leadUserIds } = body;
  if (!Array.isArray(leadUserIds) || leadUserIds.some((userId) => !isValidObjectIdString(userId))) {
    validationErrors.push({ field: 'leadUserIds', message: 'must be a list of user ids' });
  } else if (leadUserIds.length > TASK_SETTINGS.LEADS_MAX) {
    validationErrors.push({ field: 'leadUserIds', message: `must name at most ${TASK_SETTINGS.LEADS_MAX} people` });
  }
  const version = checkVersion(body.version, validationErrors);
  return validationResult(validationErrors, {
    leadUserIds: Array.isArray(leadUserIds) ? leadUserIds.map((userId) => String(userId).toLowerCase()) : [],
    version,
  });
}
