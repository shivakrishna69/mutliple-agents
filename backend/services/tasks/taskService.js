/**
 * A department's tasks. `scope` is services/tasks/boardAccess.js's: every task is looked up within
 * the scope's department, so one department's people never see or change another's tasks.
 *
 *   listTasks(scope, filters)        sprintId (an id, or "backlog"), assignee (an id, "me" or
 *                                    "unassigned"), status; ordered by column then orderIndex
 *   getTask(scope, taskId)           with its description and its activity (history and comments)
 *   createTask(scope, ...)           numbered "<code>-<n>"; in the backlog, unless a lead plans it into
 *                                    a sprint; at the bottom of its column
 *   updateTask(scope, ...)           who may change what:
 *                                      leads    anything
 *                                      members  title, description, type, priority, points, assignee
 *                                               and order of tasks they reported or are assigned to;
 *                                               the status of tasks assigned to them; never the sprint
 *                                    every change is recorded in the activity, and a new assignee is
 *                                    notified in the app
 *   addComment(scope, ...)           anyone on the board
 *   getTeamWork(scope, filters)      leads: each person's tasks by status and story points
 */

import { HTTP_STATUS } from '../../constants/httpStatus.js';
import { NOTIFICATION_MESSAGES } from '../../constants/messages.js';
import { TASK_SETTINGS } from '../../constants/validation.js';
import DepartmentBoard from '../../models/DepartmentBoard.js';
import { NOTIFICATION_TYPES } from '../../models/Notification.js';
import { SPRINT_STATUSES } from '../../models/Sprint.js';
import Task, { TASK_STATUSES } from '../../models/Task.js';
import TaskActivity, { TASK_ACTIVITY_TYPES } from '../../models/TaskActivity.js';
import { notifyUsers } from '../notifications.js';
import { assertCurrentVersion, saveVersioned } from '../serviceError.js';
import { boardRefusal, isLead, requireLead } from './boardAccess.js';
import { peopleByIds } from './boardService.js';
import { findSprint } from './sprintService.js';

/**
 * The page of the web app a task notification links to. The frontend's route must match
 * (frontend/src/constants/routes.js, the department board).
 */
export const TASK_APP_PATHS = Object.freeze({
  task: (departmentId, taskId) => `/boards/${departmentId}?task=${taskId}`,
});

export const BACKLOG = 'backlog';
export const ASSIGNEE_FILTERS = Object.freeze({ ME: 'me', UNASSIGNED: 'unassigned' });

// Fields recorded in the activity without their before and after (they can be long).
const TEXT_FIELDS = new Set(['title', 'description']);
// What a member may change on a task they reported or are assigned to (the status follows its own rule).
const MEMBER_EDITABLE_FIELDS = new Set([
  'title',
  'description',
  'taskType',
  'priority',
  'storyPoints',
  'assigneeId',
  'orderIndex',
]);

const idOrNull = (id) => id?.toString() ?? null;

function toTaskSummary(task, people, { withDescription = false } = {}) {
  const person = (userId) =>
    userId ? (people.get(userId.toString()) ?? { id: userId.toString(), name: null, email: null }) : null;
  return {
    id: task._id.toString(),
    key: task.key,
    title: task.title,
    ...(withDescription ? { description: task.description ?? '' } : {}),
    taskType: task.taskType,
    status: task.status,
    priority: task.priority,
    sprintId: idOrNull(task.sprintId),
    assignee: person(task.assigneeId),
    reporter: person(task.reporterId),
    storyPoints: task.storyPoints ?? null,
    orderIndex: task.orderIndex,
    doneAt: task.doneAt ?? null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    version: task.__v,
  };
}

async function summarize(tasks, options) {
  const people = await peopleByIds(tasks.flatMap((task) => [task.assigneeId, task.reporterId]));
  return tasks.map((task) => toTaskSummary(task, people, options));
}

const STATUS_ORDER = Object.values(TASK_STATUSES);

