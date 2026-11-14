/**
 * OffboardingCase: one person leaving the company, from HR's first preview of the full and final
 * settlement to the generated documents (services/nskBot/offboarding/).
 *
 *   DRAFT ──preview again──► DRAFT            (HR adjusts the figures; nothing has happened yet)
 *     │  └──cancel──► CANCELLED
 *     └──execute──► QUEUED ──► GENERATING ──► COMPLETED
 *                                   └───────► FAILED ──execute again──► QUEUED
 *
 * Executing is one conditional update (status still DRAFT at the version HR reviewed), so two people
 * pressing "start" cannot both start it. It moves the employee to Notice (their account stays
 * active until IT revokes it on the last working day) and queues the documents.
 *
 *   employeeSnapshot   the person as the documents print them, taken at the preview
 *   separation         resignation (or notice) date, last working day, kind and reason
 *   adjustments        what HR changed in the preview (null: the figure found below is used)
 *   prefill            what the system found: the salary and where it came from (latest issued
 *                      payslip, else the accepted offer), the notice period, encashable leave, the tax
 *                      paid so far this financial year
 *   settlement         utils/payroll/finalSettlement.js's result for prefill + adjustments, and
 *                      settlementHash, its SHA-256: execute recomputes it and refuses when it differs
 *                      (a payslip issued since, say), so nobody starts on figures they did not see
 *   artifacts          the generated documents in S3 (storage.s3Key is select:false and never
 *                      leaves the server); downloads go through GET /api/nsk-bot/artifacts/:id/download
 *   progress, lease    the background job's steps, and the worker holding it (claimed like the
 *                      employee import: an atomic update with a lease)
 *
 * One open case per employee: isActive is true until a case is cancelled, and a partial unique index
 * allows one active case per employee.
 */

import mongoose from 'mongoose';
import { CALENDAR_DATE_PATTERN } from '../constants/validation.js';
import { EMPLOYMENT_STATUSES } from './EmployeeProfile.js';

const { ObjectId } = mongoose.Schema.Types;

export const OFFBOARDING_STATUSES = Object.freeze({
  DRAFT: 'DRAFT',
  QUEUED: 'QUEUED',
  GENERATING: 'GENERATING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
});

/** Statuses after execute: the person is serving notice. */
export const EXECUTED_STATUSES = Object.freeze([
  OFFBOARDING_STATUSES.QUEUED,
  OFFBOARDING_STATUSES.GENERATING,
  OFFBOARDING_STATUSES.COMPLETED,
  OFFBOARDING_STATUSES.FAILED,
]);

export const SEPARATION_KINDS = Object.freeze({
  RESIGNATION: 'RESIGNATION',
  TERMINATION: 'TERMINATION',
  CONTRACT_END: 'CONTRACT_END',
  RETIREMENT: 'RETIREMENT',
});

/** The documents an executed case produces, in the order they are generated. */
export const ARTIFACT_KINDS = Object.freeze({
  RELIEVING_LETTER: 'RELIEVING_LETTER',
  SETTLEMENT_STATEMENT: 'SETTLEMENT_STATEMENT',
  ATTENDANCE_AUDIT: 'ATTENDANCE_AUDIT',
});

export const SALARY_SOURCES = Object.freeze({ PAYSLIP: 'payslip', OFFER: 'offer', NONE: 'none' });

const calendarDate = (required = true) => ({ type: String, required, match: CALENDAR_DATE_PATTERN });

const settlementLineSchema = new mongoose.Schema(
  {
    label: { type: String, required: true, trim: true, maxlength: 80 },
    amount: { type: Number, required: true, min: 0 },
    taxable: { type: Boolean, default: true },
  },
  { _id: false },
);

const artifactSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: Object.values(ARTIFACT_KINDS), required: true },
    fileName: { type: String, required: true, maxlength: 200 },
    contentType: { type: String, required: true, maxlength: 120 },
    sizeBytes: { type: Number, required: true, min: 1 },
    sha256: { type: String, required: true, match: /^[0-9a-f]{64}$/ },
    s3Key: { type: String, required: true, select: false },
    generatedAt: { type: Date, required: true },
  },
  { _id: true },
);

