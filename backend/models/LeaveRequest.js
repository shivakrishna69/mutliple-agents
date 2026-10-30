/**
 * LeaveRequest: one employee's request for leave of one type over a date range, and what happened
 * to it. Days are priced by services/workingDays.js under the employee's office calendar; amounts
 * are in centidays (hundredths of a day), like the ledger.
 *
 *   PENDING ──approve──► APPROVED ──cancel (before it starts)───────────► CANCELLED
 *      │                     └──change request (once started): cancel or shorten, decided by the
 *      │                        approver or HR; shortening keeps it APPROVED with a later end date
 *      ├──reject───► REJECTED
 *      └──withdraw─► CANCELLED
 *
 * Approval steps (approvalSteps), fixed when submitted: the reporting manager, then HR when the
 * leave is longer than the type's usage.hrApprovalAfterDays; HR only for an employee without a
 * manager. The request stays PENDING, its days held, until the last step approves; a rejection at
 * any step ends it. `awaitingLevel` names the step it waits on, for the approval queues. Requests
 * submitted before steps existed have none and are decided in one step, as they were.
 *
 * Ledger (services/leaveLedger.js), for types that keep a balance:
 *   submit HOLD (+held) · approve CONFIRM_DEBIT (closes the hold) · reject / withdraw RELEASE_HOLD
 *   · cancel / shorten CANCELLATION_CREDIT. Loss of Pay keeps no balance and posts nothing.
 *
 * The days a request occupies are claimed in models/LeaveDayClaim.js, whose unique index stops two
 * requests from covering the same half day, even when they arrive at the same moment.
 *
 * Without multi-document transactions, every change after submission runs under `processing`, a
 * lock taken by one atomic update: it records the ledger movement to post and the fields to set,
 * so services/leaveRequestSettlement.js can finish (or, for an approval whose debit was never
 * posted, undo) an operation the server stopped in the middle of.
 */

import mongoose from 'mongoose';
import { LEAVE_LIMITS } from '../constants/validation.js';
import { DAY_PORTIONS } from '../constants/calendarDays.js';
import { isRealCalendarDate } from '../utils/calendarDates.js';

const { ObjectId } = mongoose.Schema.Types;

export const LEAVE_REQUEST_STATUSES = Object.freeze({
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  CANCELLED: 'CANCELLED',
});

export const CHANGE_REQUEST_KINDS = Object.freeze({ CANCEL: 'CANCEL', SHORTEN: 'SHORTEN' });

/** What an approver works through: pending requests, or approved leave with a change waiting. */
export const APPROVAL_QUEUES = Object.freeze({ REQUESTS: 'requests', CHANGES: 'changes' });

/** Who decides an approval step: the reporting manager, or HR (any HR user or administrator). */
export const APPROVAL_LEVELS = Object.freeze({ MANAGER: 'MANAGER', HR: 'HR' });

export const APPROVAL_STEP_STATUSES = Object.freeze({
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
});

const calendarDateField = (required = true) => ({
  type: String,
  required,
  default: required ? undefined : null,
  validate: { validator: (value) => value === null || isRealCalendarDate(value), message: '{PATH} must be YYYY-MM-DD' },
});
const textField = ({ required }) => ({
  type: String,
  trim: true,
  required,
  default: required ? undefined : null,
  minlength: LEAVE_LIMITS.NOTE_MIN_LENGTH,
  maxlength: LEAVE_LIMITS.NOTE_MAX_LENGTH,
});

/** One day of the priced range, as charged. */
const pricedDaySchema = new mongoose.Schema(
  {
    date: { type: String, required: true },
    kind: { type: String, required: true },
    holidayName: { type: String, default: null },
    chargedCentidays: { type: Number, required: true },
  },
  { _id: false },
);

/**
 * A non-working day just outside the range, charged under the sandwich rule because approved leave
 * of `neighbourRequestId` borders it on the other side. Credited back if that leave is cancelled.
 */
const borderChargeSchema = new mongoose.Schema(
  {
    date: { type: String, required: true },
    chargedCentidays: { type: Number, required: true },
    neighbourRequestId: { type: ObjectId, required: true },
  },
  { _id: false },
);

const decisionSchema = new mongoose.Schema(
  {
    byUserId: { type: ObjectId, ref: 'User', required: true },
    note: textField({ required: false }),
    at: { type: Date, required: true },
  },
  { _id: false },
);

const changeRequestSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: Object.values(CHANGE_REQUEST_KINDS), required: true },
    // SHORTEN only: the new last day and its portion.
    newEndDate: calendarDateField(false),
    newEndDayPortion: { type: String, enum: [...Object.values(DAY_PORTIONS), null], default: null },
    reason: textField({ required: true }),
    requestedByUserId: { type: ObjectId, ref: 'User', required: true },
    requestedAt: { type: Date, required: true },
  },
  { _id: false },
);

/** One approval step and, once taken, its decision. */
const approvalStepSchema = new mongoose.Schema(
  {
    level: { type: String, enum: Object.values(APPROVAL_LEVELS), required: true },
    status: {
      type: String,
      enum: Object.values(APPROVAL_STEP_STATUSES),
      default: APPROVAL_STEP_STATUSES.PENDING,
    },
    decision: { type: decisionSchema, default: null },
  },
  { _id: false },
);

