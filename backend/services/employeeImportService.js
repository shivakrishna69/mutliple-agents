/**
 * Employee imports as HR uses them: upload a CSV (checked at once, nothing created), review the
 * result, start the import (it runs in the background, services/employeeImportQueue.js), follow its
 * progress, and collect every row's outcome, including the activation links that could not be
 * emailed.
 */

import { HTTP_STATUS } from '../constants/httpStatus.js';
import { EMPLOYEE_IMPORT_MESSAGES } from '../constants/messages.js';
import { EMPLOYEE_IMPORT_LIMITS } from '../constants/validation.js';
import EmployeeImportJob, { IMPORT_JOB_STATUSES } from '../models/EmployeeImportJob.js';
import { openSecret } from '../utils/secretBox.js';
import { parseEmployeeCsv } from './employeeImportParser.js';
import { dispatchImportJob } from './employeeImportQueue.js';
import { INVITE_LINK_SEAL_PURPOSE } from './employeeImportRunner.js';
import { validateImportRows } from './employeeImportValidation.js';
import { ServiceError } from './serviceError.js';

const jobNotFound = () =>
  new ServiceError(HTTP_STATUS.NOT_FOUND, 'IMPORT_NOT_FOUND', EMPLOYEE_IMPORT_MESSAGES.JOB_NOT_FOUND);

const isoOrNull = (date) => date?.toISOString() ?? null;

// A job without its rows. Listed field by field: excluding "rows" would clash with the hidden
// rows.sealedInviteUrl path.
const JOB_SUMMARY_FIELDS =
  'status fileName createdBy departmentsToCreate counts confirmedAt startedAt finishedAt createdAt';

/** A job without its rows; with `issues`, the first validation issues of the rows (for review). */
export function toImportJobSummary(job, { ignoredColumns = [] } = {}) {
  const issues = (job.rows ?? [])
    .flatMap((row) => row.issues.map(({ field, message }) => ({ rowNumber: row.rowNumber, field, message })))
    .slice(0, EMPLOYEE_IMPORT_LIMITS.ISSUES_IN_SUMMARY);
  const { total, valid, invalid, created, failed, emailed } = job.counts;
  return {
    id: job._id.toString(),
    status: job.status,
    fileName: job.fileName,
    createdBy: { userId: job.createdBy.userId.toString(), name: job.createdBy.name },
    counts: { total, valid, invalid, created, failed, emailed, remaining: Math.max(valid - created - failed, 0) },
    departmentsToCreate: job.departmentsToCreate.map(({ code, name }) => ({ code, name })),
    issues,
    ignoredColumns,
    createdAt: isoOrNull(job.createdAt),
    confirmedAt: isoOrNull(job.confirmedAt),
    startedAt: isoOrNull(job.startedAt),
    finishedAt: isoOrNull(job.finishedAt),
  };
}

/**
 * Checks an uploaded file and keeps the result as a job waiting for HR to start it.
 * @param {{ fileBuffer: Buffer, fileName: string, importer: { id: string, name: string, role: string } }} upload
 */
export async function createImportJob({ fileBuffer, fileName, importer }) {
  const { rows: parsedRows, ignoredColumns } = await parseEmployeeCsv(fileBuffer);
  const { rows, departmentsToCreate, counts } = await validateImportRows(parsedRows, { importerRole: importer.role });
  const job = await EmployeeImportJob.create({
    status: IMPORT_JOB_STATUSES.VALIDATED,
    fileName: fileName.slice(0, 255),
    createdBy: { userId: importer.id, name: importer.name, role: importer.role },
    departmentsToCreate,
    rows,
    counts: { ...counts, created: 0, failed: 0, emailed: 0 },
  });
  return toImportJobSummary(job, { ignoredColumns });
}

/** The latest imports, newest first, without their rows. */
export async function listImportJobs() {
  const jobs = await EmployeeImportJob.find()
    .select(JOB_SUMMARY_FIELDS)
    .sort({ createdAt: -1 })
    .limit(EMPLOYEE_IMPORT_LIMITS.RECENT_JOBS_LISTED)
    .lean();
  return jobs.map((job) => toImportJobSummary(job));
}

/** One import with its progress and the first validation issues. */
export async function getImportJob(importJobId) {
  const job = await EmployeeImportJob.findById(importJobId).lean();
  if (!job) throw jobNotFound();
  return toImportJobSummary(job);
}

/** Starts a checked import. Only once, and only when at least one row can be imported. */
export async function confirmImportJob(importJobId) {
  const job = await EmployeeImportJob.findOneAndUpdate(
    { _id: importJobId, status: IMPORT_JOB_STATUSES.VALIDATED, 'counts.valid': { $gt: 0 } },
    { $set: { status: IMPORT_JOB_STATUSES.QUEUED, confirmedAt: new Date() } },
    { new: true, projection: JOB_SUMMARY_FIELDS },
  ).lean();
  if (!job) {
    const existing = await EmployeeImportJob.findById(importJobId).select('status counts').lean();
    if (!existing) throw jobNotFound();
    if (existing.status !== IMPORT_JOB_STATUSES.VALIDATED)
      throw new ServiceError(HTTP_STATUS.CONFLICT, 'IMPORT_ALREADY_STARTED', EMPLOYEE_IMPORT_MESSAGES.JOB_NOT_WAITING);
    throw new ServiceError(HTTP_STATUS.CONFLICT, 'NOTHING_TO_IMPORT', EMPLOYEE_IMPORT_MESSAGES.NOTHING_TO_IMPORT);
  }
  await dispatchImportJob(job._id.toString());
  return toImportJobSummary(job);
}

/**
 * Every row's outcome: the person, their employee ID and company address once created, the email
 * delivery, the activation link when it could not be emailed, and the row's issues or message.
 * @param {string} importJobId
 * @param {{ serverSecret: string }} keys  to open the sealed links
 */
export async function getImportResults(importJobId, { serverSecret }) {
  const job = await EmployeeImportJob.findById(importJobId).select('+rows.sealedInviteUrl').lean();
  if (!job) throw jobNotFound();
  return {
    job: toImportJobSummary({ ...job, rows: [] }),
    rows: job.rows.map((row) => ({
      rowNumber: row.rowNumber,
      name: row.input.name,
      personalEmail: row.input.personalEmail,
      departmentCode: row.input.departmentCode,
      status: row.status,
      employeeCode: row.employeeCode,
      companyEmail: row.companyEmail,
      delivery: row.delivery,
      activationLink: row.sealedInviteUrl
        ? openSecret(row.sealedInviteUrl, { serverSecret, purpose: INVITE_LINK_SEAL_PURPOSE })
        : null,
      issues: row.issues.map(({ field, message }) => ({ field, message })),
      message: row.message,
    })),
  };
}
