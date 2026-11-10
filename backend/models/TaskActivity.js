/**
 * TaskActivity: a task's history and comments, oldest first.
 *
 *   type      CREATED    the task was created
 *             UPDATED    fields changed: changes = [{ field, from, to }] (status, assignee, sprint,
 *                        priority, ... ; text fields are named without their before and after)
 *             COMMENTED  someone wrote a comment (body)
 *   actorId   who did it
 *
 * Kept as long as the task; never edited.
 */

import mongoose from 'mongoose';
import { TASK_SETTINGS } from '../constants/validation.js';

const { ObjectId } = mongoose.Schema.Types;

export const TASK_ACTIVITY_TYPES = Object.freeze({ CREATED: 'CREATED', UPDATED: 'UPDATED', COMMENTED: 'COMMENTED' });

const changeSchema = new mongoose.Schema(
  {
    field: { type: String, required: true },
    from: { type: mongoose.Schema.Types.Mixed, default: null },
    to: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { _id: false },
);

const taskActivitySchema = new mongoose.Schema(
  {
    taskId: { type: ObjectId, ref: 'Task', required: true, immutable: true },
    departmentId: { type: ObjectId, ref: 'Department', required: true, immutable: true },
    actorId: { type: ObjectId, ref: 'User', required: true, immutable: true },
    type: { type: String, enum: Object.values(TASK_ACTIVITY_TYPES), required: true, immutable: true },
    changes: { type: [changeSchema], default: [], immutable: true },
    body: { type: String, default: null, maxlength: TASK_SETTINGS.COMMENT_MAX_LENGTH, immutable: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

taskActivitySchema.index({ taskId: 1, createdAt: 1 });

export default mongoose.model('TaskActivity', taskActivitySchema);
