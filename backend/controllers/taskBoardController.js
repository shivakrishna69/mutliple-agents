/**
 * Department task boards (services/tasks/), mounted at /api/departments/:departmentId behind
 * middleware/departmentBoardScope.js (who is on the board, and as lead or member):
 *
 *   GET   /board                         the board: people, leads, the viewer's rights, the active sprint
 *   PUT   /task-leads                    { leadUserIds, version }: the head (or an admin) names task leads
 *   GET   /sprints                       sprints with their progress
 *   POST  /sprints                       { name, goal?, startDate, endDate }          leads
 *   PATCH /sprints/:sprintId             { ...changes, status?, version }              leads
 *   GET   /tasks?sprintId=&assignee=&status=
 *   POST  /tasks                         { title, description?, taskType?, priority?, assigneeId?,
 *                                          storyPoints?, sprintId? (leads) }
 *   GET   /tasks/metrics?sprintId=       each person's work                           leads
 *   GET   /tasks/:taskId                 with its activity and comments
 *   PATCH /tasks/:taskId                 { ...changes, version }: status, order, assignee, fields
 *   POST  /tasks/:taskId/comments        { body }
 *
 * Every change is audited (category "tasks") with ids and the fields changed, never their text.
 */

import { HTTP_STATUS } from '../constants/httpStatus.js';
import { TASK_MESSAGES } from '../constants/messages.js';
import { TASK_AUDIT_CATEGORY } from '../middleware/departmentBoardScope.js';
import { getBoardSummary, setTaskLeads } from '../services/tasks/boardService.js';
import { createSprint, listSprints, updateSprint } from '../services/tasks/sprintService.js';
import { addComment, createTask, getTask, getTeamWork, listTasks, updateTask } from '../services/tasks/taskService.js';
import {
  validateComment,
  validateSprintChanges,
  validateSprintCreation,
  validateTaskChanges,
  validateTaskCreation,
  validateTaskLeads,
  validateTaskQuery,
} from '../validators/taskValidators.js';
import { createWorkforceHandlerFactory, idParamErrors } from './workforceHandler.js';

const boardHandler = createWorkforceHandlerFactory({
  auditCategory: TASK_AUDIT_CATEGORY,
  restrictedMessage: TASK_MESSAGES.NOT_ALLOWED,
  inputInvalidMessage: TASK_MESSAGES.INPUT_INVALID,
});
// Who may act is decided per department by the board scope, not by role.
const SCOPED_READ = Object.freeze({ isWrite: false });
const SCOPED_WRITE = Object.freeze({ isWrite: true });

const actorOf = (req) => ({ id: req.user.id, name: req.user.name });
const auditScope = (req) => ({
  departmentId: req.boardScope.department._id.toString(),
  boardRole: req.boardScope.role,
});

export const getBoard = boardHandler('view_task_board', SCOPED_READ, async (req) => ({
  message: TASK_MESSAGES.BOARD_RETRIEVED,
  data: { board: await getBoardSummary(req.boardScope) },
}));

export const putTaskLeads = boardHandler('set_task_leads', SCOPED_WRITE, async (req) => {
  const validation = validateTaskLeads(req.body);
  if (!validation.isValid) return { validationErrors: validation.validationErrors };
  const board = await setTaskLeads(req.boardScope, validation.sanitizedInput);
  return {
    message: TASK_MESSAGES.LEADS_UPDATED,
    data: { board },
    auditDetails: { ...auditScope(req), leadCount: validation.sanitizedInput.leadUserIds.length },
  };
});

export const getSprints = boardHandler('list_sprints', SCOPED_READ, async (req) => ({
  message: TASK_MESSAGES.SPRINTS_RETRIEVED,
  data: { sprints: await listSprints(req.boardScope) },
}));

export const postSprint = boardHandler('create_sprint', SCOPED_WRITE, async (req) => {
  const validation = validateSprintCreation(req.body);
  if (!validation.isValid) return { validationErrors: validation.validationErrors };
  const sprint = await createSprint(req.boardScope, validation.sanitizedInput, req.user.id);
  return {
    httpStatus: HTTP_STATUS.CREATED,
    message: TASK_MESSAGES.SPRINT_CREATED,
    data: { sprint },
    auditDetails: { ...auditScope(req), sprintId: sprint.id },
  };
});

