/**
 * Runs a confirmed employee import (models/EmployeeImportJob.js): creates the departments the file
 * introduces, then invites each person through the same path as a single invitation
 * (services/invitationService.js createInvitation), managers before their teams, so every imported
 * person gets an invited account, a profile with an employee ID, and their activation email.
 *
 * One worker at a time: the job is claimed with a lease (an atomic update), renewed after every
 * row. A worker that stops leaves the lease to run out, and the next sweep resumes the job where it
 * stopped; rows already done are never redone. A row the stopped worker was in the middle of is
 * checked: if its invitation exists it counts as created, otherwise it is reported for HR to check,
 * never guessed at. After MAX_ATTEMPTS claims, whatever is left is reported as failed.
 *
 * Emails are paced (IMPORT_EMAILS_PER_MINUTE), so a large import stays within the mail provider's
 * sending limits. A link that could not be emailed is kept sealed for HR (utils/secretBox.js).
 */

import mongoose from 'mongoose';
import { EMPLOYEE_IMPORT_LIMITS } from '../constants/validation.js';
import Department from '../models/Department.js';
import EmployeeImportJob, { IMPORT_JOB_STATUSES, IMPORT_ROW_STATUSES } from '../models/EmployeeImportJob.js';
import EmployeeInvitation from '../models/EmployeeInvitation.js';
import EmployeeProfile from '../models/EmployeeProfile.js';
import OfficeLocation from '../models/OfficeLocation.js';
import User from '../models/User.js';
import { logger } from '../utils/logger.js';
import { sealSecret } from '../utils/secretBox.js';
import { loadEmailContext } from './companySettings.js';
import { createDepartment } from './departmentService.js';
import { InvitationError, createInvitation } from './invitationService.js';
import { MAIL_OUTCOMES } from './mailService.js';
import { firstRowByEmail } from './employeeImportValidation.js';
import { ServiceError } from './serviceError.js';

/** The purpose under which activation links are sealed in import jobs. */
export const INVITE_LINK_SEAL_PURPOSE = 'employee-import-invite-links';
const MAX_ATTEMPTS = 3;

const ROW_MESSAGES = Object.freeze({
  RECOVERED: 'Invited before a restart; resend the invitation if the person did not receive it',
  INTERRUPTED: 'Interrupted by a restart; check this person under Invitations before importing them again',
  MANAGER_FAILED: "The manager's row could not be imported",
  GAVE_UP: 'Could not be imported; upload this row again',
});

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/** Takes the job if it is queued, or running under a lease that has run out. Null if not available. */
function claimJob(importJobId, workerId, now) {
  return EmployeeImportJob.findOneAndUpdate(
    {
      _id: importJobId,
      $or: [
        { status: IMPORT_JOB_STATUSES.QUEUED },
        { status: IMPORT_JOB_STATUSES.RUNNING, 'lease.until': { $lt: now } },
      ],
    },
    {
      $set: {
        status: IMPORT_JOB_STATUSES.RUNNING,
        lease: { owner: workerId, until: new Date(now.getTime() + EMPLOYEE_IMPORT_LIMITS.LEASE_MS) },
      },
      $inc: { attempts: 1 },
    },
    { new: true },
  );
}

const renewLease = (job, workerId) =>
  EmployeeImportJob.updateOne(
    { _id: job._id, 'lease.owner': workerId },
    { $set: { 'lease.until': new Date(Date.now() + EMPLOYEE_IMPORT_LIMITS.LEASE_MS) } },
  );

/** Records what became of a row and adds it to the counts. */
function recordRow(job, rowNumber, fields, countChanges = {}) {
  const set = Object.fromEntries(Object.entries(fields).map(([field, value]) => [`rows.$.${field}`, value]));
  const inc = Object.fromEntries(Object.entries(countChanges).map(([count, change]) => [`counts.${count}`, change]));
  return EmployeeImportJob.updateOne(
    { _id: job._id, 'rows.rowNumber': rowNumber },
    { $set: set, ...(Object.keys(inc).length > 0 ? { $inc: inc } : {}) },
  );
}