const offboardingCaseSchema = new mongoose.Schema(
  {
    employeeId: { type: ObjectId, ref: 'EmployeeProfile', required: true, immutable: true },
    employeeUserId: { type: ObjectId, ref: 'User', required: true, immutable: true },
    isActive: { type: Boolean, default: true },
    status: {
      type: String,
      enum: Object.values(OFFBOARDING_STATUSES),
      default: OFFBOARDING_STATUSES.DRAFT,
      required: true,
    },
    employeeSnapshot: {
      name: { type: String, required: true, maxlength: 100 },
      employeeCode: { type: String, required: true, maxlength: 40 },
      designation: { type: String, required: true, maxlength: 120 },
      departmentName: { type: String, default: null, maxlength: 120 },
      officeName: { type: String, default: null, maxlength: 120 },
      dateOfJoining: calendarDate(),
      employmentType: { type: String, required: true },
    },
    separation: {
      kind: { type: String, enum: Object.values(SEPARATION_KINDS), required: true },
      noticeDate: calendarDate(),
      lastWorkingDay: calendarDate(),
      reason: { type: String, trim: true, maxlength: 300, default: null },
    },
    adjustments: {
      monthlyGross: { type: Number, min: 0, default: null },
      monthlyBasic: { type: Number, min: 0, default: null },
      salaryDays: { type: Number, min: 0, max: 31, default: null },
      encashableDays: { type: Number, min: 0, default: null },
      noticeShortfallDays: { type: Number, min: 0, default: null },
      noticeRecoveryWaived: { type: Boolean, default: false },
      isFixedTerm: { type: Boolean, default: false },
      tdsOverride: { type: Number, min: 0, default: null },
      otherEarnings: { type: [settlementLineSchema], default: [] },
      otherDeductions: { type: [settlementLineSchema], default: [] },
    },
    prefill: { type: mongoose.Schema.Types.Mixed, required: true },
    settlement: { type: mongoose.Schema.Types.Mixed, required: true },
    settlementHash: { type: String, required: true, match: /^[0-9a-f]{64}$/ },
    settlementDueDate: calendarDate(),
    previousEmploymentStatus: { type: String, enum: [...Object.values(EMPLOYMENT_STATUSES), null], default: null },
    artifacts: { type: [artifactSchema], default: [] },
    progress: {
      completedSteps: { type: Number, default: 0, min: 0 },
      totalSteps: { type: Number, default: Object.keys(ARTIFACT_KINDS).length },
      currentStep: { type: String, enum: [...Object.values(ARTIFACT_KINDS), null], default: null },
    },
    lease: {
      owner: { type: String, default: null },
      until: { type: Date, default: null },
    },
    attempts: { type: Number, default: 0, min: 0 },
    lastErrorCode: { type: String, default: null, maxlength: 80 },
    createdByUserId: { type: ObjectId, ref: 'User', required: true, immutable: true },
    updatedByUserId: { type: ObjectId, ref: 'User', default: null },
    executedByUserId: { type: ObjectId, ref: 'User', default: null },
    executedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    optimisticConcurrency: true,
    toJSON: {
      transform(doc, ret) {
        for (const artifact of ret.artifacts ?? []) delete artifact.s3Key;
        delete ret.lease;
        delete ret.__v;
        return ret;
      },
    },
  },
);

// One active case per employee.
offboardingCaseSchema.index(
  { employeeId: 1 },
  { unique: true, partialFilterExpression: { isActive: true }, name: 'one_active_case_per_employee' },
);
// The job sweep: queued cases, and generating ones whose lease ran out.
offboardingCaseSchema.index({ status: 1, 'lease.until': 1 });
// Listings by status, newest first.
offboardingCaseSchema.index({ status: 1, updatedAt: -1 });
// Downloads find the case by an artifact's id.
offboardingCaseSchema.index({ 'artifacts._id': 1 });

export default mongoose.model('OffboardingCase', offboardingCaseSchema);
