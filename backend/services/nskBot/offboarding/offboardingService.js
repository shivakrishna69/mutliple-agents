/**
 * Offboarding through NSK (routes under /api/nsk-bot/offboarding, controllers/offboardingController.js).
 *
 *   previewOffboarding   HR (RUN_OFFBOARDING) picks the person, the notice date and last working day,
 *                        and adjusts any figure; the full and final settlement is computed
 *                        (utils/payroll/finalSettlement.js) from what the portal holds
 *                        (settlementInputs.js) and saved as the person's DRAFT case. Previewing again
 *                        replaces the draft. Nothing else changes.
 *   executeOffboarding   starts it: recomputes the settlement and refuses when it no longer matches
 *                        the preview, then, in one conditional update, moves the case to QUEUED, sets
 *                        the person's status to Notice (the account stays active), and queues the
 *                        documents (offboardingQueue.js). On a FAILED case it queues the documents
 *                        again.
 *   getCase / listCases  RUN_OFFBOARDING or VIEW_FINAL_SETTLEMENT (finance: read-only)
 *   cancelDraft          a draft only
 *   itChecklist          VIEW_IT_OFFBOARDING: everyone serving notice, their last working day and what
 *                        IT must revoke; no pay figures
 *   createArtifactDownload  a 60-second link to one document, for the roles that document is for
 *                        (ARTIFACT_CAPABILITIES)
 *
 * Every figure, note and banner a client shows comes from here and constants/messages.js.
 */

import { createHash } from 'node:crypto';
import { CAPABILITIES, hasCapability } from '../../../constants/accessRoles.js';
import { HTTP_STATUS } from '../../../constants/httpStatus.js';
import { OFFBOARDING_MESSAGES as M } from '../../../constants/messages.js';
import { OFFBOARDING_SETTINGS as S } from '../../../constants/validation.js';
import Department from '../../../models/Department.js';
import EmployeeProfile, { EMPLOYMENT_STATUSES } from '../../../models/EmployeeProfile.js';
import OffboardingCase, {
  ARTIFACT_KINDS,
  EXECUTED_STATUSES,
  OFFBOARDING_STATUSES,
  SALARY_SOURCES,
} from '../../../models/OffboardingCase.js';
import OfficeLocation, { DEFAULT_WEEKLY_OFF_RULES } from '../../../models/OfficeLocation.js';
import User from '../../../models/User.js';
import {
  addDaysToCalendarDate,
  calendarDateOfUtcInstant,
  daysBetweenCalendarDates,
} from '../../../utils/calendarDates.js';
import { computeFinalSettlement, settlementDueDate } from '../../../utils/payroll/finalSettlement.js';
import { DAY_KINDS } from '../../../constants/calendarDays.js';
import { companyToday } from '../../companyToday.js';
import { isPdfRendererConfigured } from '../../pdfGenerationService.js';
import { ServiceError } from '../../serviceError.js';
import { loadOfficeCalendar } from '../../workCalendar.js';
import { classifyCalendarDay } from '../../workingDays.js';
import { offboardingStore } from './offboardingStorage.js';
import { dispatchOffboardingJob } from './offboardingQueue.js';
import { loadSettlementPrefill } from './settlementInputs.js';

/** Who may download each document. */
export const ARTIFACT_CAPABILITIES = Object.freeze({
  [ARTIFACT_KINDS.RELIEVING_LETTER]: Object.freeze([CAPABILITIES.RUN_OFFBOARDING]),
  [ARTIFACT_KINDS.SETTLEMENT_STATEMENT]: Object.freeze([
    CAPABILITIES.RUN_OFFBOARDING,
    CAPABILITIES.VIEW_FINAL_SETTLEMENT,
  ]),
  [ARTIFACT_KINDS.ATTENDANCE_AUDIT]: Object.freeze([CAPABILITIES.RUN_OFFBOARDING]),
});

