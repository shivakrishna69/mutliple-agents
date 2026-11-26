/**
 * Task cards for the daily briefing, across every board the viewer works on. Dates are compared with
 * today in the company's time zone; tasks without dates never count as overdue or due today.
 *
 *   for the person's own open tasks (assigned to them, not Done):
 *     revision     a lead asked for changes (review CHANGES_REQUESTED): urgent, with the lead's note
 *     up next      a To do task whose predecessor (dependsOnTaskId) is in review or done: the work is
 *                  theirs to start now, without waiting for the review. Gone once they start it
 *     overdue      due before today: high
 *     due today    due today, or High/Urgent priority not yet past due: normal
 *   for the boards they lead (department head, named task leads, administrators):
 *     review       a task submitted for review by someone else, with what the submitter moved on to
 *
 * Each kind lists at most INSIGHT_SETTINGS.TASK_CARDS_PER_KIND tasks, the most pressing first; a task
 * appears once, under its most pressing kind.
 */

import { INSIGHT_MESSAGES } from '../../constants/messages.js';
import { INSIGHT_SETTINGS } from '../../constants/validation.js';
import Department from '../../models/Department.js';
import Task, { TASK_PRIORITIES, TASK_REVIEW_STATES, TASK_STATUSES } from '../../models/Task.js';
import User from '../../models/User.js';
import { BOARD_ROLES, listMyBoards } from '../tasks/boardAccess.js';
import { TASK_APP_PATHS } from '../tasks/taskService.js';
import { INSIGHT_ACTIONS, INSIGHT_KINDS, INSIGHT_SEVERITIES, dayMonth } from './insightFormat.js';

const LIMIT = INSIGHT_SETTINGS.TASK_CARDS_PER_KIND;
const OPEN = Object.freeze({ $ne: TASK_STATUSES.DONE });
const PRESSING_PRIORITIES = Object.freeze([TASK_PRIORITIES.HIGH, TASK_PRIORITIES.URGENT]);
const TASK_FIELDS =
  'departmentId key title status priority assigneeId dueDate startDate dependsOnTaskId review updatedAt';

const idOf = (value) => value.toString();
const pathOf = (task) => TASK_APP_PATHS.task(idOf(task.departmentId), idOf(task._id));

async function departmentNamesOf(tasks) {
  const ids = [...new Set(tasks.map((task) => idOf(task.departmentId)))];
  if (ids.length === 0) return new Map();
  const departments = await Department.find({ _id: { $in: ids } })
    .select('name')
    .lean();
  return new Map(departments.map((department) => [idOf(department._id), department.name]));
}

async function namesOf(userIds) {
  const ids = [...new Set(userIds.filter(Boolean).map(idOf))];
  if (ids.length === 0) return new Map();
  const accounts = await User.find({ _id: { $in: ids } })
    .select('name')
    .lean();
  return new Map(accounts.map((account) => [idOf(account._id), account.name]));
}

/** Due date, start and priority lines, and the board. */
function taskFacts(task, departmentNames) {
  return [
    ...(task.dueDate ? [INSIGHT_MESSAGES.taskDue(dayMonth(task.dueDate))] : []),
    ...(task.startDate ? [INSIGHT_MESSAGES.taskStarts(dayMonth(task.startDate))] : []),
    ...(PRESSING_PRIORITIES.includes(task.priority) ? [INSIGHT_MESSAGES.taskPriority(task.priority)] : []),
    INSIGHT_MESSAGES.taskBoard(departmentNames.get(idOf(task.departmentId)) ?? ''),
  ];
}

const viewAction = (task) => ({
  kind: INSIGHT_ACTIONS.OPEN_TASK,
  label: INSIGHT_MESSAGES.ACTIONS.VIEW_TASK,
  path: pathOf(task),
});

