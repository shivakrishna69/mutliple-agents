/**
 * LeaveLedgerEntry: one movement of leave, never changed once written. The ledger is the source of
 * truth; models/LeaveBalance.js is a running total of it that services/leaveLedger.js keeps and can
 * rebuild.
 *
 * Each entry carries two signed amounts, in centidays (hundredths of a day):
 *   balanceDeltaCentidays   change to the balance (credits positive, debits negative)
 *   heldDeltaCentidays      change to the days held for pending requests
 * so any balance is the sum of its entries' deltas.
 *
 *   ACCRUAL         monthly / upfront / joiner credit          balance +, accrualPeriod "YYYY-MM"
 *   HOLD            a request was submitted (Phase 3)           held +
 *   CONFIRM_DEBIT   the request was approved; closes its hold   balance -, held -
 *   RELEASE_HOLD    the request was rejected or cancelled       held -
 *   ENCASHMENT      days paid out by payroll                    balance -, payrollReference, payrollMonth
 *   ADJUSTMENT      everything else, with a reasonCode:          balance +/-
 *                     MANUAL (HR, with a note), CARRY_FORWARD, LAPSE, ENTITLEMENT_GRANT,
 *                     CANCELLATION_CREDIT
 *
 * Uniqueness, enforced by the database so nothing is ever posted twice (a retry, a second server,
 * a job that runs again):
 *   ACCRUAL      (employeeId, leaveTypeId, accrualPeriod)
 *   ENCASHMENT   (employeeId, leaveTypeId, payrollReference)
 *   year end     (employeeId, leaveTypeId, leaveYear, yearEndKind)
 */

import mongoose from 'mongoose';
import { LEAVE_LIMITS } from '../constants/validation.js';
import { isRealCalendarDate } from '../utils/calendarDates.js';

const { ObjectId } = mongoose.Schema.Types;

export const LEDGER_ENTRY_TYPES = Object.freeze({
  ACCRUAL: 'ACCRUAL',
  HOLD: 'HOLD',
  CONFIRM_DEBIT: 'CONFIRM_DEBIT',
  RELEASE_HOLD: 'RELEASE_HOLD',
  ENCASHMENT: 'ENCASHMENT',
  ADJUSTMENT: 'ADJUSTMENT',
});

export const ADJUSTMENT_REASON_CODES = Object.freeze({
  MANUAL: 'MANUAL',
  CARRY_FORWARD: 'CARRY_FORWARD',
  LAPSE: 'LAPSE',
  ENTITLEMENT_GRANT: 'ENTITLEMENT_GRANT',
  CANCELLATION_CREDIT: 'CANCELLATION_CREDIT',
});

/** The year-end movements; each is posted at most once per employee, type and leave year. */
export const YEAR_END_KINDS = Object.freeze({
  CARRY_FORWARD_OUT: 'CARRY_FORWARD_OUT',
  CARRY_FORWARD_IN: 'CARRY_FORWARD_IN',
  LAPSE: 'LAPSE',
  ENCASHMENT: 'ENCASHMENT',
});

const MONTH_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])$/;
const isWholeNumber = (value) => Number.isInteger(value);