/** What stops a preview from being started, by code (OFFBOARDING_MESSAGES). */
export const PREVIEW_BLOCKERS = Object.freeze({ SALARY_REQUIRED: 'SALARY_REQUIRED', TDS_REQUIRED: 'TDS_REQUIRED' });

const refusal = (httpStatus, code, message = M[code]) => new ServiceError(httpStatus, code, message);
// The days the settlement deadline may be looked for in: weekends and a run of holidays fit easily.
const DEADLINE_SEARCH_DAYS = 31;

export const isOffboardingAvailable = () => offboardingStore.isConfigured() && isPdfRendererConfigured();

// =================================================================================================
// The settlement of a case
// =================================================================================================

/** The calculator's input: the prefill, with HR's adjustments in place of what they change. */
export function settlementInputOf({ snapshot, separation, prefill, adjustments }) {
  return {
    dateOfJoining: snapshot.dateOfJoining,
    lastWorkingDay: separation.lastWorkingDay,
    resignationDate: separation.noticeDate,
    salary: {
      monthlyGross: adjustments.monthlyGross ?? prefill.salary.monthlyGross,
      monthlyBasic: adjustments.monthlyBasic ?? prefill.salary.monthlyBasic,
    },
    salaryDays: adjustments.salaryDays ?? null,
    finalMonthAlreadyPaid: prefill.finalMonthAlreadyPaid,
    encashableDays: adjustments.encashableDays ?? prefill.encashableDays,
    noticePeriodDays: prefill.noticePeriodDays,
    noticeShortfallDays: adjustments.noticeShortfallDays ?? null,
    noticeRecoveryWaived: adjustments.noticeRecoveryWaived ?? false,
    isFixedTerm: adjustments.isFixedTerm ?? false,
    monthlyStatutoryDeductions: prefill.salary.statutory,
    otherEarnings: adjustments.otherEarnings ?? [],
    otherDeductions: adjustments.otherDeductions ?? [],
    tax: {
      regime: prefill.salary.regime,
      paidThisYear: prefill.paidThisYear,
      tdsOverride: adjustments.tdsOverride ?? null,
    },
  };
}

const hashOf = (settlement) => createHash('sha256').update(JSON.stringify(settlement)).digest('hex');

function blockersOf({ prefill, adjustments, settlement }) {
  const blockers = [];
  const salaryEntered = adjustments.monthlyGross !== null && adjustments.monthlyGross !== undefined;
  if (prefill.salary.source === SALARY_SOURCES.NONE && !salaryEntered) blockers.push(PREVIEW_BLOCKERS.SALARY_REQUIRED);
  if (!settlement.isComplete) blockers.push(PREVIEW_BLOCKERS.TDS_REQUIRED);
  return blockers;
}

/** The office's working days (its weekly offs and holidays), or Saturday and Sunday off without one. */
async function workingDayTest(officeLocationId, lastWorkingDay) {
  const lastDate = addDaysToCalendarDate(lastWorkingDay, DEADLINE_SEARCH_DAYS);
  const calendar = officeLocationId
    ? await loadOfficeCalendar(officeLocationId, lastWorkingDay, lastDate)
    : { weeklyOffRules: DEFAULT_WEEKLY_OFF_RULES, holidaysByDate: new Map() };
  return (calendarDate) => classifyCalendarDay(calendarDate, calendar).kind === DAY_KINDS.WORKING;
}

/** The person as the documents print them. */
async function snapshotOf(profile) {
  const { organizationData: org } = profile;
  const [user, department, office] = await Promise.all([
    User.findById(profile.userId).select('name').lean(),
    Department.findById(org.departmentId).select('name').lean(),
    org.officeLocationId ? OfficeLocation.findById(org.officeLocationId).select('name').lean() : null,
  ]);
  return {
    name: user?.name ?? profile.employeeCode,
    employeeCode: profile.employeeCode,
    designation: org.designation,
    departmentName: department?.name ?? null,
    officeName: office?.name ?? null,
    dateOfJoining: calendarDateOfUtcInstant(org.dateOfJoining),
    employmentType: org.employmentType,
  };
}

