/**
 * Department task boards. Every function returns the response's `data` (and, for changes, the
 * backend's `message` as `notice`), and throws ApiError on failure (api/httpClient.js). Changes take
 * the CSRF token; edits send the version they are based on (409 STALE_VERSION when it is old).
 *
 * Backend references (backend/controllers/taskBoardController.js), under /api/departments/:id:
 *   GET   /api/task-boards                the boards this person can open
 *   GET   /board                          people, leads, the viewer's rights, the active sprint
 *   GET   /sprints  POST /sprints  PATCH /sprints/:sprintId
 *   GET   /tasks?sprintId=&assignee=&status=   POST /tasks
 *   GET   /tasks/:taskId  PATCH /tasks/:taskId  POST /tasks/:taskId/comments
 */

import { sendApiRequest } from './httpClient.js';
import { toQueryString } from './queryString.js';

const encode = encodeURIComponent;
const boardPath = (departmentId) => `/api/departments/${encode(departmentId)}`;

async function getData(endpointPath, callerSignal) {
  const { responseData } = await sendApiRequest({ method: 'GET', endpointPath, callerSignal });
  return responseData;
}

async function change(method, endpointPath, requestPayload, csrfToken) {
  const { responseData, responseMessage } = await sendApiRequest({ method, endpointPath, requestPayload, csrfToken });
  return { ...responseData, notice: responseMessage };
}

export const requestMyBoards = (callerSignal) => getData('/api/task-boards', callerSignal);

export const requestBoard = (departmentId, callerSignal) => getData(`${boardPath(departmentId)}/board`, callerSignal);

export const requestSprints = (departmentId, callerSignal) =>
  getData(`${boardPath(departmentId)}/sprints`, callerSignal);

export const requestSprintCreation = (departmentId, sprint, csrfToken) =>
  change('POST', `${boardPath(departmentId)}/sprints`, sprint, csrfToken);

export const requestSprintUpdate = (departmentId, sprintId, changesWithVersion, csrfToken) =>
  change('PATCH', `${boardPath(departmentId)}/sprints/${encode(sprintId)}`, changesWithVersion, csrfToken);

/** @param {{ sprintId?: string, assignee?: string, status?: string }} filters */
export const requestTasks = (departmentId, filters, callerSignal) =>
  getData(`${boardPath(departmentId)}/tasks${toQueryString(filters)}`, callerSignal);

export const requestTaskCreation = (departmentId, task, csrfToken) =>
  change('POST', `${boardPath(departmentId)}/tasks`, task, csrfToken);

export const requestTask = (departmentId, taskId, callerSignal) =>
  getData(`${boardPath(departmentId)}/tasks/${encode(taskId)}`, callerSignal);

export const requestTaskUpdate = (departmentId, taskId, changesWithVersion, csrfToken) =>
  change('PATCH', `${boardPath(departmentId)}/tasks/${encode(taskId)}`, changesWithVersion, csrfToken);

export const requestTaskComment = (departmentId, taskId, body, csrfToken) =>
  change('POST', `${boardPath(departmentId)}/tasks/${encode(taskId)}/comments`, { body }, csrfToken);