/** @param {{ sprintId: string|null, assignee: string|null, status: string|null }} filters */
export async function listTasks({ department }, { sprintId, assignee, status }, viewerUserId) {
  const filter = { departmentId: department._id };
  if (sprintId === BACKLOG) filter.sprintId = null;
  else if (sprintId) filter.sprintId = sprintId;
  if (assignee === ASSIGNEE_FILTERS.ME) filter.assigneeId = viewerUserId;
  else if (assignee === ASSIGNEE_FILTERS.UNASSIGNED) filter.assigneeId = null;
  else if (assignee) filter.assigneeId = assignee;
  if (status) filter.status = status;
  const tasks = await Task.find(filter)
    .select('-description')
    .sort({ orderIndex: 1, number: 1 })
    .limit(TASK_SETTINGS.TASKS_LISTED)
    .lean();
  tasks.sort((first, second) => STATUS_ORDER.indexOf(first.status) - STATUS_ORDER.indexOf(second.status));
  return summarize(tasks);
}

async function findTask(department, taskId) {
  const task = await Task.findOne({ _id: taskId, departmentId: department._id });
  if (!task) throw boardRefusal(HTTP_STATUS.NOT_FOUND, 'TASK_NOT_FOUND');
  return task;
}

function toActivitySummary(activity, people) {
  return {
    id: activity._id.toString(),
    type: activity.type,
    actor: people.get(activity.actorId.toString()) ?? { id: activity.actorId.toString(), name: null, email: null },
    changes: (activity.changes ?? []).map(({ field, from, to }) => ({ field, from: from ?? null, to: to ?? null })),
    body: activity.body ?? null,
    createdAt: activity.createdAt,
  };
}

export async function getTask({ department }, taskId) {
  const task = (await findTask(department, taskId)).toObject();
  const activity = await TaskActivity.find({ taskId: task._id })
    .sort({ createdAt: 1, _id: 1 })
    .limit(TASK_SETTINGS.ACTIVITY_LISTED)
    .lean();
  const people = await peopleByIds([
    task.assigneeId,
    task.reporterId,
    ...activity.map((entry) => entry.actorId),
    ...activity.flatMap((entry) =>
      (entry.changes ?? [])
        .filter((change) => change.field === 'assigneeId')
        .flatMap((change) => [change.from, change.to]),
    ),
  ]);
  return {
    task: toTaskSummary(task, people, { withDescription: true }),
    activity: activity.map((entry) => toActivitySummary(entry, people)),
  };
}

function requireMember(scope, userId) {
  if (userId !== null && !scope.memberUserIds.has(userId)) {
    throw boardRefusal(HTTP_STATUS.UNPROCESSABLE_CONTENT, 'ASSIGNEE_NOT_A_MEMBER');
  }
}

async function requirePlannableSprint(department, sprintId) {
  if (sprintId === null) return;
  const sprint = await findSprint(department, sprintId, { lean: true });
  if (sprint.status === SPRINT_STATUSES.COMPLETED) throw boardRefusal(HTTP_STATUS.CONFLICT, 'SPRINT_COMPLETED');
}

/** The order that puts a task at the bottom of its column (a sprint's, or the backlog's, status). */
async function bottomOrder(departmentId, sprintId, status) {
  const last = await Task.findOne({ departmentId, sprintId, status })
    .sort({ orderIndex: -1 })
    .select('orderIndex')
    .lean();
  return (last?.orderIndex ?? 0) + TASK_SETTINGS.ORDER_GAP;
}

async function notifyAssignee({ department, task, assigneeId, actor }) {
  if (!assigneeId || assigneeId === actor.id) return;
  await notifyUsers([assigneeId], () => ({
    type: NOTIFICATION_TYPES.TASK_ASSIGNED,
    title: NOTIFICATION_MESSAGES.TASK_ASSIGNED_TITLE(task.key),
    body: NOTIFICATION_MESSAGES.TASK_ASSIGNED_BODY(actor.name, task.title),
    link: TASK_APP_PATHS.task(department._id.toString(), task._id.toString()),
    data: { departmentId: department._id.toString(), taskId: task._id.toString(), taskKey: task.key },
  }));
}

