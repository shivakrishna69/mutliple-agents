/**
 * How department task boards are shown. Values mirror the backend's (backend/models/Task.js,
 * Sprint.js, services/tasks/taskService.js); the backend's texts (errors, notifications) are shown as
 * it sends them.
 */

export const TASK_STATUSES = Object.freeze({
  TODO: 'TODO',
  IN_PROGRESS: 'IN_PROGRESS',
  IN_REVIEW: 'IN_REVIEW',
  DONE: 'DONE',
});

/** The board's columns, in order. */
export const BOARD_COLUMNS = Object.freeze([
  { status: TASK_STATUSES.TODO, label: 'To do' },
  { status: TASK_STATUSES.IN_PROGRESS, label: 'In progress' },
  { status: TASK_STATUSES.IN_REVIEW, label: 'In review' },
  { status: TASK_STATUSES.DONE, label: 'Done' },
]);
export const STATUS_LABELS = Object.freeze(
  Object.fromEntries(BOARD_COLUMNS.map((column) => [column.status, column.label])),
);

export const TASK_TYPE_OPTIONS = Object.freeze([
  { value: 'TASK', label: 'Task', tone: 'sky' },
  { value: 'BUG', label: 'Bug', tone: 'rose' },
  { value: 'STORY', label: 'Story', tone: 'emerald' },
]);
export const PRIORITY_OPTIONS = Object.freeze([
  { value: 'LOW', label: 'Low', tone: 'slate' },
  { value: 'MEDIUM', label: 'Medium', tone: 'sky' },
  { value: 'HIGH', label: 'High', tone: 'amber' },
  { value: 'URGENT', label: 'Urgent', tone: 'rose' },
]);
export const DEFAULT_TASK_TYPE = 'TASK';
export const DEFAULT_PRIORITY = 'MEDIUM';

export const SPRINT_STATUSES = Object.freeze({ PLANNING: 'PLANNING', ACTIVE: 'ACTIVE', COMPLETED: 'COMPLETED' });
export const SPRINT_STATUS_DISPLAY = Object.freeze({
  PLANNING: { label: 'Planning', tone: 'sky' },
  ACTIVE: { label: 'Active', tone: 'emerald' },
  COMPLETED: { label: 'Completed', tone: 'slate' },
});

/** The backend's names for the backlog and the assignee filters (services/tasks/taskService.js). */
export const BACKLOG = 'backlog';
export const ASSIGNEE_FILTERS = Object.freeze({ ALL: '', ME: 'me', UNASSIGNED: 'unassigned' });

/** Fields named in a task's activity, as people read them. */
export const ACTIVITY_FIELD_LABELS = Object.freeze({
  title: 'title',
  description: 'description',
  taskType: 'type',
  priority: 'priority',
  status: 'status',
  assigneeId: 'assignee',
  storyPoints: 'story points',
  sprintId: 'sprint',
});

/** Space between neighbouring tasks in a column (backend TASK_SETTINGS.ORDER_GAP). */
export const ORDER_GAP = 1024;
/** Limits the backend applies (TASK_SETTINGS), so the forms can say so before sending. */
export const TASK_LIMITS = Object.freeze({
  TITLE: 200,
  DESCRIPTION: 10_000,
  COMMENT: 5_000,
  STORY_POINTS: 100,
  LEADS: 20,
});