/** A change request once decided, kept for the record. */
const decidedChangeSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: Object.values(CHANGE_REQUEST_KINDS), required: true },
    newEndDate: { type: String, default: null },
    newEndDayPortion: { type: String, default: null },
    reason: { type: String, required: true },
    requestedByUserId: { type: ObjectId, ref: 'User', required: true },
    requestedAt: { type: Date, required: true },
    isApproved: { type: Boolean, required: true },
    decision: { type: decisionSchema, required: true },
    creditedCentidays: { type: Number, default: 0 },
  },
  { _id: false },
);

/**
 * An operation in progress. `posting` is the ledger movement it makes (null for none) and
 * `result` the fields it sets once that is posted; both are plain data, so the repair job can
 * complete the operation exactly as the request would have.
 */
const processingSchema = new mongoose.Schema(
  {
    lockId: { type: String, required: true },
    operation: { type: String, required: true },
    startedAt: { type: Date, required: true },
    posting: { type: mongoose.Schema.Types.Mixed, default: null },
    result: { type: mongoose.Schema.Types.Mixed, required: true },
  },
  { _id: false },
);

const leaveRequestSchema = new mongoose.Schema(
  {
    employeeId: { type: ObjectId, ref: 'EmployeeProfile', required: true, immutable: true },
    leaveTypeId: { type: ObjectId, ref: 'LeaveType', required: true, immutable: true },
    leaveYear: { type: Number, required: true, immutable: true },
    // The office whose calendar priced the request.
    officeLocationId: { type: ObjectId, ref: 'OfficeLocation', required: true, immutable: true },
    startDate: { ...calendarDateField(), immutable: true },
    startDayPortion: { type: String, enum: Object.values(DAY_PORTIONS), default: DAY_PORTIONS.FULL, immutable: true },
    endDate: calendarDateField(),
    endDayPortion: { type: String, enum: Object.values(DAY_PORTIONS), default: DAY_PORTIONS.FULL },
    days: { type: [pricedDaySchema], default: [] },
    borderCharges: { type: [borderChargeSchema], default: [] },
    // What the request costs now: its days plus border charges (what is held, then debited).
    chargedCentidays: { type: Number, required: true, min: 0 },
    // Whether the type keeps a balance (Loss of Pay does not), fixed when submitted.
    tracksBalance: { type: Boolean, required: true, immutable: true },
    // What was reserved at submission (0 for a type without a balance); approval or release closes it.
    holdCentidays: { type: Number, required: true, min: 0, immutable: true },
    reason: textField({ required: true }),
    // One of the employee's own document-vault files (e.g. a medical certificate).
    attachmentDocumentId: { type: ObjectId, ref: 'DocumentVault', default: null },
    status: {
      type: String,
      enum: Object.values(LEAVE_REQUEST_STATUSES),
      default: LEAVE_REQUEST_STATUSES.PENDING,
    },
    // The reporting manager when submitted; null sends the request to HR's queue only.
    approverEmployeeId: { type: ObjectId, ref: 'EmployeeProfile', default: null, immutable: true },
    submittedByUserId: { type: ObjectId, ref: 'User', required: true, immutable: true },
    decision: { type: decisionSchema, default: null },
    approvalSteps: { type: [approvalStepSchema], default: [] },
    // The level of the first step still pending while the request is PENDING; null otherwise.
    awaitingLevel: { type: String, enum: [...Object.values(APPROVAL_LEVELS), null], default: null },
    cancellation: { type: decisionSchema, default: null },
    pendingChange: { type: changeRequestSchema, default: null },
    changeHistory: { type: [decidedChangeSchema], default: [] },
    processing: { type: processingSchema, default: null },
    // Set when the request gave days up (closed or shortened) until their claims are deleted.
    hasClaimsToRelease: { type: Boolean, default: false },
  },
  { timestamps: true, optimisticConcurrency: true },
);

leaveRequestSchema.pre('validate', function enforceRange() {
  if (this.endDate && this.startDate && this.endDate < this.startDate) {
    this.invalidate('endDate', 'The leave cannot end before it starts');
  }
  if (this.pendingChange?.kind === CHANGE_REQUEST_KINDS.SHORTEN && !this.pendingChange.newEndDate) {
    this.invalidate('pendingChange.newEndDate', 'Shortening needs the new last day');
  }
});

// The employee's own requests, newest first; overlap and neighbour lookups by date.
leaveRequestSchema.index({ employeeId: 1, startDate: -1 });
// Approval queues: a manager's pending requests, and HR's.
leaveRequestSchema.index({ approverEmployeeId: 1, status: 1, createdAt: 1 });
leaveRequestSchema.index({ status: 1, createdAt: 1 });
// Neighbours whose border charges depend on a request.
leaveRequestSchema.index({ 'borderCharges.neighbourRequestId': 1 });
// The repair job: operations left unfinished, and claims left to delete.
leaveRequestSchema.index(
  { 'processing.startedAt': 1 },
  { partialFilterExpression: { 'processing.startedAt': { $type: 'date' } } },
);
leaveRequestSchema.index({ updatedAt: 1 }, { partialFilterExpression: { hasClaimsToRelease: true } });

export default mongoose.model('LeaveRequest', leaveRequestSchema);
