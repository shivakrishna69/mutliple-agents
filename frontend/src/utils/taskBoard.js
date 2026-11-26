/**
 * Task board rules the browser applies before asking the backend, which decides again on every change
 * (backend/services/tasks/taskService.js):
 *
 *   leads      move and change any task, plan sprints, take work out of a sprint
 *   assignee   moves their task between the sprint's columns (up to In review), changes it, and brings
 *              it from the backlog into the active sprint
 *   reporter   changes the task, and marks it done once it is in review
 *   Done       only from In review, by a lead or the task's reporter
 *   review     a lead approves a task in review (Done) or asks for changes with a note (In progress)
 *   follows    a task may follow another task on the same board (dependsOnTaskId), never itself and
 *              never in a loop
 */

import { DUE_STATES, ORDER_GAP, TASK_REVIEW_STATES, TASK_STATUSES } from '../constants/tasks.js';

/**
 * Overdue (due before today) or due today, for an open task; null otherwise. Dates are YYYY-MM-DD,
 * and `today` is the company's (the board's `today`), so the comparison is plain text order.
 */
export function dueStateOf(task, today) {
  if (!today || !task.dueDate || task.status === TASK_STATUSES.DONE) return null;
  if (task.dueDate < today) return DUE_STATES.OVERDUE;
  if (task.dueDate === today) return DUE_STATES.DUE_TODAY;
  return null;
}

/** Whether the viewer decides on this task's review: leads, while it is in review. */
export const canReviewTask = (task, viewer) =>
  Boolean(viewer.canMoveAnyTask) && task.status === TASK_STATUSES.IN_REVIEW;

/** The lead's request for changes on a task sent back to In progress, or null. */
export const revisionOf = (task) =>
  task.status === TASK_STATUSES.IN_PROGRESS && task.review?.state === TASK_REVIEW_STATES.CHANGES_REQUESTED
    ? task.review
    : null;

/**
 * The board's tasks a task may follow: all but itself and those that already follow it, directly or
 * down a chain (choosing one would make a loop). `taskId` null: a new task, which may follow any.
 * Ordered by key number (ENG-2 before ENG-10).
 */
export function followableTasks(tasks, taskId) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const leadsBackTo = (candidate) => {
    const seen = new Set();
    for (let current = candidate; current && !seen.has(current.id); current = byId.get(current.dependsOnTaskId)) {
      if (current.id === taskId) return true;
      seen.add(current.id);
    }
    return false;
  };
  return tasks
    .filter((task) => !taskId || !leadsBackTo(task))
    .sort((first, second) => first.key.localeCompare(second.key, undefined, { numeric: true }));
}

/**
 * What the viewer may do with a task.
 * @param {string|null} activeSprintId  the department's active sprint, if any
 */
export function taskRightsOf(task, viewer, currentUserId, activeSprintId = null) {
  const isLead = Boolean(viewer.canMoveAnyTask);
  const isAssignee = task.assignee?.id === currentUserId;
  const isReporter = task.reporter?.id === currentUserId;
  return {
    canMove: isLead || isAssignee,
    canMarkDone: task.status === TASK_STATUSES.IN_REVIEW && (isLead || isReporter),
    canEdit: isLead || isAssignee || isReporter,
    canPlan: Boolean(viewer.canPlanSprints),
    canPullIntoSprint:
      Boolean(activeSprintId) && task.sprintId === null && (Boolean(viewer.canPlanSprints) || isAssignee),
  };
}

/** The statuses the viewer may choose for a task, besides the one it has. */
export function allowedStatusesOf(task, rights) {
  return Object.values(TASK_STATUSES).filter((status) => {
    if (status === task.status) return true;
    if (status === TASK_STATUSES.DONE) return rights.canMarkDone;
    return rights.canMove;
  });
}

const inActiveSprint = (task, activeSprintId) => activeSprintId !== null && task.sprintId === activeSprintId;

/**
 * Whether a dragged task may be dropped where it is aimed:
 *   { status }     a column of the active sprint (from the backlog: only To do)
 *   { sprintId }   the backlog (null) or a sprint being planned: leads only
 */
export function canDropTask(task, target, rights, activeSprintId) {
  if (target.status === undefined) return rights.canPlan && target.sprintId !== task.sprintId;
  if (!inActiveSprint(task, activeSprintId)) {
    return (
      activeSprintId !== null && target.status === TASK_STATUSES.TODO && (rights.canPlan || rights.canPullIntoSprint)
    );
  }
  if (target.status === task.status) return rights.canEdit;
  return allowedStatusesOf(task, rights).includes(target.status);
}

/** Whether the task can be dragged anywhere at all. */
export function canDragTask(task, rights, activeSprintId) {
  if (!inActiveSprint(task, activeSprintId)) return rights.canPlan || rights.canPullIntoSprint;
  return rights.canPlan || rights.canMove || rights.canMarkDone || rights.canEdit;
}

/**
 * The order that puts a task just above `beforeTask` in a column, or at its bottom when there is none:
 * between its neighbours, so nothing else is renumbered.
 * @param {object[]} columnTasks  the column's other tasks, in order
 */
export function orderFor(columnTasks, beforeTask) {
  if (!beforeTask) return (columnTasks.at(-1)?.orderIndex ?? 0) + ORDER_GAP;
  const index = columnTasks.findIndex((task) => task.id === beforeTask.id);
  const previous = index > 0 ? columnTasks[index - 1] : null;
  return previous ? (previous.orderIndex + beforeTask.orderIndex) / 2 : beforeTask.orderIndex - ORDER_GAP;
}
