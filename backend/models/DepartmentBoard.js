/**
 * DepartmentBoard: a department's task board settings, created the first time anyone opens the board.
 *
 *   departmentId   the department (1:1, never changes)
 *   leadUserIds    the people the department's head named as task leads (accounts of people in the
 *                  department). With the head, they plan sprints, move any task and see the team's
 *                  work (services/tasks/boardAccess.js)
 *   taskCounter    the last task number issued; task keys are "<department code>-<number>" (ENG-12).
 *                  Taken with one atomic $inc, so two tasks never share a number, and a number is
 *                  never reused
 */

import mongoose from 'mongoose';
import { TASK_SETTINGS } from '../constants/validation.js';

const { ObjectId } = mongoose.Schema.Types;

const departmentBoardSchema = new mongoose.Schema(
  {
    departmentId: { type: ObjectId, ref: 'Department', required: true, immutable: true },
    leadUserIds: {
      type: [{ type: ObjectId, ref: 'User' }],
      default: [],
      validate: {
        validator: (leads) => leads.length <= TASK_SETTINGS.LEADS_MAX,
        message: `A board has at most ${TASK_SETTINGS.LEADS_MAX} task leads`,
      },
    },
    taskCounter: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true, optimisticConcurrency: true },
);

departmentBoardSchema.index({ departmentId: 1 }, { unique: true });

export default mongoose.model('DepartmentBoard', departmentBoardSchema);