/** The departments the file introduced: created now, or found if someone created them meanwhile. */
async function ensureDepartments(departmentsToCreate) {
  for (const { code, name } of departmentsToCreate) {
    if (await Department.exists({ code })) continue;
    try {
      await createDepartment({ code, name });
    } catch (creationError) {
      // Created by someone else a moment ago (same code), or a sibling has this name: use the code as name.
      if (!(creationError instanceof ServiceError)) throw creationError;
      if (creationError.code === 'DEPARTMENT_NAME_TAKEN' && !(await Department.exists({ code })))
        await createDepartment({ code, name: `${name} (${code})` });
    }
  }
  const departments = await Department.find({ code: { $in: departmentsToCreate.map(({ code }) => code) } })
    .select('code')
    .lean();
  return departments;
}

/** Rows in an order where every manager in the file comes before their team. */
function managersFirst(rows) {
  const rowByEmail = firstRowByEmail(rows);
  const ordered = [];
  const placed = new Set();
  const place = (row, depth = 0) => {
    if (placed.has(row.rowNumber) || depth > rows.length) return;
    const manager = row.input.managerEmail && rowByEmail.get(row.input.managerEmail);
    if (manager && manager !== row) place(manager, depth + 1);
    placed.add(row.rowNumber);
    ordered.push(row);
  };
  rows.forEach((row) => place(row));
  return ordered;
}

/** A row the previous worker started: done if its invitation exists, otherwise left for HR to check. */
async function recoverInterruptedRow(job, row) {
  const account = await User.findOne({ email: row.input.personalEmail }).select('_id companyEmail').lean();
  const invitation =
    account &&
    (await EmployeeInvitation.findOne({ invitedUserId: account._id, createdAt: { $gte: job.confirmedAt } })
      .select('employeeCode')
      .lean());
  if (!invitation) {
    await recordRow(
      job,
      row.rowNumber,
      { status: IMPORT_ROW_STATUSES.FAILED, message: ROW_MESSAGES.INTERRUPTED },
      { failed: 1 },
    );
    return null;
  }
  const profile = await EmployeeProfile.findOne({ userId: account._id }).select('_id').lean();
  await recordRow(
    job,
    row.rowNumber,
    {
      status: IMPORT_ROW_STATUSES.CREATED,
      employeeCode: invitation.employeeCode,
      companyEmail: account.companyEmail ?? null,
      profileId: profile?._id ?? null,
      message: ROW_MESSAGES.RECOVERED,
    },
    { created: 1 },
  );
  return profile?._id ?? null;
}

/** Invites one row's person. Returns their profile id, or null when the row failed. */
async function importRow(job, row, { context, references }) {
  const { input } = row;
  const managerRow = input.managerEmail ? references.rowByEmail.get(input.managerEmail) : null;
  const reportingManagerId = managerRow ? references.profileIdByEmail.get(input.managerEmail) : row.existingManagerId;
  if (managerRow && !reportingManagerId) {
    await recordRow(
      job,
      row.rowNumber,
      { status: IMPORT_ROW_STATUSES.FAILED, message: ROW_MESSAGES.MANAGER_FAILED },
      { failed: 1 },
    );
    return null;
  }

  await recordRow(job, row.rowNumber, { status: IMPORT_ROW_STATUSES.PROCESSING });
  try {
    const { invitation, delivery } = await createInvitation({
      inviter: { id: job.createdBy.userId.toString(), name: job.createdBy.name, role: job.createdBy.role },
      input: {
        name: input.name,
        email: input.personalEmail,
        companyEmail: input.companyEmail,
        role: input.role,
        profileDraft: {
          designation: input.designation,
          departmentId: references.departmentIdByCode.get(input.departmentCode),
          reportingManagerId: reportingManagerId ?? null,
          officeLocationId: input.officeCode ? (references.officeIdByCode.get(input.officeCode) ?? null) : null,
          workLocationType: input.workLocationType,
          dateOfJoining: new Date(`${input.dateOfJoining}T00:00:00.000Z`),
          employmentStatus: input.employmentStatus,
        },
      },
      appContext: context.emailContext,
    });
    const [account, profile] = await Promise.all([
      User.findById(invitation.invitedUserId).select('companyEmail').lean(),
      EmployeeProfile.findOne({ userId: invitation.invitedUserId }).select('_id').lean(),
    ]);
    const wasEmailed = delivery.outcome === MAIL_OUTCOMES.SENT;
    await recordRow(
      job,
      row.rowNumber,
      {
        status: IMPORT_ROW_STATUSES.CREATED,
        employeeCode: invitation.employeeCode,
        companyEmail: account?.companyEmail ?? null,
        profileId: profile._id,
        delivery: delivery.outcome,
        sealedInviteUrl: delivery.inviteUrl
          ? sealSecret(delivery.inviteUrl, { serverSecret: context.serverSecret, purpose: INVITE_LINK_SEAL_PURPOSE })
          : null,
      },
      { created: 1, ...(wasEmailed ? { emailed: 1 } : {}) },
    );
    if (wasEmailed) await sleep(context.emailIntervalMs);
    return profile._id;
  } catch (rowError) {
    // Refusals the person or HR can act on are reported on the row; anything else stops the run and
    // leaves the row "processing" for the next attempt to check.
    const isRefusal = rowError instanceof InvitationError || rowError instanceof mongoose.Error.ValidationError;
    if (!isRefusal) throw rowError;
    const message = rowError instanceof InvitationError ? rowError.message : Object.values(rowError.errors)[0]?.message;
    await recordRow(job, row.rowNumber, { status: IMPORT_ROW_STATUSES.FAILED, message }, { failed: 1 });
    return null;
  }
}

