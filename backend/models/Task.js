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
 *
 * Its history and comments are in TaskActivity. Every change is versioned (optimisticConcurrency).
 */

import mongoose from 'mongoose';
import { TASK_SETTINGS } from '../constants/validation.js';

const { ObjectId } = mongoose.Schema.Types;

export const TASK_TYPES = Object.freeze({ TASK: 'TASK', BUG: 'BUG', STORY: 'STORY' });
export const TASK_STATUSES = Object.freeze({
  TODO: 'TODO',
  IN_PROGRESS: 'IN_PROGRESS',
  IN_REVIEW: 'IN_REVIEW',
  DONE: 'DONE',
});
export const TASK_PRIORITIES = Object.freeze({ LOW: 'LOW', MEDIUM: 'MEDIUM', HIGH: 'HIGH', URGENT: 'URGENT' });

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
  },
  { timestamps: true, optimisticConcurrency: true },
);

taskSchema.index({ departmentId: 1, number: 1 }, { unique: true });
// The board: a sprint's (or the backlog's) columns in order.
taskSchema.index({ departmentId: 1, sprintId: 1, status: 1, orderIndex: 1 });
// "My tasks", and a lead's view by person.
taskSchema.index({ departmentId: 1, assigneeId: 1, status: 1 });

export default mongoose.model('Task', taskSchema);