/**
 * @param {{ title: string, description: string, taskType?: string, priority?: string, assigneeId: string|null,
 *   storyPoints: number|null, sprintId: string|null }} input
 * @param {{ id: string, name: string }} actor
 */
export async function createTask(scope, input, actor) {
  const { department } = scope;
  const sprintId = input.sprintId ?? null;
  if (sprintId !== null && !isLead(scope)) throw boardRefusal(HTTP_STATUS.FORBIDDEN, 'TASK_SPRINT_NOT_ALLOWED');
  await requirePlannableSprint(department, sprintId);
  requireMember(scope, input.assigneeId ?? null);

  const task = new Task({
    departmentId: department._id,
    // Placeholders until the task is known to be valid: a refused task takes no number.
    number: 1,
    key: department.code,
    sprintId,
    title: input.title,
    description: input.description ?? '',
    ...(input.taskType ? { taskType: input.taskType } : {}),
    ...(input.priority ? { priority: input.priority } : {}),
    assigneeId: input.assigneeId ?? null,
    reporterId: actor.id,
    storyPoints: input.storyPoints ?? null,
    orderIndex: await bottomOrder(department._id, sprintId, TASK_STATUSES.TODO),
  });
  await task.validate();
  const { taskCounter: number } = await DepartmentBoard.findOneAndUpdate(
    { _id: scope.board._id },
    { $inc: { taskCounter: 1 } },
    { new: true },
  ).lean();
  task.number = number;
  task.key = `${department.code}-${number}`;
  await task.save();
  await TaskActivity.create({
    taskId: task._id,
    departmentId: department._id,
    actorId: actor.id,
    type: TASK_ACTIVITY_TYPES.CREATED,
  });
  await notifyAssignee({ department, task, assigneeId: idOrNull(task.assigneeId), actor });
  return (await getTask(scope, task._id)).task;
}

/** Refuses the changes this person may not make (see the module comment). */
function checkChangeRights(scope, task, changes, actorUserId) {
  if (isLead(scope)) return;
  if (changes.sprintId !== undefined) throw boardRefusal(HTTP_STATUS.FORBIDDEN, 'TASK_SPRINT_NOT_ALLOWED');
  const isAssignee = idOrNull(task.assigneeId) === actorUserId;
  const isReporter = idOrNull(task.reporterId) === actorUserId;
  if (changes.status !== undefined && changes.status !== task.status && !isAssignee) {
    throw boardRefusal(HTTP_STATUS.FORBIDDEN, 'TASK_STATUS_NOT_ALLOWED');
  }
  const editsFields = Object.keys(changes).some((field) => MEMBER_EDITABLE_FIELDS.has(field));
  if (editsFields && !isAssignee && !isReporter) throw boardRefusal(HTTP_STATUS.FORBIDDEN, 'TASK_EDIT_NOT_ALLOWED');
}

/** A field value as it is compared and recorded: ids as strings, everything else as it is. */
const comparable = (value) => {
  if (value === undefined || value === null) return null;
  return typeof value === 'object' ? value.toString() : value;
};

/**
 * @param {{ changes: object, version: number }} input
 * @param {{ id: string, name: string }} actor
 */