/** The person's own tasks: revisions, up next, overdue, due today. */
async function ownTaskCards(viewer, today) {
  const mine = { assigneeId: viewer.id, status: OPEN };
  const [revisions, waitingToStart, overdue, dueToday] = await Promise.all([
    Task.find({ ...mine, status: TASK_STATUSES.IN_PROGRESS, 'review.state': TASK_REVIEW_STATES.CHANGES_REQUESTED })
      .select(TASK_FIELDS)
      .sort({ 'review.decidedAt': 1 })
      .limit(LIMIT)
      .lean(),
    Task.find({ assigneeId: viewer.id, status: TASK_STATUSES.TODO, dependsOnTaskId: { $ne: null } })
      .select(TASK_FIELDS)
      .lean(),
    Task.find({ ...mine, dueDate: { $ne: null, $lt: today } })
      .select(TASK_FIELDS)
      .sort({ dueDate: 1 })
      .limit(LIMIT)
      .lean(),
    Task.find({
      ...mine,
      $or: [
        { dueDate: today },
        { priority: { $in: PRESSING_PRIORITIES }, $or: [{ dueDate: null }, { dueDate: { $gte: today } }] },
      ],
    })
      .select(TASK_FIELDS)
      .sort({ dueDate: 1, priority: -1 })
      .limit(LIMIT * 2)
      .lean(),
  ]);

  // Up next: only those whose predecessor is in review or done.
  const predecessors = await Task.find({
    _id: { $in: waitingToStart.map((task) => task.dependsOnTaskId) },
    status: { $in: [TASK_STATUSES.IN_REVIEW, TASK_STATUSES.DONE] },
  })
    .select('key title status')
    .lean();
  const predecessorById = new Map(predecessors.map((task) => [idOf(task._id), task]));
  const upNext = waitingToStart.filter((task) => predecessorById.has(idOf(task.dependsOnTaskId))).slice(0, LIMIT);

  const shown = new Set();
  const take = (tasks) =>
    tasks.filter((task) => {
      const key = idOf(task._id);
      if (shown.has(key)) return false;
      shown.add(key);
      return true;
    });
  const revisionCards = take(revisions);
  const upNextCards = take(upNext);
  const overdueCards = take(overdue);
  const dueTodayCards = take(dueToday).slice(0, LIMIT);

  const all = [...revisionCards, ...upNextCards, ...overdueCards, ...dueTodayCards];
  const [departmentNames, leadNames] = await Promise.all([
    departmentNamesOf(all),
    namesOf(revisionCards.map((task) => task.review?.decidedByUserId)),
  ]);

  return [
    ...revisionCards.map((task) => ({
      id: `${INSIGHT_KINDS.TASK_REVISION}:${idOf(task._id)}`,
      kind: INSIGHT_KINDS.TASK_REVISION,
      severity: INSIGHT_SEVERITIES.URGENT,
      label: INSIGHT_MESSAGES.LABELS.REVISION,
      title: INSIGHT_MESSAGES.revisionTitle(task.key, task.title),
      body: task.review?.note ?? '',
      facts: [
        INSIGHT_MESSAGES.revisionBy(leadNames.get(idOf(task.review?.decidedByUserId ?? '')) ?? '—'),
        ...taskFacts(task, departmentNames),
      ],
      actions: [viewAction(task)],
      at: task.review?.decidedAt ?? task.updatedAt,
    })),
    ...upNextCards.map((task) => {
      const previous = predecessorById.get(idOf(task.dependsOnTaskId));
      return {
        id: `${INSIGHT_KINDS.TASK_UP_NEXT}:${idOf(task._id)}`,
        kind: INSIGHT_KINDS.TASK_UP_NEXT,
        severity: INSIGHT_SEVERITIES.HIGH,
        label: INSIGHT_MESSAGES.LABELS.UP_NEXT,
        title: INSIGHT_MESSAGES.upNextTitle(task.title),
        body: INSIGHT_MESSAGES.upNextBody(previous.key, previous.title),
        facts: taskFacts(task, departmentNames),
        actions: [viewAction(task)],
        at: task.startDate ?? task.updatedAt,
      };
    }),
    ...overdueCards.map((task) => ({
      id: `${INSIGHT_KINDS.TASK_OVERDUE}:${idOf(task._id)}`,
      kind: INSIGHT_KINDS.TASK_OVERDUE,
      severity: INSIGHT_SEVERITIES.HIGH,
      label: INSIGHT_MESSAGES.LABELS.OVERDUE,
      title: INSIGHT_MESSAGES.overdueTitle(task.key, task.title),
      body: '',
      facts: taskFacts(task, departmentNames),
      actions: [viewAction(task)],
      at: task.dueDate,
    })),
    ...dueTodayCards.map((task) => ({
      id: `${INSIGHT_KINDS.TASK_DUE_TODAY}:${idOf(task._id)}`,
      kind: INSIGHT_KINDS.TASK_DUE_TODAY,
      severity: INSIGHT_SEVERITIES.NORMAL,
      label: INSIGHT_MESSAGES.LABELS.DUE_TODAY,
      title: INSIGHT_MESSAGES.dueTodayTitle(task.key, task.title),
      body: '',
      facts: taskFacts(task, departmentNames),
      actions: [viewAction(task)],
      at: task.dueDate ?? task.updatedAt,
    })),
  ];
}

