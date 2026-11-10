/**
 * Task board rules the browser applies before asking the backend, which decides again on every change
 * (backend/services/tasks/taskService.js).
 */

import { ORDER_GAP } from '../constants/tasks.js';

/** What the viewer may do with a task. */
export function taskRightsOf(task, viewer, currentUserId) {
  const isAssignee = task.assignee?.id === currentUserId;
  const isReporter = task.reporter?.id === currentUserId;
  return {
    canMove: viewer.canMoveAnyTask || isAssignee,
    canEdit: viewer.canMoveAnyTask || isAssignee || isReporter,
    canPlan: viewer.canPlanSprints,
  };
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