const leaveLedgerEntrySchema = new mongoose.Schema(
  {
    employeeId: { type: ObjectId, ref: 'EmployeeProfile', required: true, immutable: true },
    leaveTypeId: { type: ObjectId, ref: 'LeaveType', required: true, immutable: true },
    leaveYear: {
      type: Number,
      required: true,
      immutable: true,
      min: LEAVE_LIMITS.EARLIEST_LEAVE_YEAR,
      max: LEAVE_LIMITS.LATEST_LEAVE_YEAR,
    },
    entryType: { type: String, enum: Object.values(LEDGER_ENTRY_TYPES), required: true, immutable: true },
    reasonCode: { type: String, enum: [...Object.values(ADJUSTMENT_REASON_CODES), null], default: null, immutable: true },
    balanceDeltaCentidays: { type: Number, required: true, immutable: true, validate: isWholeNumber },
    heldDeltaCentidays: { type: Number, default: 0, immutable: true, validate: isWholeNumber },
    // The day the movement takes effect (credit date, encashment date, year-end date).
    effectiveDate: { type: String, required: true, immutable: true, validate: isRealCalendarDate },
    accrualPeriod: { type: String, default: null, immutable: true, match: MONTH_PATTERN },
    payrollReference: {
      type: String,
      default: null,
      immutable: true,
      match: LEAVE_LIMITS.PAYROLL_REFERENCE_PATTERN,
    },
    payrollMonth: { type: String, default: null, immutable: true, match: MONTH_PATTERN },
    yearEndKind: { type: String, enum: [...Object.values(YEAR_END_KINDS), null], default: null, immutable: true },
    note: { type: String, trim: true, maxlength: LEAVE_LIMITS.NOTE_MAX_LENGTH, default: null, immutable: true },
    // null = posted by the system (accrual job, year end).
    createdByUserId: { type: ObjectId, ref: 'User', default: null, immutable: true },
    // The leave request a HOLD / CONFIRM_DEBIT / RELEASE_HOLD / CANCELLATION_CREDIT belongs to (Phase 3).
    leaveRequestId: { type: ObjectId, default: null, immutable: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

/** What each entry type must carry, so a malformed entry can never reach the ledger. */
leaveLedgerEntrySchema.pre('validate', function enforceEntryShape() {
  const { entryType, balanceDeltaCentidays: balanceDelta, heldDeltaCentidays: heldDelta } = this;
  const fail = (path, message) => this.invalidate(path, message);
  if ((entryType === LEDGER_ENTRY_TYPES.ADJUSTMENT) !== Boolean(this.reasonCode)) {
    fail('reasonCode', 'reasonCode is required for, and only for, ADJUSTMENT entries');
  }
  switch (entryType) {
    case LEDGER_ENTRY_TYPES.ACCRUAL:
      if (!(balanceDelta > 0) || heldDelta !== 0) fail('balanceDeltaCentidays', 'An accrual is a credit');
      if (!this.accrualPeriod) fail('accrualPeriod', 'An accrual needs its period (YYYY-MM)');
      break;
    case LEDGER_ENTRY_TYPES.HOLD:
      if (balanceDelta !== 0 || !(heldDelta > 0)) fail('heldDeltaCentidays', 'A hold only reserves days');
      break;
    case LEDGER_ENTRY_TYPES.RELEASE_HOLD:
      if (balanceDelta !== 0 || !(heldDelta < 0)) fail('heldDeltaCentidays', 'A release only frees reserved days');
      break;
    case LEDGER_ENTRY_TYPES.CONFIRM_DEBIT:
      if (!(balanceDelta < 0) || !(heldDelta < 0)) fail('balanceDeltaCentidays', 'A confirmed debit uses its hold');
      break;
    case LEDGER_ENTRY_TYPES.ENCASHMENT:
      if (!(balanceDelta < 0) || heldDelta !== 0) fail('balanceDeltaCentidays', 'An encashment is a debit');
      if (!this.payrollReference || !this.payrollMonth) {
        fail('payrollReference', 'An encashment needs a payroll reference and payroll month');
      }
      break;
    case LEDGER_ENTRY_TYPES.ADJUSTMENT:
      if (balanceDelta === 0 || heldDelta !== 0) fail('balanceDeltaCentidays', 'An adjustment changes the balance');
      break;
    default:
      break;
  }
});

leaveLedgerEntrySchema.index(
  { employeeId: 1, leaveTypeId: 1, accrualPeriod: 1 },
  {
    unique: true,
    partialFilterExpression: { entryType: LEDGER_ENTRY_TYPES.ACCRUAL },
    name: 'unique_accrual_per_month',
  },
);
leaveLedgerEntrySchema.index(
  { employeeId: 1, leaveTypeId: 1, payrollReference: 1 },
  {
    unique: true,
    partialFilterExpression: { entryType: LEDGER_ENTRY_TYPES.ENCASHMENT },
    name: 'unique_encashment_per_payroll_reference',
  },
);
leaveLedgerEntrySchema.index(
  { employeeId: 1, leaveTypeId: 1, leaveYear: 1, yearEndKind: 1 },
  {
    unique: true,
    partialFilterExpression: { yearEndKind: { $type: 'string' } },
    name: 'unique_year_end_movement',
  },
);
// History and balance rebuilds: one employee's entries for a leave year, oldest first.
leaveLedgerEntrySchema.index({ employeeId: 1, leaveYear: 1, leaveTypeId: 1, createdAt: 1 });

export default mongoose.model('LeaveLedgerEntry', leaveLedgerEntrySchema);