export async function updateTask(scope, taskId, { changes, version }, actor) {
  const { department } = scope;
  const task = await findTask(department, taskId);
  assertCurrentVersion(task, version);
  checkChangeRights(scope, task, changes, actor.id);
  if (changes.assigneeId !== undefined) requireMember(scope, changes.assigneeId);
  if (changes.sprintId !== undefined) await requirePlannableSprint(department, changes.sprintId);

  const before = task.toObject();
  for (const [field, value] of Object.entries(changes)) task.set(field, value);
  const movedColumn =
    (changes.status !== undefined && changes.status !== before.status) ||
    (changes.sprintId !== undefined && comparable(changes.sprintId) !== comparable(before.sprintId));
  if (movedColumn && changes.orderIndex === undefined) {
    task.orderIndex = await bottomOrder(department._id, task.sprintId, task.status);
  }
  if (task.status === TASK_STATUSES.DONE && before.status !== TASK_STATUSES.DONE) task.doneAt = new Date();
  if (task.status !== TASK_STATUSES.DONE) task.doneAt = null;

  const recorded = Object.keys(changes)
    .filter((field) => field !== 'orderIndex' && comparable(before[field]) !== comparable(task.get(field)))
    .map((field) =>
      TEXT_FIELDS.has(field)
        ? { field, from: null, to: null }
        : { field, from: comparable(before[field]), to: comparable(task.get(field)) },
    );
  if (recorded.length === 0 && task.orderIndex === before.orderIndex) {
    return (await getTask(scope, task._id)).task;
  }
  await saveVersioned(task);
  if (recorded.length > 0) {
    await TaskActivity.create({
      taskId: task._id,
      departmentId: department._id,
      actorId: actor.id,
      type: TASK_ACTIVITY_TYPES.UPDATED,
      changes: recorded,
    });
  }
  const newAssignee = recorded.find((change) => change.field === 'assigneeId')?.to ?? null;
  if (newAssignee) await notifyAssignee({ department, task, assigneeId: newAssignee, actor });
  return (await getTask(scope, task._id)).task;
}

export async function addComment({ department }, taskId, body, actor) {
  const task = await findTask(department, taskId);
  const comment = await TaskActivity.create({
    taskId: task._id,
    departmentId: department._id,
    actorId: actor.id,
    type: TASK_ACTIVITY_TYPES.COMMENTED,
    body,
  });
  const people = await peopleByIds([actor.id]);
  return toActivitySummary(comment.toObject(), people);
}

/** @param {{ sprintId: string|null }} filters  a sprint's work, or (null) everything open and done */
export async function getTeamWork(scope, { sprintId }) {
  requireLead(scope);
  const { department } = scope;
  const match = { departmentId: department._id };
  if (sprintId === BACKLOG) match.sprintId = null;
  else if (sprintId) match.sprintId = (await findSprint(department, sprintId, { lean: true }))._id;
  const rows = await Task.aggregate([
    { $match: match },
    {
      $group: {
        _id: { assigneeId: '$assigneeId', status: '$status' },
        count: { $sum: 1 },
        points: { $sum: { $ifNull: ['$storyPoints', 0] } },
      },
    },
  ]);
  const emptyCounts = () => Object.fromEntries(Object.values(TASK_STATUSES).map((status) => [status, 0]));
  const byPerson = new Map();
  const totals = { tasksByStatus: emptyCounts(), points: 0, pointsDone: 0 };
  for (const { _id, count, points } of rows) {
    const key = idOrNull(_id.assigneeId);
    const entry = byPerson.get(key) ?? { tasksByStatus: emptyCounts(), points: 0, pointsDone: 0 };
    entry.tasksByStatus[_id.status] = count;
    entry.points += points;
    totals.tasksByStatus[_id.status] += count;
    totals.points += points;
    if (_id.status === TASK_STATUSES.DONE) {
      entry.pointsDone += points;
      totals.pointsDone += points;
    }
    byPerson.set(key, entry);
  }
  const people = await peopleByIds([...scope.memberUserIds, ...[...byPerson.keys()].filter(Boolean)]);
  const zero = () => ({ tasksByStatus: emptyCounts(), points: 0, pointsDone: 0 });
  const members = [...scope.memberUserIds]
    .map((userId) => ({ person: people.get(userId), ...(byPerson.get(userId) ?? zero()) }))
    .filter((entry) => entry.person)
    .sort((first, second) => first.person.name.localeCompare(second.person.name));
  // Tasks of people no longer in the department are still shown, so nothing goes missing.
  const formerMembers = [...byPerson.keys()]
    .filter((userId) => userId && !scope.memberUserIds.has(userId))
    .map((userId) => ({
      person: people.get(userId) ?? { id: userId, name: null, email: null },
      ...byPerson.get(userId),
    }));
  return { members: [...members, ...formerMembers], unassigned: byPerson.get(null) ?? zero(), totals };
}
