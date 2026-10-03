/**
 * RegularizationReview model: an attendance regularization request the AI agent could not approve
 * on its own, waiting for (or decided by) a person.
 *
 * Relationship vectors
 * --------------------
 *   RegularizationReview.employeeId          ──► EmployeeProfile._id  (whose attendance it is)
 *   RegularizationReview.requestedByUserId   ──► User._id             (that employee's account)
 *   RegularizationReview.reportingManagerId  ──► EmployeeProfile._id  (the reviewer, copied from the
 *                                                                     profile when the review is filed;
 *                                                                     null when none is on file, in
 *                                                                     which case HR and admins decide)
 *   RegularizationReview.decision.attendanceId ──► Attendance._id    (the entry an approval created)
 *
 * Lifecycle
 * ---------
 *   Pending ──approve──► Approved   an Attendance entry (entrySource "regularization", method
 *                                   "manager_approved") is written for `date` at the approved time
 *   Pending ──reject───► Rejected
 *   Decisions are final. They go through save() with optimistic concurrency, so two reviewers
 *   deciding at once produce one decision and one conflict.
 *
 * Idempotency
 * -----------
 *   The agent files a review with an `idempotencyKey` (its conversation thread, the date, and the day
 *   the request started). The key is unique: a retried submission returns the stored review instead
 *   of creating a second one.
 */

import mongoose from 'mongoose';
import { LOCAL_TIME_PATTERN } from '../constants/validation.js';
import { isRealCalendarDate } from './Attendance.js';

const { ObjectId } = mongoose.Schema.Types;

export const REVIEW_STATUSES = Object.freeze({
  PENDING: 'Pending',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
});

/** Why the agent sent the request to a person; mirrors ai-service ManagerRoutingReason. */
export const REVIEW_ROUTING_REASONS = Object.freeze([
  'no_activity_proof',
  'outside_regularization_window',
  'clarification_limit_reached',
  'request_not_understood',
  'activity_systems_unavailable',
  'approval_rejected',
  'approval_system_unavailable',
]);

const reviewDecisionSchema = new mongoose.Schema(
  {
    // ──► User._id of the reviewer.
    decidedByUserId: { type: ObjectId, ref: 'User', required: true },
    decidedAt: { type: Date, required: true },
    note: { type: String, trim: true, maxlength: 500, default: null },
    // Approvals only: the punch-in time the reviewer accepted, local "HH:MM", and the entry written.
    approvedPunchInTime: { type: String, match: [LOCAL_TIME_PATTERN, 'approvedPunchInTime must be HH:MM'], default: null },
    attendanceId: { type: ObjectId, ref: 'Attendance', default: null },
  },
  { _id: false },
);

const regularizationReviewSchema = new mongoose.Schema(
  {
    employeeId: { type: ObjectId, ref: 'EmployeeProfile', required: true, immutable: true },
    requestedByUserId: { type: ObjectId, ref: 'User', required: true, immutable: true },
    reportingManagerId: { type: ObjectId, ref: 'EmployeeProfile', default: null, immutable: true },
    // The day to regularize, or null when the agent could not establish it.
    date: {
      type: String,
      default: null,
      immutable: true,
      validate: { validator: (calendarDate) => calendarDate === null || isRealCalendarDate(calendarDate), message: 'date must be YYYY-MM-DD' },
    },
    claimedPunchInTime: { type: String, match: [LOCAL_TIME_PATTERN, 'claimedPunchInTime must be HH:MM'], default: null, immutable: true },
    reason: { type: String, trim: true, maxlength: 300, default: null, immutable: true },
    routingReason: { type: String, enum: { values: REVIEW_ROUTING_REASONS, message: 'routingReason "{VALUE}" is not valid' }, required: true, immutable: true },
    qualifyingEventCount: { type: Number, min: 0, default: 0, immutable: true },
    // The employee's punch-in geofence radius when the review was filed, for the reviewer's context.
    allowedGeofenceRadius: { type: Number, min: 0, default: null, immutable: true },
    idempotencyKey: { type: String, required: true, maxlength: 300, unique: true, immutable: true },
    status: {
      type: String,
      enum: { values: Object.values(REVIEW_STATUSES), message: 'status "{VALUE}" is not valid' },
      default: REVIEW_STATUSES.PENDING,
      required: true,
    },
    decision: { type: reviewDecisionSchema, default: null },
  },
  { timestamps: true, optimisticConcurrency: true },
);

// A manager's queue: their pending reviews, oldest first.
regularizationReviewSchema.index({ reportingManagerId: 1, status: 1, createdAt: 1 });
// HR/admin queue across all managers.
regularizationReviewSchema.index({ status: 1, createdAt: 1 });
// One employee's history for a day.
regularizationReviewSchema.index({ employeeId: 1, date: 1 });

regularizationReviewSchema.pre('validate', function enforceDecisionConsistency() {
  const isDecided = this.status !== REVIEW_STATUSES.PENDING;
  if (isDecided !== Boolean(this.decision)) {
    this.invalidate('decision', 'A decided review must record its decision, and a pending one must not');
  }
  if (this.status === REVIEW_STATUSES.APPROVED && (!this.decision?.approvedPunchInTime || !this.decision?.attendanceId)) {
    this.invalidate('decision', 'An approved review must record the approved punch-in time and the attendance entry');
  }
});

const RegularizationReview = mongoose.model('RegularizationReview', regularizationReviewSchema);

export default RegularizationReview;
