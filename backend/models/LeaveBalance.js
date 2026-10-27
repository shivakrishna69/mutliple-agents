/**
 * LeaveBalance: the running total of one employee's ledger (models/LeaveLedgerEntry.js) for one
 * leave type and leave year, so balances are read without summing the ledger each time.
 *
 *   balanceCentidays   sum of the applied entries' balance deltas
 *   heldCentidays      sum of the applied entries' held deltas (reserved by pending requests)
 *   available          balance - held (what a new request or debit may use)
 *
 * It is only ever changed by single atomic updates in services/leaveLedger.js. `appliedEntries`
 * records each ledger entry already counted, with its amounts:
 *   - applying an entry is idempotent: a retry can never count the same entry twice;
 *   - a debit is reserved here first (conditionally, so two requests at once cannot overdraw) and
 *     written to the ledger second; if the server stops in between, the reconciliation job finds
 *     the applied entry with no ledger record and reverses it using the stored amounts.
 */

import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

const appliedEntrySchema = new mongoose.Schema(
  {
    entryId: { type: ObjectId, required: true },
    balanceDeltaCentidays: { type: Number, required: true },
    heldDeltaCentidays: { type: Number, required: true },
    appliedAt: { type: Date, required: true },
  },
  { _id: false },
);

const leaveBalanceSchema = new mongoose.Schema(
  {
    employeeId: { type: ObjectId, ref: 'EmployeeProfile', required: true, immutable: true },
    leaveTypeId: { type: ObjectId, ref: 'LeaveType', required: true, immutable: true },
    leaveYear: { type: Number, required: true, immutable: true },
    balanceCentidays: { type: Number, default: 0 },
    heldCentidays: { type: Number, default: 0 },
    appliedEntries: { type: [appliedEntrySchema], default: [], select: false },
  },
  { timestamps: true },
);

leaveBalanceSchema.index({ employeeId: 1, leaveTypeId: 1, leaveYear: 1 }, { unique: true });

export default mongoose.model('LeaveBalance', leaveBalanceSchema);
