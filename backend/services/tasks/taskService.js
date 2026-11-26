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
 *                                               the status of tasks assigned to them; the sprint only
 *                                               to bring a backlog task assigned to them into the
 *                                               active sprint
 *                                    and for everyone: a task is marked done only from In review,
 *                                    by a lead or the person who reported it (nobody approves work
 *                                    they were only assigned)
 *                                    every change is recorded in the activity, and a new assignee is
 *                                    notified in the app
 *                                    dates (startDate, dueDate) and the task it follows
 *                                    (dependsOnTaskId: on this board, never in a loop) are edited
 *                                    like the other fields
 *                                    moving a task to In review submits it: review SUBMITTED, and the
 *                                    leads are notified (the assignee is free to start what follows);
 *                                    a lead moving it on to Done approves it
 *   reviewTask(scope, ...)           leads, on a task in review: APPROVE marks it Done quietly;
 *                                    REQUEST_CHANGES (with a note) sends it back to In progress and
 *                                    tells the assignee
 *   addComment(scope, ...)           anyone on the board
 *   getTeamWork(scope, filters)      leads: each person's tasks by status and story points; for a
 *                                    sprint, its burndown; and the unassigned backlog
 */

import { HTTP_STATUS } from '../../constants/httpStatus.js';
import { NOTIFICATION_MESSAGES } from '../../constants/messages.js';
import { TASK_SETTINGS } from '../../constants/validation.js';
import DepartmentBoard from '../../models/DepartmentBoard.js';
import { NOTIFICATION_TYPES } from '../../models/Notification.js';
import Sprint, { SPRINT_STATUSES } from '../../models/Sprint.js';
import Task, { TASK_REVIEW_STATES, TASK_STATUSES } from '../../models/Task.js';
import TaskActivity, { TASK_ACTIVITY_TYPES } from '../../models/TaskActivity.js';
import { notifyUsers } from '../notifications.js';
import { assertCurrentVersion, saveVersioned } from '../serviceError.js';
import { boardRefusal, isLead, requireLead } from './boardAccess.js';
import { peopleByIds } from './boardService.js';
import { findSprint, toSprintSummary } from './sprintService.js';
import { sprintBurndown, unassignedBacklog } from './teamWorkInsights.js';

/**
 * The page of the web app a task notification links to. The frontend's route must match
 * (frontend/src/constants/routes.js, the department board).
 */
export const TASK_APP_PATHS = Object.freeze({
  task: (departmentId, taskId) => `/boards/${departmentId}?task=${taskId}`,
});

export const BACKLOG = 'backlog';
/** A lead's decision on a task in review (POST /tasks/:taskId/review). */
export const TASK_REVIEW_DECISIONS = Object.freeze({ APPROVE: 'APPROVE', REQUEST_CHANGES: 'REQUEST_CHANGES' });
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
  'startDate',
  'dueDate',
  'dependsOnTaskId',
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
    startDate: task.startDate ?? null,
    dueDate: task.dueDate ?? null,
    dependsOnTaskId: idOrNull(task.dependsOnTaskId),
    review: task.review
      ? {
          state: task.review.state,
          submittedBy: person(task.review.submittedByUserId),
          submittedAt: task.review.submittedAt,
          decidedBy: person(task.review.decidedByUserId),
          decidedAt: task.review.decidedAt ?? null,
          note: task.review.note ?? null,
        }
      : null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    version: task.__v,
  };
}

/** The people a task names: assignee, reporter, and whoever submitted and decided its review. */
const peopleOf = (task) => [
  task.assigneeId,
  task.reporterId,
  task.review?.submittedByUserId,
  task.review?.decidedByUserId,
];