async function computeCase({ profile, snapshot, separation, adjustments, now }) {
  const prefill = await loadSettlementPrefill({ profile, lastWorkingDay: separation.lastWorkingDay, now });
  const settlement = computeFinalSettlement(settlementInputOf({ snapshot, separation, prefill, adjustments }));
  const isWorkingDay = await workingDayTest(profile.organizationData.officeLocationId, separation.lastWorkingDay);
  return {
    prefill,
    settlement,
    settlementHash: hashOf(settlement),
    settlementDueDate: settlementDueDate(separation.lastWorkingDay, isWorkingDay),
  };
}

// =================================================================================================
// Summaries
// =================================================================================================

function notesOf(offboardingCase) {
  const { prefill, settlement } = offboardingCase;
  const notes = [M.SALARY_SOURCE_NOTES[prefill.salary.source](prefill.salary.payslipPeriod)];
  if (prefill.finalMonthAlreadyPaid) notes.push(M.FINAL_MONTH_PAID_NOTE);
  const { tax } = settlement;
  notes.push(M.TDS_NOTES[tax.source](tax.financialYear, tax.regime));
  return notes;
}

const canDownload = (role, kind) => ARTIFACT_CAPABILITIES[kind].some((capability) => hasCapability(role, capability));

/** A case as the API returns it to `role`. */
export function toCaseSummary(offboardingCase, role) {
  const plain = typeof offboardingCase.toObject === 'function' ? offboardingCase.toObject() : offboardingCase;
  return {
    id: plain._id.toString(),
    status: plain.status,
    version: plain.__v,
    employeeId: plain.employeeId.toString(),
    employee: plain.employeeSnapshot,
    separation: plain.separation,
    adjustments: plain.adjustments,
    prefill: {
      salarySource: plain.prefill.salary.source,
      payslipPeriod: plain.prefill.salary.payslipPeriod ?? null,
      monthlyGross: plain.prefill.salary.monthlyGross,
      monthlyBasic: plain.prefill.salary.monthlyBasic,
      noticePeriodDays: plain.prefill.noticePeriodDays,
      encashableDays: plain.prefill.encashableDays,
      finalMonthAlreadyPaid: plain.prefill.finalMonthAlreadyPaid,
    },
    settlement: plain.settlement,
    settlementDueDate: plain.settlementDueDate,
    complianceNote: M.SETTLEMENT_DEADLINE_NOTE(plain.settlementDueDate),
    notes: notesOf(plain),
    blockers: blockersOf(plain),
    progress: plain.progress,
    lastErrorCode: plain.lastErrorCode,
    artifacts: (plain.artifacts ?? []).map((artifact) => ({
      id: artifact._id.toString(),
      kind: artifact.kind,
      fileName: artifact.fileName,
      contentType: artifact.contentType,
      sizeBytes: artifact.sizeBytes,
      sha256: artifact.sha256,
      generatedAt: artifact.generatedAt,
      downloadable: canDownload(role, artifact.kind),
    })),
    executedAt: plain.executedAt,
    completedAt: plain.completedAt,
    createdAt: plain.createdAt,
    updatedAt: plain.updatedAt,
  };
}

// =================================================================================================
// Preview, execute, cancel
// =================================================================================================

async function loadOffboardableProfile(employeeId, actor) {
  const profile = await EmployeeProfile.findById(employeeId).lean();
  if (!profile) throw refusal(HTTP_STATUS.NOT_FOUND, 'EMPLOYEE_NOT_FOUND');
  if (profile.organizationData.employmentStatus === EMPLOYMENT_STATUSES.TERMINATED) {
    throw refusal(HTTP_STATUS.CONFLICT, 'NOT_OFFBOARDABLE');
  }
  if (profile.userId.toString() === actor.id) throw refusal(HTTP_STATUS.FORBIDDEN, 'CANNOT_OFFBOARD_SELF');
  return profile;
}

