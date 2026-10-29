/**
 * LeaveEmployeeLock: a short lease on one employee's leave, held while an operation reads or
 * changes border (sandwich) charges between their requests: approving, cancelling, deciding a
 * change, and the repair pass. With it, two neighbouring leaves approved at the same moment are
 * priced one after the other, so the second sees the first as approved and charges the gap.
 *
 * One document per employee; the unique index makes taking the lease atomic across servers. A
 * lease left behind by a stopped server expires on its own (services/leaveEmployeeLock.js).
 */

import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

const leaveEmployeeLockSchema = new mongoose.Schema(
  {
    employeeId: { type: ObjectId, ref: 'EmployeeProfile', required: true, immutable: true },
    // Who holds the lease now (a random id per operation), or null when it is free.
    holder: { type: String, default: null },
    expiresAt: { type: Date, default: null },
  },
  { timestamps: true },
);

leaveEmployeeLockSchema.index({ employeeId: 1 }, { unique: true, name: 'one_lock_per_employee' });

export default mongoose.model('LeaveEmployeeLock', leaveEmployeeLockSchema);