async function summarize(tasks, options) {
  const people = await peopleByIds(tasks.flatMap(peopleOf).filter(Boolean));
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
  const [dependsOn, followedBy] = await Promise.all([
    task.dependsOnTaskId
      ? Task.findOne({ _id: task.dependsOnTaskId, departmentId: department._id })
          .select('key title status assigneeId dueDate')
          .lean()
      : null,
    Task.find({ departmentId: department._id, dependsOnTaskId: task._id })
      .select('key title status assigneeId dueDate')
      .sort({ number: 1 })
      .limit(TASK_SETTINGS.DEPENDENCY_CHAIN_MAX)
      .lean(),
  ]);
  const people = await peopleByIds([
    ...peopleOf(task).filter(Boolean),
    ...[dependsOn, ...followedBy].filter(Boolean).map((linked) => linked.assigneeId),
    ...activity.map((entry) => entry.actorId),
    ...activity.flatMap((entry) =>
      (entry.changes ?? [])
        .filter((change) => change.field === 'assigneeId')
        .flatMap((change) => [change.from, change.to]),
    ),
  ]);
  const linkedSummary = (linked) => ({
    id: linked._id.toString(),
    key: linked.key,
    title: linked.title,
    status: linked.status,
    dueDate: linked.dueDate ?? null,
    assignee: linked.assigneeId ? (people.get(linked.assigneeId.toString()) ?? null) : null,
  });
  return {
    task: toTaskSummary(task, people, { withDescription: true }),
    dependsOn: dependsOn ? linkedSummary(dependsOn) : null,
    followedBy: followedBy.map(linkedSummary),
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

/**
 * Refuses a "follows" link to a task that is not on this board, or one that would make a loop (the
 * chain of tasks it follows reaching back to this task). `taskId` is null for a new task.
 */
async function requireDependency(department, dependsOnTaskId, taskId) {
  if (dependsOnTaskId === null || dependsOnTaskId === undefined) return;
  if (taskId && dependsOnTaskId === taskId) throw boardRefusal(HTTP_STATUS.CONFLICT, 'TASK_DEPENDENCY_LOOP');
  const findLink = (id) => Task.findOne({ _id: id, departmentId: department._id }).select('dependsOnTaskId').lean();
  let current = await findLink(dependsOnTaskId);
  if (!current) throw boardRefusal(HTTP_STATUS.UNPROCESSABLE_CONTENT, 'TASK_DEPENDENCY_NOT_FOUND');
  for (let step = 0; step < TASK_SETTINGS.DEPENDENCY_CHAIN_MAX; step += 1) {
    if (!current.dependsOnTaskId) return;
    if (taskId && current.dependsOnTaskId.toString() === taskId) {
      throw boardRefusal(HTTP_STATUS.CONFLICT, 'TASK_DEPENDENCY_LOOP');
    }
    current = await findLink(current.dependsOnTaskId);
    if (!current) return;
  }
  // A chain this long is far more likely a loop through old data than real planning.
  throw boardRefusal(HTTP_STATUS.CONFLICT, 'TASK_DEPENDENCY_LOOP');
}

/** The board's leads who are still in the department: its head and the task leads the head named. */
function leadUserIdsOf(scope) {
  const named = scope.board.leadUserIds.map((userId) => userId.toString()).filter((id) => scope.memberUserIds.has(id));
  return [...new Set([scope.headUserId, ...named].filter(Boolean))];
}

async function notifyReviewRequested(scope, task, actor) {
  const recipients = leadUserIdsOf(scope).filter((userId) => userId !== actor.id);
  if (recipients.length === 0) return;
  const departmentId = scope.department._id.toString();
  await notifyUsers(recipients, () => ({
    type: NOTIFICATION_TYPES.TASK_REVIEW_REQUESTED,
    title: NOTIFICATION_MESSAGES.TASK_REVIEW_REQUESTED_TITLE(task.key),
    body: NOTIFICATION_MESSAGES.TASK_REVIEW_REQUESTED_BODY(actor.name, task.title),
    link: TASK_APP_PATHS.task(departmentId, task._id.toString()),
    data: { departmentId, taskId: task._id.toString(), taskKey: task.key },
  }));
}

async function notifyChangesRequested(scope, task, note, actor) {
  const assigneeId = idOrNull(task.assigneeId);
  if (!assigneeId || assigneeId === actor.id) return;
  const departmentId = scope.department._id.toString();
  await notifyUsers([assigneeId], () => ({
    type: NOTIFICATION_TYPES.TASK_CHANGES_REQUESTED,
    title: NOTIFICATION_MESSAGES.TASK_CHANGES_REQUESTED_TITLE(task.key),
    body: NOTIFICATION_MESSAGES.TASK_CHANGES_REQUESTED_BODY(actor.name, task.title, note),
    link: TASK_APP_PATHS.task(departmentId, task._id.toString()),
    data: { departmentId, taskId: task._id.toString(), taskKey: task.key },
  }));
}

/** A fresh submission: waiting for a lead. */
const submittedReview = (actorId, now) => ({
  state: TASK_REVIEW_STATES.SUBMITTED,
  submittedByUserId: actorId,
  submittedAt: now,
  decidedByUserId: null,
  decidedAt: null,
  note: null,
});

/** The review after a lead's decision (a task in review from before reviews existed gets one). */
function decidedReview(task, { state, actorId, note, now }) {
  const current = task.review?.toObject?.() ?? task.review ?? null;
  return {
    state,
    submittedByUserId: current?.submittedByUserId ?? task.assigneeId ?? actorId,
    submittedAt: current?.submittedAt ?? now,
    decidedByUserId: actorId,
    decidedAt: now,
    note: note ?? null,
  };
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
 *   storyPoints: number|null, sprintId: string|null, startDate?: string|null, dueDate?: string|null,
 *   dependsOnTaskId?: string|null }} input
 * @param {{ id: string, name: string }} actor
 */
export async function createTask(scope, input, actor) {
  const { department } = scope;
  const sprintId = input.sprintId ?? null;
  if (sprintId !== null && !isLead(scope)) throw boardRefusal(HTTP_STATUS.FORBIDDEN, 'TASK_SPRINT_NOT_ALLOWED');
  await requirePlannableSprint(department, sprintId);
  requireMember(scope, input.assigneeId ?? null);
  await requireDependency(department, input.dependsOnTaskId ?? null, null);

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
    startDate: input.startDate ?? null,
    dueDate: input.dueDate ?? null,
    dependsOnTaskId: input.dependsOnTaskId ?? null,
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

/** The active sprint's id in the department, or null. */
async function activeSprintIdOf(department) {
  const active = await Sprint.findOne({ departmentId: department._id, status: SPRINT_STATUSES.ACTIVE })
    .select('_id')
    .lean();
  return idOrNull(active?._id);
}

/** Refuses the changes this person may not make (see the module comment). */
async function checkChangeRights(scope, task, changes, actorUserId) {
  const lead = isLead(scope);
  const isAssignee = idOrNull(task.assigneeId) === actorUserId;
  const isReporter = idOrNull(task.reporterId) === actorUserId;
  const movesStatus = changes.status !== undefined && changes.status !== task.status;
  if (movesStatus && changes.status === TASK_STATUSES.DONE) {
    if (task.status !== TASK_STATUSES.IN_REVIEW) throw boardRefusal(HTTP_STATUS.CONFLICT, 'TASK_DONE_NEEDS_REVIEW');
    if (!lead && !isReporter) throw boardRefusal(HTTP_STATUS.FORBIDDEN, 'TASK_DONE_NOT_ALLOWED');
  }
  if (lead) return;
  if (changes.sprintId !== undefined && comparable(changes.sprintId) !== comparable(task.sprintId)) {
    const pullsOwnBacklogTask =
      isAssignee &&
      task.sprintId === null &&
      changes.sprintId !== null &&
      changes.sprintId === (await activeSprintIdOf(scope.department));
    if (!pullsOwnBacklogTask) throw boardRefusal(HTTP_STATUS.FORBIDDEN, 'TASK_SPRINT_NOT_ALLOWED');
  }
  const marksReportedTaskDone = isReporter && changes.status === TASK_STATUSES.DONE;
  if (movesStatus && !isAssignee && !marksReportedTaskDone) {
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
  await checkChangeRights(scope, task, changes, actor.id);
  if (changes.assigneeId !== undefined) requireMember(scope, changes.assigneeId);
  if (changes.sprintId !== undefined) await requirePlannableSprint(department, changes.sprintId);
  if (changes.dependsOnTaskId !== undefined) {
    await requireDependency(department, changes.dependsOnTaskId, task._id.toString());
  }

  const before = task.toObject();
  for (const [field, value] of Object.entries(changes)) task.set(field, value);
  // Submitting for review, and approving by moving the task on to Done (see reviewTask too).
  const now = new Date();
  const submits = task.status === TASK_STATUSES.IN_REVIEW && before.status !== TASK_STATUSES.IN_REVIEW;
  if (submits) task.review = submittedReview(actor.id, now);
  if (task.status === TASK_STATUSES.DONE && before.status === TASK_STATUSES.IN_REVIEW) {
    task.review = decidedReview(task, { state: TASK_REVIEW_STATES.APPROVED, actorId: actor.id, now });
  }
  // Taken back out of review without a decision: no longer waiting for one (the activity keeps it).
  const withdrawn =
    before.status === TASK_STATUSES.IN_REVIEW &&
    (task.status === TASK_STATUSES.TODO || task.status === TASK_STATUSES.IN_PROGRESS) &&
    before.review?.state === TASK_REVIEW_STATES.SUBMITTED;
  if (withdrawn) task.review = null;
  const movedColumn =
    (changes.status !== undefined && changes.status !== before.status) ||
    (changes.sprintId !== undefined && comparable(changes.sprintId) !== comparable(before.sprintId));
  if (movedColumn && changes.orderIndex === undefined) {
    task.orderIndex = await bottomOrder(department._id, task.sprintId, task.status);
  }
  if (task.status === TASK_STATUSES.DONE && before.status !== TASK_STATUSES.DONE) task.doneAt = now;
  if (task.status !== TASK_STATUSES.DONE) task.doneAt = null;

  const recorded = Object.keys(changes)
    .filter((field) => field !== 'orderIndex' && comparable(before[field]) !== comparable(task.get(field)))
    .map((field) =>
      TEXT_FIELDS.has(field)
        ? { field, from: null, to: null }
        : { field, from: comparable(before[field]), to: comparable(task.get(field)) },
    );
  const reviewChange = reviewChangeOf(before, task);
  if (reviewChange) recorded.push(reviewChange);
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
  if (submits) await notifyReviewRequested(scope, task, actor);
  return (await getTask(scope, task._id)).task;
}

/** The review state change for the activity, or null when it did not change. */
function reviewChangeOf(before, task) {
  const from = before.review?.state ?? null;
  const to = task.review?.state ?? null;
  const resubmitted = from === to && to === TASK_REVIEW_STATES.SUBMITTED && before.status !== task.status;
  return from !== to || resubmitted ? { field: 'review', from, to } : null;
}

/**
 * A lead's decision on a task in review. APPROVE marks it Done without interrupting anyone;
 * REQUEST_CHANGES (a note is required, see validators/taskValidators.js) sends it back to In progress
 * and notifies the assignee.
 * @param {{ decision: string, note: string|null, version: number }} input
 * @param {{ id: string, name: string }} actor
 */
export async function reviewTask(scope, taskId, { decision, note, version }, actor) {
  requireLead(scope);
  const { department } = scope;
  const task = await findTask(department, taskId);
  assertCurrentVersion(task, version);
  if (task.status !== TASK_STATUSES.IN_REVIEW) throw boardRefusal(HTTP_STATUS.CONFLICT, 'TASK_NOT_IN_REVIEW');

  const before = task.toObject();
  const now = new Date();
  const approves = decision === TASK_REVIEW_DECISIONS.APPROVE;
  task.status = approves ? TASK_STATUSES.DONE : TASK_STATUSES.IN_PROGRESS;
  task.doneAt = approves ? now : null;
  task.orderIndex = await bottomOrder(department._id, task.sprintId, task.status);
  task.review = decidedReview(task, {
    state: approves ? TASK_REVIEW_STATES.APPROVED : TASK_REVIEW_STATES.CHANGES_REQUESTED,
    actorId: actor.id,
    note,
    now,
  });
  await saveVersioned(task);
  await TaskActivity.create({
    taskId: task._id,
    departmentId: department._id,
    actorId: actor.id,
    type: TASK_ACTIVITY_TYPES.UPDATED,
    changes: [
      { field: 'status', from: before.status, to: task.status },
      { field: 'review', from: before.review?.state ?? null, to: task.review.state },
    ],
    ...(note ? { body: note } : {}),
  });
  if (!approves) await notifyChangesRequested(scope, task, note, actor);
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
  const sprint = sprintId && sprintId !== BACKLOG ? await findSprint(department, sprintId, { lean: true }) : null;
  if (sprintId === BACKLOG) match.sprintId = null;
  else if (sprint) match.sprintId = sprint._id;
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
  const backlog = await unassignedBacklog(department);
  return {
    members: [...members, ...formerMembers],
    unassigned: byPerson.get(null) ?? zero(),
    totals,
    sprint: sprint ? { ...toSprintSummary(sprint), burndown: await sprintBurndown(sprint) } : null,
    unassignedBacklog: { total: backlog.total, tasks: await summarize(backlog.tasks) },
  };
}