async function finishJob(job, now = new Date()) {
  await EmployeeImportJob.updateOne(
    { _id: job._id },
    { $set: { status: IMPORT_JOB_STATUSES.COMPLETED, finishedAt: now, lease: { owner: null, until: null } } },
  );
}

/** After too many attempts, reports whatever is left as failed and finishes. */
async function giveUp(job) {
  for (const row of job.rows) {
    if ([IMPORT_ROW_STATUSES.PENDING, IMPORT_ROW_STATUSES.PROCESSING].includes(row.status))
      await recordRow(
        job,
        row.rowNumber,
        { status: IMPORT_ROW_STATUSES.FAILED, message: ROW_MESSAGES.GAVE_UP },
        { failed: 1 },
      );
  }
  await finishJob(job);
  logger.error('Employee import given up after repeated failures', { importJobId: job._id.toString() });
}

/**
 * Runs (or resumes) one import. Returns quietly if another worker holds it or it is finished.
 * @param {string} importJobId
 * @param {{ config: object, workerId: string }} runContext
 */
export async function runImportJob(importJobId, { config, workerId }) {
  const job = await claimJob(importJobId, workerId, new Date());
  if (!job) return;
  if (!job.startedAt) await EmployeeImportJob.updateOne({ _id: job._id }, { $set: { startedAt: new Date() } });
  if (job.attempts > MAX_ATTEMPTS) {
    await giveUp(job);
    return;
  }
  logger.info('Employee import running', { importJobId: job._id.toString(), attempt: job.attempts });

  const departments = await ensureDepartments(job.departmentsToCreate);
  const rowsToImport = job.rows.filter((row) =>
    [IMPORT_ROW_STATUSES.PENDING, IMPORT_ROW_STATUSES.PROCESSING, IMPORT_ROW_STATUSES.CREATED].includes(row.status),
  );
  const [existingDepartments, offices] = await Promise.all([
    Department.find({ code: { $in: rowsToImport.map((row) => row.input.departmentCode) } })
      .select('code')
      .lean(),
    OfficeLocation.find({ code: { $in: rowsToImport.map((row) => row.input.officeCode).filter(Boolean) } })
      .select('code')
      .lean(),
  ]);
  const references = {
    departmentIdByCode: new Map(
      [...existingDepartments, ...departments].map((department) => [department.code, department._id]),
    ),
    officeIdByCode: new Map(offices.map((office) => [office.code, office._id])),
    rowByEmail: firstRowByEmail(job.rows),
    // Managers imported earlier (in this run or a previous attempt) are found here.
    profileIdByEmail: new Map(
      job.rows
        .filter((row) => row.status === IMPORT_ROW_STATUSES.CREATED && row.profileId)
        .map((row) => [row.input.personalEmail, row.profileId]),
    ),
  };
  const context = {
    emailContext: await loadEmailContext(config),
    serverSecret: config.jwtSecret,
    emailIntervalMs: Math.ceil(60_000 / config.employeeImport.emailsPerMinute),
  };

  for (const row of managersFirst(rowsToImport)) {
    if (row.status === IMPORT_ROW_STATUSES.CREATED) continue;
    const profileId =
      row.status === IMPORT_ROW_STATUSES.PROCESSING
        ? await recoverInterruptedRow(job, row)
        : await importRow(job, row, { context, references });
    if (profileId) references.profileIdByEmail.set(row.input.personalEmail, profileId);
    await renewLease(job, workerId);
  }
  await finishJob(job);
  logger.info('Employee import finished', { importJobId: job._id.toString() });
}