function checkDates({ separation, snapshot, today }) {
  if (separation.lastWorkingDay < separation.noticeDate) {
    throw refusal(HTTP_STATUS.UNPROCESSABLE_CONTENT, 'LAST_DAY_BEFORE_NOTICE');
  }
  if (separation.lastWorkingDay < snapshot.dateOfJoining) {
    throw refusal(HTTP_STATUS.UNPROCESSABLE_CONTENT, 'LAST_DAY_BEFORE_JOINING');
  }
  if (daysBetweenCalendarDates(today, separation.lastWorkingDay) > S.LAST_WORKING_DAY_MAX_DAYS_AHEAD) {
    throw refusal(
      HTTP_STATUS.UNPROCESSABLE_CONTENT,
      'LAST_DAY_TOO_FAR',
      M.LAST_DAY_TOO_FAR(S.LAST_WORKING_DAY_MAX_DAYS_AHEAD),
    );
  }
}

/**
 * @param {{ actor: { id: string, role: string }, input: { employeeId: string, separation: object,
 *   adjustments: object, version: number|null }, now?: Date }} request
 */
export async function previewOffboarding({ actor, input, now = new Date() }) {
  const profile = await loadOffboardableProfile(input.employeeId, actor);
  const existing = await OffboardingCase.findOne({ employeeId: profile._id, isActive: true });
  if (existing && existing.status !== OFFBOARDING_STATUSES.DRAFT)
    throw refusal(HTTP_STATUS.CONFLICT, 'ALREADY_STARTED');
  if (existing && input.version !== null && existing.__v !== input.version) {
    throw refusal(HTTP_STATUS.CONFLICT, 'VERSION_CONFLICT');
  }
  const snapshot = await snapshotOf(profile);
  checkDates({ separation: input.separation, snapshot, today: await companyToday(now) });
  const computed = await computeCase({
    profile,
    snapshot,
    separation: input.separation,
    adjustments: input.adjustments,
    now,
  });
  const fields = {
    employeeSnapshot: snapshot,
    separation: input.separation,
    adjustments: input.adjustments,
    ...computed,
    updatedByUserId: actor.id,
  };
  let saved;
  try {
    if (existing) {
      existing.set(fields);
      saved = await existing.save();
    } else {
      saved = await OffboardingCase.create({
        ...fields,
        employeeId: profile._id,
        employeeUserId: profile.userId,
        createdByUserId: actor.id,
      });
    }
  } catch (saveError) {
    // Another preview of the same person saved first (a new draft, or a newer version of this one).
    if (saveError.name === 'VersionError' || saveError.code === 11000) {
      throw refusal(HTTP_STATUS.CONFLICT, 'VERSION_CONFLICT');
    }
    throw saveError;
  }
  return toCaseSummary(saved, actor.role);
}

async function retryGeneration(offboardingCase, actor) {
  const updated = await OffboardingCase.findOneAndUpdate(
    { _id: offboardingCase._id, status: OFFBOARDING_STATUSES.FAILED },
    {
      $set: { status: OFFBOARDING_STATUSES.QUEUED, attempts: 0, lastErrorCode: null, 'lease.until': null },
      $inc: { __v: 1 },
    },
    { new: true },
  );
  if (!updated) throw refusal(HTTP_STATUS.CONFLICT, 'VERSION_CONFLICT');
  await dispatchOffboardingJob(updated._id.toString());
  return { offboardingCase: toCaseSummary(updated, actor.role), retried: true };
}

/**
 * @param {{ actor: { id: string, role: string }, caseId: string, version: number, now?: Date }} request
 * @returns {Promise<{ offboardingCase: object, retried: boolean }>}
 */
