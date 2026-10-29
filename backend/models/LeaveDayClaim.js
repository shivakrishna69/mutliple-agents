/**
 * LeaveDayClaim: one half day of an employee's calendar taken by an open leave request (pending or
 * approved). The unique index makes overlapping requests impossible, even when two are submitted
 * at the same moment on different servers: the second one's claim fails and it is refused.
 * Claims are released when a request is rejected, withdrawn, cancelled or shortened.
 *
 * Every calendar day in a request's range is claimed, working or not, so two requests never
 * share a weekend between them; a half-day edge claims only its half.
 */

import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

export const DAY_HALVES = Object.freeze({ FIRST: 'FIRST', SECOND: 'SECOND' });

const leaveDayClaimSchema = new mongoose.Schema(
  {
    employeeId: { type: ObjectId, ref: 'EmployeeProfile', required: true, immutable: true },
    date: { type: String, required: true, immutable: true },
    half: { type: String, enum: Object.values(DAY_HALVES), required: true, immutable: true },
    leaveRequestId: { type: ObjectId, ref: 'LeaveRequest', required: true, immutable: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

leaveDayClaimSchema.index({ employeeId: 1, date: 1, half: 1 }, { unique: true, name: 'one_request_per_half_day' });
leaveDayClaimSchema.index({ leaveRequestId: 1 });

export default mongoose.model('LeaveDayClaim', leaveDayClaimSchema);
