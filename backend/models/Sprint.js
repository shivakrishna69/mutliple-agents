/**
 * Sprint: a time box of a department's tasks.
 *
 *   status   PLANNING (being filled) -> ACTIVE (at most one per department at a time) -> COMPLETED.
 *            Completing a sprint moves its unfinished tasks back to the backlog; a completed sprint
 *            takes no more tasks.
 *   startDate, endDate   calendar dates (YYYY-MM-DD); the end is on or after the start, at most
 *            TASK_SETTINGS.SPRINT_MAX_DAYS later
 *
 * Every change is versioned (optimisticConcurrency), so two leads editing at once cannot overwrite
 * each other.
 */

import mongoose from 'mongoose';
import { TASK_SETTINGS } from '../constants/validation.js';
import { isRealCalendarDate } from '../utils/calendarDates.js';

const { ObjectId } = mongoose.Schema.Types;

export const SPRINT_STATUSES = Object.freeze({ PLANNING: 'PLANNING', ACTIVE: 'ACTIVE', COMPLETED: 'COMPLETED' });

const DAY_MS = 24 * 60 * 60 * 1000;
const calendarDate = {
  type: String,
  required: true,
  validate: { validator: isRealCalendarDate, message: '{PATH} must be a real date (YYYY-MM-DD)' },
};

const sprintSchema = new mongoose.Schema(
  {
    departmentId: { type: ObjectId, ref: 'Department', required: true, immutable: true },
    name: { type: String, required: true, trim: true, minlength: 1, maxlength: TASK_SETTINGS.SPRINT_NAME_MAX_LENGTH },
    goal: { type: String, trim: true, default: '', maxlength: TASK_SETTINGS.SPRINT_GOAL_MAX_LENGTH },
    startDate: calendarDate,
    endDate: calendarDate,
    status: {
      type: String,
      enum: Object.values(SPRINT_STATUSES),
      default: SPRINT_STATUSES.PLANNING,
      required: true,
    },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    createdBy: { type: ObjectId, ref: 'User', required: true, immutable: true },
  },
  { timestamps: true, optimisticConcurrency: true },
);

sprintSchema.pre('validate', function checkDates() {
  if (!isRealCalendarDate(this.startDate) || !isRealCalendarDate(this.endDate)) return;
  const lengthDays = (Date.parse(`${this.endDate}T00:00:00Z`) - Date.parse(`${this.startDate}T00:00:00Z`)) / DAY_MS;
  if (lengthDays < 0 || lengthDays > TASK_SETTINGS.SPRINT_MAX_DAYS) {
    this.invalidate('endDate', `The end is on or after the start, at most ${TASK_SETTINGS.SPRINT_MAX_DAYS} days later`);
  }
});

sprintSchema.index({ departmentId: 1, startDate: -1 });
// At most one active sprint per department, even when two leads start one at the same time.
sprintSchema.index(
  { departmentId: 1 },
  { unique: true, partialFilterExpression: { status: SPRINT_STATUSES.ACTIVE }, name: 'one_active_sprint' },
);

export default mongoose.model('Sprint', sprintSchema);