export async function executeOffboarding({ actor, caseId, version, now = new Date() }) {
  if (!isOffboardingAvailable()) throw refusal(HTTP_STATUS.SERVICE_UNAVAILABLE, 'UNAVAILABLE');
  const offboardingCase = await OffboardingCase.findById(caseId).lean();
  if (!offboardingCase) throw refusal(HTTP_STATUS.NOT_FOUND, 'CASE_NOT_FOUND');
  if (offboardingCase.status === OFFBOARDING_STATUSES.FAILED) return retryGeneration(offboardingCase, actor);
  if (offboardingCase.status !== OFFBOARDING_STATUSES.DRAFT) throw refusal(HTTP_STATUS.CONFLICT, 'ALREADY_STARTED');
  if (offboardingCase.__v !== version) throw refusal(HTTP_STATUS.CONFLICT, 'VERSION_CONFLICT');

  const profile = await loadOffboardableProfile(offboardingCase.employeeId, actor);
  const computed = await computeCase({
    profile,
    snapshot: offboardingCase.employeeSnapshot,
    separation: offboardingCase.separation,
    adjustments: offboardingCase.adjustments,
    now,
  });
  if (computed.settlementHash !== offboardingCase.settlementHash) {
    throw refusal(HTTP_STATUS.CONFLICT, 'PREVIEW_OUT_OF_DATE');
  }
  const [blocker] = blockersOf({ ...offboardingCase, settlement: computed.settlement });
  if (blocker) throw refusal(HTTP_STATUS.UNPROCESSABLE_CONTENT, blocker);

  const previousEmploymentStatus = profile.organizationData.employmentStatus;
  const started = await OffboardingCase.findOneAndUpdate(
    { _id: offboardingCase._id, status: OFFBOARDING_STATUSES.DRAFT, __v: version },
    {
      $set: {
        status: OFFBOARDING_STATUSES.QUEUED,
        executedByUserId: actor.id,
        executedAt: now,
        previousEmploymentStatus,
        progress: { completedSteps: 0, totalSteps: Object.keys(ARTIFACT_KINDS).length, currentStep: null },
      },
      $inc: { __v: 1 },
    },
    { new: true },
  );
  if (!started) throw refusal(HTTP_STATUS.CONFLICT, 'VERSION_CONFLICT');
  try {
    await EmployeeProfile.updateOne(
      { _id: profile._id },
      { $set: { 'organizationData.employmentStatus': EMPLOYMENT_STATUSES.NOTICE } },
    );
  } catch (statusError) {
    // The person must not be left half offboarded: put the draft back as it was.
    await OffboardingCase.updateOne(
      { _id: started._id },
      { $set: { status: OFFBOARDING_STATUSES.DRAFT, executedByUserId: null, executedAt: null }, $inc: { __v: 1 } },
    );
    throw statusError;
  }
  await dispatchOffboardingJob(started._id.toString());
  return { offboardingCase: toCaseSummary(started, actor.role), retried: false };
}

/** @param {{ caseId: string, version: number }} request */
export async function cancelDraft({ actor, caseId, version }) {
  const cancelled = await OffboardingCase.findOneAndUpdate(
    { _id: caseId, status: OFFBOARDING_STATUSES.DRAFT, __v: version },
    { $set: { status: OFFBOARDING_STATUSES.CANCELLED, isActive: false, updatedByUserId: actor.id }, $inc: { __v: 1 } },
    { new: true },
  );
  if (cancelled) return toCaseSummary(cancelled, actor.role);
  const current = await OffboardingCase.findById(caseId).select('status __v').lean();
  if (!current) throw refusal(HTTP_STATUS.NOT_FOUND, 'CASE_NOT_FOUND');
  if (current.status !== OFFBOARDING_STATUSES.DRAFT) throw refusal(HTTP_STATUS.CONFLICT, 'NOT_A_DRAFT');
  throw refusal(HTTP_STATUS.CONFLICT, 'VERSION_CONFLICT');
}

// =================================================================================================
// Reading
// =================================================================================================

export async function getCase({ actor, caseId }) {
  const offboardingCase = await OffboardingCase.findById(caseId).lean();
  if (!offboardingCase) throw refusal(HTTP_STATUS.NOT_FOUND, 'CASE_NOT_FOUND');
  return toCaseSummary(offboardingCase, actor.role);
}