/** Tasks waiting for the viewer's review, on the boards they lead. */
async function reviewCards(viewer) {
  const boards = await listMyBoards(viewer);
  const ledDepartmentIds = boards
    .filter((board) => board.role === BOARD_ROLES.LEAD)
    .map((board) => board.department.id);
  if (ledDepartmentIds.length === 0) return [];
  const submitted = await Task.find({
    departmentId: { $in: ledDepartmentIds },
    status: TASK_STATUSES.IN_REVIEW,
    'review.state': TASK_REVIEW_STATES.SUBMITTED,
    'review.submittedByUserId': { $ne: viewer.id },
  })
    .select(TASK_FIELDS)
    .sort({ 'review.submittedAt': 1 })
    .limit(LIMIT)
    .lean();
  if (submitted.length === 0) return [];

  // What each submitter moved on to: the open task that follows the submitted one, theirs.
  const followers = await Task.find({
    dependsOnTaskId: { $in: submitted.map((task) => task._id) },
    status: { $in: [TASK_STATUSES.TODO, TASK_STATUSES.IN_PROGRESS] },
  })
    .select('dependsOnTaskId title assigneeId status')
    .lean();
  const [departmentNames, submitterNames] = await Promise.all([
    departmentNamesOf(submitted),
    namesOf(submitted.map((task) => task.review.submittedByUserId)),
  ]);
  return submitted.map((task) => {
    const submitterId = idOf(task.review.submittedByUserId);
    const next =
      followers.find(
        (follower) =>
          idOf(follower.dependsOnTaskId) === idOf(task._id) &&
          follower.assigneeId &&
          idOf(follower.assigneeId) === submitterId,
      ) ?? null;
    return {
      id: `${INSIGHT_KINDS.TASK_REVIEW}:${idOf(task._id)}`,
      kind: INSIGHT_KINDS.TASK_REVIEW,
      severity: INSIGHT_SEVERITIES.HIGH,
      label: INSIGHT_MESSAGES.LABELS.REVIEW,
      title: INSIGHT_MESSAGES.reviewTitle(submitterNames.get(submitterId) ?? '—', task.title),
      body: next ? INSIGHT_MESSAGES.reviewMovedOn(next.title) : '',
      facts: [task.key, ...taskFacts(task, departmentNames)],
      actions: [{ kind: INSIGHT_ACTIONS.REVIEW_TASK, label: INSIGHT_MESSAGES.ACTIONS.REVIEW_TASK, path: pathOf(task) }],
      at: task.review.submittedAt,
    };
  });
}

/**
 * @param {{ id: string, role: string }} viewer
 * @param {{ today: string }} options  today in the company's time zone (YYYY-MM-DD)
 */
export async function buildTaskCards(viewer, { today }) {
  const [own, reviews] = await Promise.all([ownTaskCards(viewer, today), reviewCards(viewer)]);
  return [...own, ...reviews];
}
