/**
 * Task: one piece of a department's work, on its board.
 *
 *   key           "<department code>-<number>" (ENG-12), unique and never reused (DepartmentBoard.taskCounter)
 *   sprintId      the sprint it is planned in, or null for the backlog
 *   taskType      TASK, BUG or STORY
 *   status        TODO -> IN_PROGRESS -> IN_REVIEW -> DONE (any move is allowed; doneAt records when it
 *                 last reached DONE)
 *   priority      LOW, MEDIUM, HIGH or URGENT
 *   assigneeId    the account it is assigned to (someone in the department), or null
 *   reporterId    who created it
 *   storyPoints   an estimate (0..TASK_SETTINGS.STORY_POINTS_MAX), or null
 *   orderIndex    its place in its column: lower first. New tasks go to the bottom; a move between
 *                 two tasks takes an order in between (TASK_SETTINGS.ORDER_GAP leaves room)
 *   startDate, dueDate  calendar dates (YYYY-MM-DD) in the company's time zone, or null; the due date
 *                 is on or after the start. Tasks from before these existed keep null, so they are
 *                 never reported overdue
 *   dependsOnTaskId  the task this one follows (same department), or null. Only this direction is
 *                 stored; the tasks that follow one are found by looking it up. Loops are refused by
 *                 services/tasks/taskService.js
 *   review        the review of the work, set when the task enters In review:
 *                   SUBMITTED          waiting for a lead (the assignee moves on to what follows)
 *                   APPROVED           a lead accepted it; the task is Done
 *                   CHANGES_REQUESTED  a lead sent it back to In progress, with a note
 *                 null until the task is first submitted
 *
 * Its history and comments are in TaskActivity. Every change is versioned (optimisticConcurrency).
 */

import mongoose from 'mongoose';
import { TASK_SETTINGS } from '../constants/validation.js';
import { isRealCalendarDate } from '../utils/calendarDates.js';

const { ObjectId } = mongoose.Schema.Types;

export const TASK_TYPES = Object.freeze({ TASK: 'TASK', BUG: 'BUG', STORY: 'STORY' });
export const TASK_STATUSES = Object.freeze({
  TODO: 'TODO',
  IN_PROGRESS: 'IN_PROGRESS',
  IN_REVIEW: 'IN_REVIEW',
  DONE: 'DONE',
});
export const TASK_PRIORITIES = Object.freeze({ LOW: 'LOW', MEDIUM: 'MEDIUM', HIGH: 'HIGH', URGENT: 'URGENT' });
export const TASK_REVIEW_STATES = Object.freeze({
  SUBMITTED: 'SUBMITTED',
  APPROVED: 'APPROVED',
  CHANGES_REQUESTED: 'CHANGES_REQUESTED',
});

const calendarDateOrNull = {
  type: String,
  default: null,
  validate: {
    validator: (value) => value === null || isRealCalendarDate(value),
    message: '{PATH} must be a date (YYYY-MM-DD)',
  },
};

const reviewSchema = new mongoose.Schema(
  {
    state: { type: String, enum: Object.values(TASK_REVIEW_STATES), required: true },
    // ──► User._id: who submitted the work, and when.
    submittedByUserId: { type: ObjectId, ref: 'User', required: true },
    submittedAt: { type: Date, required: true },
    // ──► User._id: the lead who decided, and when (null while it waits).
    decidedByUserId: { type: ObjectId, ref: 'User', default: null },
    decidedAt: { type: Date, default: null },
    // The lead's note: required when asking for changes, optional on approval.
    note: { type: String, trim: true, default: null, maxlength: TASK_SETTINGS.REVIEW_NOTE_MAX_LENGTH },
  },
  { _id: false },
);

const taskSchema = new mongoose.Schema(
  {
    departmentId: { type: ObjectId, ref: 'Department', required: true, immutable: true },
    number: { type: Number, required: true, min: 1, immutable: true },
    key: { type: String, required: true, immutable: true },
    sprintId: { type: ObjectId, ref: 'Sprint', default: null },
    title: { type: String, required: true, trim: true, minlength: 1, maxlength: TASK_SETTINGS.TITLE_MAX_LENGTH },
    description: { type: String, trim: true, default: '', maxlength: TASK_SETTINGS.DESCRIPTION_MAX_LENGTH },
    taskType: { type: String, enum: Object.values(TASK_TYPES), default: TASK_TYPES.TASK, required: true },
    status: { type: String, enum: Object.values(TASK_STATUSES), default: TASK_STATUSES.TODO, required: true },
    priority: {
      type: String,
      enum: Object.values(TASK_PRIORITIES),
      default: TASK_PRIORITIES.MEDIUM,
      required: true,
    },
    assigneeId: { type: ObjectId, ref: 'User', default: null },
    reporterId: { type: ObjectId, ref: 'User', required: true, immutable: true },
    storyPoints: {
      type: Number,
      default: null,
      min: 0,
      max: TASK_SETTINGS.STORY_POINTS_MAX,
      validate: {
        validator: (points) => points === null || Number.isInteger(points),
        message: 'Story points must be a whole number',
      },
    },
    orderIndex: { type: Number, required: true },
    doneAt: { type: Date, default: null },
    startDate: calendarDateOrNull,
    dueDate: calendarDateOrNull,
    // ──► Task._id (same department): the task this one follows.
    dependsOnTaskId: { type: ObjectId, ref: 'Task', default: null },
    review: { type: reviewSchema, default: null },
  },
  { timestamps: true, optimisticConcurrency: true },
);

taskSchema.pre('validate', function checkDates() {
  if (this.startDate && this.dueDate && this.dueDate < this.startDate) {
    this.invalidate('dueDate', 'The due date cannot be before the start date');
  }
  if (this.dependsOnTaskId && this._id && this.dependsOnTaskId.equals(this._id)) {
    this.invalidate('dependsOnTaskId', 'A task cannot follow itself');
  }
});

taskSchema.index({ departmentId: 1, number: 1 }, { unique: true });
// The board: a sprint's (or the backlog's) columns in order.
taskSchema.index({ departmentId: 1, sprintId: 1, status: 1, orderIndex: 1 });
// "My tasks", and a lead's view by person.
taskSchema.index({ departmentId: 1, assigneeId: 1, status: 1 });
// A person's open work by due date, across boards (the daily briefing: overdue and due today).
taskSchema.index({ assigneeId: 1, status: 1, dueDate: 1 });
// The tasks that follow one (what comes next once it is submitted).
taskSchema.index({ departmentId: 1, dependsOnTaskId: 1 });

export default mongoose.model('Task', taskSchema);
