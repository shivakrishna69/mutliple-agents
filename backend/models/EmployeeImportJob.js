/**
 * EmployeeImportJob: one uploaded employee CSV, checked row by row, then (once HR confirms) turned
 * into invitations in the background (services/employeeImportRunner.js).
 *
 *   validated ──confirm──► queued ──worker──► running ──► completed
 *                                               └──(worker stopped: lease runs out)──► picked up again
 *
 * Every row keeps its input, its issues, and what became of it, so the job can be resumed after a
 * restart without creating anyone twice, and HR gets a result for every row. The state lives here
 * (not in the queue), whichever queue runs the work.
 *
 * Rows that could not be emailed keep their activation link sealed (utils/secretBox.js) until HR
 * collects it. Finished jobs are deleted after EMPLOYEE_IMPORT_LIMITS.RETENTION_DAYS, files that were
 * checked but never started after UNCONFIRMED_RETENTION_DAYS.
 */

import mongoose from 'mongoose';
import { EMPLOYEE_IMPORT_LIMITS } from '../constants/validation.js';

const { ObjectId } = mongoose.Schema.Types;

export const IMPORT_JOB_STATUSES = Object.freeze({
  VALIDATED: 'validated',
  QUEUED: 'queued',
  RUNNING: 'running',
  COMPLETED: 'completed',
});

/**
 *   invalid     has issues; never imported
 *   pending     waiting for the worker
 *   processing  the worker started on it (seen again only after a restart in the middle of it)
 *   created     the person was invited
 *   failed      the invitation was refused when it was made (e.g. someone took the email meanwhile)
 */
export const IMPORT_ROW_STATUSES = Object.freeze({
  INVALID: 'invalid',
  PENDING: 'pending',
  PROCESSING: 'processing',
  CREATED: 'created',
  FAILED: 'failed',
});

const issueSchema = new mongoose.Schema(
  { field: { type: String, required: true }, message: { type: String, required: true } },
  { _id: false },
);

const rowSchema = new mongoose.Schema(
  {
    rowNumber: { type: Number, required: true },
    // The row as checked: trimmed, emails lowercased, codes uppercased, role and statuses mapped.
    input: {
      name: String,
      personalEmail: String,
      companyEmail: { type: String, default: null },
      departmentCode: String,
      designation: String,
      role: String,
      managerEmail: { type: String, default: null },
      dateOfJoining: String,
      workLocationType: String,
      employmentStatus: String,
      officeCode: { type: String, default: null },
      jobLevel: { type: String, default: null },
      employmentType: { type: String, default: null },
    },
    // A manager who already worked here when the file was checked; a manager in the same file is
    // found by `input.managerEmail` when their row is imported.
    existingManagerId: { type: ObjectId, ref: 'EmployeeProfile', default: null },
    issues: { type: [issueSchema], default: [] },
    status: { type: String, enum: Object.values(IMPORT_ROW_STATUSES), required: true },
    employeeCode: { type: String, default: null },
    companyEmail: { type: String, default: null },
    profileId: { type: ObjectId, ref: 'EmployeeProfile', default: null },
    // sent | not_configured | failed (services/mailService.js), once the invitation was made.
    delivery: { type: String, default: null },
    sealedInviteUrl: { type: String, default: null, select: false },
    message: { type: String, default: null },
  },
  { _id: false },
);

const employeeImportJobSchema = new mongoose.Schema(
  {
    status: { type: String, enum: Object.values(IMPORT_JOB_STATUSES), required: true },
    fileName: { type: String, required: true, maxlength: 255 },
    createdBy: {
      userId: { type: ObjectId, ref: 'User', required: true },
      name: { type: String, required: true },
      role: { type: String, required: true },
    },
    // Department codes the file uses that do not exist yet; created when the import runs.
    departmentsToCreate: {
      type: [new mongoose.Schema({ code: String, name: String }, { _id: false })],
      default: [],
    },
    rows: { type: [rowSchema], default: [] },
    counts: {
      total: { type: Number, default: 0 },
      valid: { type: Number, default: 0 },
      invalid: { type: Number, default: 0 },
      created: { type: Number, default: 0 },
      failed: { type: Number, default: 0 },
      emailed: { type: Number, default: 0 },
    },
    // The worker holding the job, and until when (renewed after every row).
    lease: {
      owner: { type: String, default: null },
      until: { type: Date, default: null },
    },
    // How many times a worker has claimed the job; the runner gives up after a few.
    attempts: { type: Number, default: 0 },
    confirmedAt: { type: Date, default: null },
    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// The jobs list, newest first.
employeeImportJobSchema.index({ createdAt: -1 });
// The sweep: queued jobs, and running jobs whose lease ran out.
employeeImportJobSchema.index({ status: 1, 'lease.until': 1 });
// Files checked but never started expire, and so do finished jobs.
employeeImportJobSchema.index(
  { createdAt: 1 },
  {
    expireAfterSeconds: EMPLOYEE_IMPORT_LIMITS.UNCONFIRMED_RETENTION_DAYS * 24 * 60 * 60,
    partialFilterExpression: { status: IMPORT_JOB_STATUSES.VALIDATED },
  },
);
employeeImportJobSchema.index(
  { finishedAt: 1 },
  { expireAfterSeconds: EMPLOYEE_IMPORT_LIMITS.RETENTION_DAYS * 24 * 60 * 60 },
);

export default mongoose.model('EmployeeImportJob', employeeImportJobSchema);