export const patchSprint = boardHandler('update_sprint', SCOPED_WRITE, async (req) => {
  const invalid = idParamErrors(req.params, 'sprintId');
  if (invalid) return { validationErrors: invalid };
  const validation = validateSprintChanges(req.body);
  if (!validation.isValid) return { validationErrors: validation.validationErrors };
  const sprint = await updateSprint(req.boardScope, req.params.sprintId, validation.sanitizedInput);
  return {
    message: TASK_MESSAGES.SPRINT_UPDATED,
    data: { sprint },
    auditDetails: {
      ...auditScope(req),
      sprintId: sprint.id,
      fields: Object.keys(validation.sanitizedInput.changes),
      status: sprint.status,
    },
  };
});

export const getTasks = boardHandler('list_tasks', SCOPED_READ, async (req) => {
  const validation = validateTaskQuery(req.query);
  if (!validation.isValid) return { validationErrors: validation.validationErrors };
  return {
    message: TASK_MESSAGES.TASKS_RETRIEVED,
    data: { tasks: await listTasks(req.boardScope, validation.sanitizedInput, req.user.id) },
  };
});

export const postTask = boardHandler('create_task', SCOPED_WRITE, async (req) => {
  const validation = validateTaskCreation(req.body);
  if (!validation.isValid) return { validationErrors: validation.validationErrors };
  const task = await createTask(req.boardScope, validation.sanitizedInput, actorOf(req));
  return {
    httpStatus: HTTP_STATUS.CREATED,
    message: TASK_MESSAGES.TASK_CREATED,
    data: { task },
    auditDetails: { ...auditScope(req), taskId: task.id, taskKey: task.key },
  };
});

export const getTeamWorkMetrics = boardHandler('view_team_work', SCOPED_READ, async (req) => {
  const validation = validateTaskQuery({ sprintId: req.query.sprintId });
  if (!validation.isValid) return { validationErrors: validation.validationErrors };
  return {
    message: TASK_MESSAGES.METRICS_RETRIEVED,
    data: await getTeamWork(req.boardScope, validation.sanitizedInput),
  };
});

export const getTaskDetail = boardHandler('view_task', SCOPED_READ, async (req) => {
  const invalid = idParamErrors(req.params, 'taskId');
  if (invalid) return { validationErrors: invalid };
  return { message: TASK_MESSAGES.TASK_RETRIEVED, data: await getTask(req.boardScope, req.params.taskId) };
});

export const patchTask = boardHandler('update_task', SCOPED_WRITE, async (req) => {
  const invalid = idParamErrors(req.params, 'taskId');
  if (invalid) return { validationErrors: invalid };
  const validation = validateTaskChanges(req.body);
  if (!validation.isValid) return { validationErrors: validation.validationErrors };
  const task = await updateTask(req.boardScope, req.params.taskId, validation.sanitizedInput, actorOf(req));
  return {
    message: TASK_MESSAGES.TASK_UPDATED,
    data: { task },
    auditDetails: { ...auditScope(req), taskId: task.id, fields: Object.keys(validation.sanitizedInput.changes) },
  };
});

export const postTaskComment = boardHandler('comment_on_task', SCOPED_WRITE, async (req) => {
  const invalid = idParamErrors(req.params, 'taskId');
  if (invalid) return { validationErrors: invalid };
  const validation = validateComment(req.body);
  if (!validation.isValid) return { validationErrors: validation.validationErrors };
  const comment = await addComment(req.boardScope, req.params.taskId, validation.sanitizedInput.body, actorOf(req));
  return {
    httpStatus: HTTP_STATUS.CREATED,
    message: TASK_MESSAGES.COMMENT_ADDED,
    data: { comment },
    auditDetails: { ...auditScope(req), taskId: req.params.taskId },
  };
});
