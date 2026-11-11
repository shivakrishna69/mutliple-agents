/**
 * Task board rules the browser applies before asking the backend, which decides again on every change
 * (backend/services/tasks/taskService.js):
 *
 *   leads      move and change any task, plan sprints, take work out of a sprint
 *   assignee   moves their task between the sprint's columns (up to In review), changes it, and brings
 *              it from the backlog into the active sprint
 *   reporter   changes the task, and marks it done once it is in review
 *   Done       only from In review, by a lead or the task's reporter
 */

import { ORDER_GAP, TASK_STATUSES } from '../constants/tasks.js';

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