/** @param {{ actor: object, status: string|null }} request  newest first, at most CASES_LISTED */
export async function listCases({ actor, status }) {
  const filter = status ? { status } : { status: { $ne: OFFBOARDING_STATUSES.CANCELLED } };
  const cases = await OffboardingCase.find(filter).sort({ updatedAt: -1 }).limit(S.CASES_LISTED).lean();
  return cases.map((offboardingCase) => toCaseSummary(offboardingCase, actor.role));
}

/**
 * Everyone serving notice, soonest last day first, with what IT must revoke. Read-only and without pay
 * figures: the last working day comes from the person's started case, when there is one.
 */
export async function itChecklist({ now = new Date() } = {}) {
  const profiles = await EmployeeProfile.find({ 'organizationData.employmentStatus': EMPLOYMENT_STATUSES.NOTICE })
    .select('userId employeeCode organizationData.designation organizationData.departmentId')
    .lean();
  const [users, departments, cases, today] = await Promise.all([
    User.find({ _id: { $in: profiles.map((profile) => profile.userId) } })
      .select('name email companyEmail status')
      .lean(),
    Department.find({ _id: { $in: profiles.map((profile) => profile.organizationData.departmentId) } })
      .select('name')
      .lean(),
    OffboardingCase.find({
      employeeId: { $in: profiles.map((profile) => profile._id) },
      isActive: true,
      status: { $in: EXECUTED_STATUSES },
    })
      .select('employeeId separation.lastWorkingDay')
      .lean(),
    companyToday(now),
  ]);
  const userById = new Map(users.map((user) => [user._id.toString(), user]));
  const departmentById = new Map(departments.map((department) => [department._id.toString(), department.name]));
  const lastDayByEmployee = new Map(cases.map((item) => [item.employeeId.toString(), item.separation.lastWorkingDay]));
  const people = profiles.map((profile) => {
    const user = userById.get(profile.userId.toString());
    const lastWorkingDay = lastDayByEmployee.get(profile._id.toString()) ?? null;
    return {
      employeeId: profile._id.toString(),
      employeeCode: profile.employeeCode,
      name: user?.name ?? null,
      workEmail: user?.companyEmail ?? user?.email ?? null,
      accountStatus: user?.status ?? null,
      designation: profile.organizationData.designation,
      department: departmentById.get(profile.organizationData.departmentId?.toString()) ?? null,
      lastWorkingDay,
      daysLeft: lastWorkingDay ? daysBetweenCalendarDates(today, lastWorkingDay) : null,
    };
  });
  people.sort((first, second) => (first.lastWorkingDay ?? '9999').localeCompare(second.lastWorkingDay ?? '9999'));
  return { today, items: M.IT_CHECKLIST_ITEMS, people };
}

/** A 60-second link to one document, for the roles allowed to download it. */
export async function createArtifactDownload({ actor, artifactId }) {
  const offboardingCase = await OffboardingCase.findOne({ 'artifacts._id': artifactId })
    .select('+artifacts.s3Key')
    .lean();
  const artifact = offboardingCase?.artifacts.find((item) => item._id.toString() === artifactId);
  if (!artifact) throw refusal(HTTP_STATUS.NOT_FOUND, 'ARTIFACT_NOT_FOUND');
  if (!canDownload(actor.role, artifact.kind)) {
    const forbidden = refusal(HTTP_STATUS.FORBIDDEN, 'ARTIFACT_NOT_ALLOWED');
    forbidden.auditDetails = { caseId: offboardingCase._id.toString(), kind: artifact.kind };
    throw forbidden;
  }
  if (!offboardingStore.isConfigured()) throw refusal(HTTP_STATUS.SERVICE_UNAVAILABLE, 'UNAVAILABLE');
  const { downloadUrl, expiresAt } = await offboardingStore.createDownloadUrl(
    artifact.s3Key,
    artifact.fileName,
    artifact.contentType,
  );
  return {
    caseId: offboardingCase._id.toString(),
    employeeId: offboardingCase.employeeId.toString(),
    kind: artifact.kind,
    download: { url: downloadUrl, expiresAt, fileName: artifact.fileName, contentType: artifact.contentType },
  };
}
