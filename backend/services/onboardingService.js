/**
 * Onboarding offers with a person in the loop: HR prepares an offer, someone reviews it, and only
 * an explicit dispatch reaches the candidate (GET/POST /api/hr/onboarding, HR and administrators).
 *
 *   settings        the company's compensation policy and offer terms (models/OnboardingSettings.js)
 *   calculate       the salary structure (services/ctcStructure.js) and, on request, a watermarked
 *                   preview of the letter; writes nothing
 *   create / edit   an OnboardingDraft in PENDING_REVIEW, with the structure as computed then
 *   cancel          PENDING_REVIEW -> CANCELLED
 *   dispatch        the final, human-triggered step:
 *     1. claims the draft in one conditional update (PENDING_REVIEW or DISPATCH_FAILED ->
 *        DISPATCHING), so it is sent at most once even if pressed twice
 *     2. checks the signatory is set and recomputes the structure: if the figures differ from the
 *        reviewed ones (the policy or statutory rules changed), it refuses with
 *        DRAFT_FIGURES_CHANGED, so nobody sends figures they did not review
 *     3. renders the final letter, locked with the candidate's date of birth (DDMMYYYY)
 *     4. creates the employee and invitation through services/invitationService.js (employee ID
 *        from the company's short code and counter), with an activation link that works until the
 *        end of the offer's deadline day (company time zone): activating the account is how the
 *        candidate accepts, so the link and the letter's deadline are one date. Emails the offer
 *        with the letter;
 *        a retry after a failed email resends through the same invitation (no second employee)
 *     5. DISPATCHED, or DISPATCH_FAILED when the email did not go out (it can be dispatched again)
 *   Anything that stops a dispatch before the email puts the draft back as it was.
 *
 * Each offer's terms are its own: probation and notice are the settings' when the draft is saved
 * unless HR set others, and its acceptance deadline is the date HR set or, without one, the settings'
 * validity from the day it is sent. A deadline already past refuses the dispatch (OFFER_EXPIRED).
 *
 * The candidate's lifecycle (offerLifecycleOf) follows from the draft and its invitation, so it is
 * never stored and cannot drift: INVITED (prepared, not sent) → OFFER_SENT → ACCEPTED (they activated
 * their account from the offer email) → PROBATION (from the joining date, for the probation months)
 * → JOINED; WITHDRAWN when the draft was cancelled or the invitation revoked.
 */

import { isDeepStrictEqual } from 'node:util';

import { HTTP_STATUS } from '../constants/httpStatus.js';
import { ONBOARDING_MESSAGES } from '../constants/messages.js';
import { ONBOARDING_SETTINGS } from '../constants/validation.js';
import Department from '../models/Department.js';
import EmployeeProfile from '../models/EmployeeProfile.js';
import EmployeeInvitation, { INVITATION_STATUSES } from '../models/EmployeeInvitation.js';
import LeaveType from '../models/LeaveType.js';
import OnboardingDraft, { DISPATCHABLE_STATUSES, DRAFT_STATUSES } from '../models/OnboardingDraft.js';
import OnboardingSettings, { ONBOARDING_SETTINGS_KEY } from '../models/OnboardingSettings.js';
import User from '../models/User.js';
import { PayrollInputError } from '../utils/payrollCalculator.js';
import { logger } from '../utils/logger.js';
import { isDuplicateKeyError } from '../utils/mongoErrors.js';
import { addDaysToCalendarDate } from '../utils/calendarDates.js';
import { localDayStart, readOfficeLocalClock } from './attendancePolicy.js';
import { getCompanySettings } from './companySettings.js';
import { CtcStructureError, computeCtcStructure } from './ctcStructure.js';
import { InvitationError, createInvitation, resendInvitation } from './invitationService.js';
import { MAIL_OUTCOMES } from './mailService.js';
import { buildOfferEmail } from './offerEmail.js';
import { isOfferLetterRenderingAvailable, letterheadCompany, renderOfferLetter } from './offerLetterGenerator.js';
import { PdfProtectionError } from './pdfProtection.js';
import { PdfRenderError } from './pdfGenerationService.js';
import { ServiceError, assertCurrentVersion, saveVersioned } from './serviceError.js';

const PDF_MEDIA_TYPE = 'application/pdf';

const conflict = (code) => new ServiceError(HTTP_STATUS.CONFLICT, code, ONBOARDING_MESSAGES[code]);
const draftNotFound = () =>
  new ServiceError(HTTP_STATUS.NOT_FOUND, 'DRAFT_NOT_FOUND', ONBOARDING_MESSAGES.DRAFT_NOT_FOUND);
const pdfUnavailable = () =>
  new ServiceError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'PDF_UNAVAILABLE', ONBOARDING_MESSAGES.PDF_UNAVAILABLE);

// =================================================================================================
// Settings
// =================================================================================================

/** The settings document, created with the defaults on first use. */
export async function getOnboardingSettings() {
  try {
    return await OnboardingSettings.findOneAndUpdate(
      { key: ONBOARDING_SETTINGS_KEY },
      { $setOnInsert: { key: ONBOARDING_SETTINGS_KEY } },
      { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true },
    );
  } catch (upsertError) {
    // Two requests creating it at once: the other one did.
    if (!isDuplicateKeyError(upsertError)) throw upsertError;
    return OnboardingSettings.findOne({ key: ONBOARDING_SETTINGS_KEY });
  }
}

const plainCompensation = (settings) => {
  const {
    basicShareBasisPoints,
    hraFiftyPercentCityBasisPoints,
    hraOtherCityBasisPoints,
    pfOnFullBasic,
    includeGratuityInCtc,
  } = settings.compensation;
  return {
    basicShareBasisPoints,
    hraFiftyPercentCityBasisPoints,
    hraOtherCityBasisPoints,
    pfOnFullBasic,
    includeGratuityInCtc,
  };
};

const plainOfferTerms = (settings) => {
  const terms = settings.offerTerms;
  return {
    probationMonths: terms.probationMonths,
    noticePeriodDays: terms.noticePeriodDays,
    weeklyWorkingHours: terms.weeklyWorkingHours,
    offerValidityDays: terms.offerValidityDays,
    signatoryName: terms.signatoryName ?? null,
    signatoryTitle: terms.signatoryTitle ?? null,
    additionalClauses: [...terms.additionalClauses],
    shiftTimings: terms.shiftTimings ?? null,
    confidentialityClause: terms.confidentialityClause,
    ipAssignmentClause: terms.ipAssignmentClause,
    nonSolicitationClause: terms.nonSolicitationClause,
    nonSolicitationMonths: terms.nonSolicitationMonths,
    esopNote: terms.esopNote ?? null,
    joiningChecklist: [...terms.joiningChecklist],
  };
};

/** An offer's own terms: what HR set, else the settings'; the deadline stays null until sent. */
const resolvedTermsOf = (offer, settings) => ({
  probationMonths: offer.terms?.probationMonths ?? settings.offerTerms.probationMonths,
  noticePeriodDays: offer.terms?.noticePeriodDays ?? settings.offerTerms.noticePeriodDays,
  offerValidUntil: offer.terms?.offerValidUntil ?? null,
});

export function toSettingsSummary(settings) {
  return { compensation: plainCompensation(settings), offerTerms: plainOfferTerms(settings), version: settings.__v };
}

/** HR's changes to the policy or terms, refused when based on an older version. */
export async function updateOnboardingSettings({ changes, version, actorUserId }) {
  const settings = await getOnboardingSettings();
  assertCurrentVersion(settings, version);
  for (const [groupName, groupChanges] of Object.entries(changes)) {
    for (const [fieldName, value] of Object.entries(groupChanges)) settings.set(`${groupName}.${fieldName}`, value);
  }
  settings.updatedByUserId = actorUserId;
  await saveVersioned(settings);
  return toSettingsSummary(settings);
}

// =================================================================================================
// Calculation
// =================================================================================================

/** The structure of an offer under the current policy; refusals become 400s on the right field. */
function structureFor(offer, policy) {
  try {
    return computeCtcStructure(
      {
        ...offer.compensation,
        gender: offer.candidate.gender,
        dateOfBirth: offer.candidate.dateOfBirth,
        joiningDate: offer.position.dateOfJoining,
      },
      policy,
    );
  } catch (structureError) {
    if (structureError instanceof CtcStructureError) {
      const message =
        structureError.code === 'SPLIT_DOES_NOT_ADD_UP'
          ? ONBOARDING_MESSAGES.SPLIT_DOES_NOT_ADD_UP(structureError.details.expectedSpecialAllowanceAnnual)
          : ONBOARDING_MESSAGES[structureError.code];
      throw new ServiceError(HTTP_STATUS.BAD_REQUEST, structureError.code, message);
    }
    if (structureError instanceof PayrollInputError) {
      throw new ServiceError(HTTP_STATUS.BAD_REQUEST, 'PAYROLL_INPUT_INVALID', ONBOARDING_MESSAGES.INPUT_INVALID);
    }
    throw structureError;
  }
}

/** The department and manager the letter names; a missing one is refused like an invitation would be. */
async function loadPositionNames(position) {
  const [department, managerProfile] = await Promise.all([
    Department.findById(position.departmentId).select('name').lean(),
    position.reportingManagerId ? EmployeeProfile.findById(position.reportingManagerId).select('userId').lean() : null,
  ]);
  if (!department) {
    throw new ServiceError(HTTP_STATUS.BAD_REQUEST, 'DEPARTMENT_NOT_FOUND', ONBOARDING_MESSAGES.INPUT_INVALID);
  }
  if (position.reportingManagerId && !managerProfile) {
    throw new ServiceError(HTTP_STATUS.BAD_REQUEST, 'MANAGER_NOT_FOUND', ONBOARDING_MESSAGES.INPUT_INVALID);
  }
  const manager = managerProfile ? await User.findById(managerProfile.userId).select('name').lean() : null;
  return { departmentName: department.name, managerName: manager?.name ?? null };
}

/** The leave a new employee earns, for the letter's terms: active leave types with a yearly quota. */
async function loadLeavePolicy() {
  const leaveTypes = await LeaveType.find({ isActive: true, 'accrual.annualQuotaDays': { $gt: 0 } })
    .select('name accrual.annualQuotaDays')
    .sort({ name: 1 })
    .lean();
  return leaveTypes.map((leaveType) => ({ name: leaveType.name, annualDays: leaveType.accrual.annualQuotaDays }));
}

/** Everything compileOfferLetterHtml needs for this offer. */
async function letterFor(offer, structure, settings, issuedOn) {
  const [companySettings, names, leavePolicy] = await Promise.all([
    getCompanySettings(),
    loadPositionNames(offer.position),
    loadLeavePolicy(),
  ]);
  const terms = { ...plainOfferTerms(settings), ...resolvedTermsOf(offer, settings) };
  // The last day to accept: the date HR set, else the settings' validity from the day it is issued.
  const deadlineDate = terms.offerValidUntil
    ? terms.offerValidUntil.toISOString().slice(0, 10)
    : addDaysToCalendarDate(
        readOfficeLocalClock(issuedOn, companySettings.timeZone).calendarDate,
        terms.offerValidityDays,
      );
  return {
    company: letterheadCompany(companySettings),
    candidate: { name: offer.candidate.name },
    position: {
      designation: offer.position.designation,
      departmentName: names.departmentName,
      managerName: names.managerName,
      dateOfJoining: offer.position.dateOfJoining,
      workLocationType: offer.position.workLocationType,
      employmentStatus: offer.position.employmentStatus,
      employmentType: offer.position.employmentType,
    },
    structure,
    stockOptions: { units: offer.compensation.esopUnits ?? 0, note: terms.esopNote },
    terms,
    leavePolicy,
    issuedOn,
    validUntil: new Date(`${deadlineDate}T00:00:00Z`),
    deadlineDate,
    companyTimeZone: companySettings.timeZone,
  };
}

/**
 * Renders a letter, turning a renderer or qpdf problem into 503 PDF_UNAVAILABLE. The cause goes to
 * the log (never to the client), so whoever runs the server can see what to fix.
 */
async function renderLetter(letter, options) {
  if (!isOfferLetterRenderingAvailable()) throw pdfUnavailable();
  try {
    return await renderOfferLetter(letter, options);
  } catch (renderError) {
    if (renderError instanceof PdfRenderError || renderError instanceof PdfProtectionError) {
      logger.error('Offer letter could not be produced', {
        stage: renderError instanceof PdfProtectionError ? 'protect' : 'render',
        preview: options.preview,
        reason: renderError instanceof PdfProtectionError ? renderError.reason : renderError.message,
      });
      throw pdfUnavailable();
    }
    throw renderError;
  }
}

/** POST /calculate: the structure and, when asked, a watermarked preview of the letter. Writes nothing. */
export async function calculateOffer(offer, { now = new Date() } = {}) {
  const settings = await getOnboardingSettings();
  const structure = structureFor(offer, plainCompensation(settings));
  if (!offer.includePreview) return { structure, preview: null };
  const { pdf } = await renderLetter(await letterFor(offer, structure, settings, now), { preview: true });
  return { structure, preview: { mediaType: PDF_MEDIA_TYPE, base64: pdf.toString('base64') } };
}

// =================================================================================================
// Drafts
// =================================================================================================

export const OFFER_LIFECYCLE = Object.freeze({
  INVITED: 'INVITED',
  OFFER_SENT: 'OFFER_SENT',
  ACCEPTED: 'ACCEPTED',
  PROBATION: 'PROBATION',
  JOINED: 'JOINED',
  WITHDRAWN: 'WITHDRAWN',
});

/** The calendar date `months` after a "YYYY-MM-DD" date (the month's last day when it is shorter). */
function addMonthsToCalendarDate(calendarDate, months) {
  const [year, month, day] = calendarDate.split('-').map(Number);
  const lastDay = new Date(Date.UTC(year, month - 1 + months + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month - 1 + months, Math.min(day, lastDay))).toISOString().slice(0, 10);
}

/**
 * Where the candidate is (see the module comment), pure.
 * @param {{ status: string, invitationStatus: string|null, dateOfJoining: string, probationMonths: number,
 *   today: string }} facts  dates "YYYY-MM-DD"
 */
export function offerLifecycleOf({ status, invitationStatus, dateOfJoining, probationMonths, today }) {
  if (status === DRAFT_STATUSES.CANCELLED || invitationStatus === INVITATION_STATUSES.REVOKED) {
    return OFFER_LIFECYCLE.WITHDRAWN;
  }
  if (invitationStatus === INVITATION_STATUSES.ACCEPTED) {
    if (today < dateOfJoining) return OFFER_LIFECYCLE.ACCEPTED;
    return today < addMonthsToCalendarDate(dateOfJoining, probationMonths)
      ? OFFER_LIFECYCLE.PROBATION
      : OFFER_LIFECYCLE.JOINED;
  }
  return status === DRAFT_STATUSES.DISPATCHED ? OFFER_LIFECYCLE.OFFER_SENT : OFFER_LIFECYCLE.INVITED;
}

const calendarDateOf = (date) => date.toISOString().slice(0, 10);

/**
 * @param {object} draft
 * @param {{ invitation?: { status: string, acceptedAt: Date|null }|null, now?: Date }} [context]
 */
export function toDraftSummary(draft, { invitation = null, now = new Date() } = {}) {
  const dateOfJoining = calendarDateOf(draft.position.dateOfJoining);
  return {
    id: draft._id.toString(),
    status: draft.status,
    lifecycle: offerLifecycleOf({
      status: draft.status,
      invitationStatus: invitation?.status ?? null,
      dateOfJoining,
      probationMonths: draft.terms.probationMonths,
      today: calendarDateOf(now),
    }),
    acceptedAt: invitation?.acceptedAt?.toISOString() ?? null,
    candidate: {
      name: draft.candidate.name,
      personalEmail: draft.candidate.personalEmail,
      companyEmail: draft.candidate.companyEmail ?? null,
      dateOfBirth: draft.candidate.dateOfBirth.toISOString().slice(0, 10),
      gender: draft.candidate.gender ?? null,
    },
    position: {
      role: draft.position.role,
      designation: draft.position.designation,
      departmentId: draft.position.departmentId.toString(),
      reportingManagerId: draft.position.reportingManagerId?.toString() ?? null,
      workLocationType: draft.position.workLocationType,
      dateOfJoining: draft.position.dateOfJoining.toISOString().slice(0, 10),
      employmentStatus: draft.position.employmentStatus,
      jobLevel: draft.position.jobLevel,
      employmentType: draft.position.employmentType,
    },
    compensation: {
      annualCtc: draft.compensation.annualCtc,
      taxRegime: draft.compensation.taxRegime,
      workCity: draft.compensation.workCity,
      professionalTaxState: draft.compensation.professionalTaxState,
      variablePayAnnual: draft.compensation.variablePayAnnual ?? 0,
      esopUnits: draft.compensation.esopUnits ?? 0,
      components: {
        basicAnnual: draft.compensation.components?.basicAnnual ?? null,
        hraAnnual: draft.compensation.components?.hraAnnual ?? null,
        specialAllowanceAnnual: draft.compensation.components?.specialAllowanceAnnual ?? null,
      },
    },
    terms: {
      probationMonths: draft.terms.probationMonths,
      noticePeriodDays: draft.terms.noticePeriodDays,
      offerValidUntil: draft.terms.offerValidUntil ? calendarDateOf(draft.terms.offerValidUntil) : null,
    },
    structure: draft.structure,
    settingsVersion: draft.settingsVersion,
    dispatch: {
      dispatchedAt: draft.dispatch?.dispatchedAt?.toISOString() ?? null,
      attempts: draft.dispatch?.attempts ?? 0,
      employeeCode: draft.dispatch?.employeeCode ?? null,
      offerLetterSha256: draft.dispatch?.offerLetterSha256 ?? null,
      lastFailureCode: draft.dispatch?.lastFailureCode ?? null,
    },
    createdAt: draft.createdAt.toISOString(),
    updatedAt: draft.updatedAt.toISOString(),
    version: draft.__v,
  };
}

/** The draft's inputs as an offer (the shape the validators and structureFor use). */
const offerOf = (draft) => ({
  candidate: draft.candidate,
  position: draft.position,
  compensation: draft.compensation,
  terms: draft.terms,
});

/** Summaries of drafts, each with its invitation's state (one query for all of them). */
async function summarize(drafts, now = new Date()) {
  const invitationIds = drafts.map((draft) => draft.dispatch?.invitationId).filter(Boolean);
  const invitations = invitationIds.length
    ? await EmployeeInvitation.find({ _id: { $in: invitationIds } })
        .select('status acceptedAt')
        .lean()
    : [];
  const invitationById = new Map(invitations.map((invitation) => [invitation._id.toString(), invitation]));
  return drafts.map((draft) =>
    toDraftSummary(draft, { invitation: invitationById.get(draft.dispatch?.invitationId?.toString()) ?? null, now }),
  );
}

const summaryOf = async (draft) => (await summarize([draft]))[0];

/** POST /create-draft */
export async function createDraft({ offer, actorUserId }) {
  const settings = await getOnboardingSettings();
  const structure = structureFor(offer, plainCompensation(settings));
  await loadPositionNames(offer.position);
  const draft = await OnboardingDraft.create({
    candidate: offer.candidate,
    position: offer.position,
    compensation: offer.compensation,
    terms: resolvedTermsOf(offer, settings),
    structure,
    settingsVersion: settings.__v,
    createdByUserId: actorUserId,
  });
  return summaryOf(draft);
}

export async function listDrafts({ status = null } = {}) {
  const filter = status ? { status } : {};
  const drafts = await OnboardingDraft.find(filter).sort({ createdAt: -1 }).limit(ONBOARDING_SETTINGS.DRAFT_LIST_LIMIT);
  return summarize(drafts);
}

async function findDraft(draftId) {
  const draft = await OnboardingDraft.findById(draftId);
  if (!draft) throw draftNotFound();
  return draft;
}

export async function getDraft(draftId) {
  return summaryOf(await findDraft(draftId));
}

/** PATCH /drafts/:id: a new version of the offer, recomputed; only while it waits for review. */
export async function updateDraft({ draftId, offer, version, actorUserId }) {
  const draft = await findDraft(draftId);
  if (draft.status !== DRAFT_STATUSES.PENDING_REVIEW) throw conflict('DRAFT_NOT_EDITABLE');
  assertCurrentVersion(draft, version);
  const settings = await getOnboardingSettings();
  const structure = structureFor(offer, plainCompensation(settings));
  await loadPositionNames(offer.position);
  draft.set({
    candidate: offer.candidate,
    position: offer.position,
    compensation: offer.compensation,
    terms: resolvedTermsOf(offer, settings),
    structure,
    settingsVersion: settings.__v,
    updatedByUserId: actorUserId,
  });
  draft.markModified('structure');
  await saveVersioned(draft);
  return summaryOf(draft);
}

/** POST /drafts/:id/cancel */
export async function cancelDraft({ draftId, version, actorUserId }) {
  const draft = await findDraft(draftId);
  if (draft.status !== DRAFT_STATUSES.PENDING_REVIEW) throw conflict('DRAFT_NOT_EDITABLE');
  assertCurrentVersion(draft, version);
  draft.set({ status: DRAFT_STATUSES.CANCELLED, cancelledByUserId: actorUserId });
  await saveVersioned(draft);
  return summaryOf(draft);
}

// =================================================================================================
// Dispatch
// =================================================================================================

/** Moves a dispatchable draft to DISPATCHING in one step; returns it as it was before. */
async function claimForDispatch(draftId) {
  const claimed = await OnboardingDraft.findOneAndUpdate(
    { _id: draftId, status: { $in: DISPATCHABLE_STATUSES } },
    { $set: { status: DRAFT_STATUSES.DISPATCHING }, $inc: { 'dispatch.attempts': 1 } },
    { new: false },
  );
  if (claimed) return claimed;
  const existing = await OnboardingDraft.findById(draftId).select('status').lean();
  if (!existing) throw draftNotFound();
  throw conflict(existing.status === DRAFT_STATUSES.DISPATCHING ? 'DISPATCH_IN_PROGRESS' : 'DISPATCH_NOT_ALLOWED');
}

/** Puts a claimed draft back to the status it had, when the dispatch stops before any email. */
async function releaseClaim(draftId, previousStatus) {
  await OnboardingDraft.updateOne(
    { _id: draftId, status: DRAFT_STATUSES.DISPATCHING },
    { $set: { status: previousStatus }, $inc: { 'dispatch.attempts': -1 } },
  );
}

/** The invitation input for the employee this offer creates. */
const invitationInputOf = (draft) => ({
  name: draft.candidate.name,
  email: draft.candidate.personalEmail,
  companyEmail: draft.candidate.companyEmail ?? null,
  role: draft.position.role,
  profileDraft: {
    designation: draft.position.designation,
    departmentId: draft.position.departmentId.toString(),
    reportingManagerId: draft.position.reportingManagerId?.toString() ?? null,
    workLocationType: draft.position.workLocationType,
    dateOfJoining: draft.position.dateOfJoining,
    employmentStatus: draft.position.employmentStatus,
    jobLevel: draft.position.jobLevel,
    employmentType: draft.position.employmentType,
  },
});

/** The filename of the letter: "Offer-letter-Asha-Rao.pdf". */
const letterFilenameOf = (candidateName) =>
  `Offer-letter-${candidateName.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '')}.pdf`;

/**
 * POST /drafts/:id/dispatch
 * @param {{ draftId: string, actor: { id: string, name: string, role: string },
 *   appContext: { companyName: string, appPublicUrl: string }, now?: Date }} request
 */
export async function dispatchDraft({ draftId, actor, appContext, now = new Date() }) {
  // A plain copy of the draft as it was claimed (Mongoose sub-documents do not spread as plain data).
  const before = (await claimForDispatch(draftId)).toObject();
  const previousStatus = before.status;
  let letter;
  let rendered;
  try {
    const settings = await getOnboardingSettings();
    if (!settings.offerTerms.signatoryName) throw conflict('SIGNATORY_MISSING');
    if (before.terms?.offerValidUntil && calendarDateOf(before.terms.offerValidUntil) < calendarDateOf(now)) {
      throw conflict('OFFER_EXPIRED');
    }
    const structure = structureFor(offerOf(before), plainCompensation(settings));
    // The figures must be the ones that were reviewed.
    if (!isDeepStrictEqual(structure, before.structure)) throw conflict('DRAFT_FIGURES_CHANGED');
    letter = await letterFor(offerOf(before), structure, settings, now);
    rendered = await renderLetter(letter, { preview: false, dateOfBirth: before.candidate.dateOfBirth });
  } catch (preparationError) {
    await releaseClaim(draftId, previousStatus);
    throw preparationError;
  }

  const filename = letterFilenameOf(before.candidate.name);
  const composeEmail = async ({ invitation, inviteUrl, companyName }) => ({
    ...buildOfferEmail({
      candidateName: before.candidate.name,
      companyName,
      designation: before.position.designation,
      dateOfJoining: before.position.dateOfJoining,
      employeeCode: invitation.employeeCode ?? null,
      activationUrl: inviteUrl,
      expiresAt: invitation.expiresAt,
      letterFilename: filename,
      timeZone: letter.companyTimeZone,
    }),
    attachments: [{ filename, content: rendered.pdf, contentType: PDF_MEDIA_TYPE }],
  });

  let sent;
  try {
    // The link works until the end of the deadline day, in the company's time zone.
    const linkExpiresAt = localDayStart(addDaysToCalendarDate(letter.deadlineDate, 1), letter.companyTimeZone);
    const request = { inviter: actor, appContext, expiresAt: linkExpiresAt, composeEmail };
    sent = before.dispatch?.invitationId
      ? await resendInvitation({ ...request, invitationId: before.dispatch.invitationId.toString() })
      : await createInvitation({ ...request, input: invitationInputOf(before) });
  } catch (invitationError) {
    await releaseClaim(draftId, previousStatus);
    if (invitationError instanceof InvitationError) {
      throw new ServiceError(invitationError.httpStatus, invitationError.code, invitationError.message);
    }
    throw invitationError;
  }

  const wasSent = sent.delivery.outcome === MAIL_OUTCOMES.SENT;
  const draft = await OnboardingDraft.findOneAndUpdate(
    { _id: draftId, status: DRAFT_STATUSES.DISPATCHING },
    {
      $set: {
        status: wasSent ? DRAFT_STATUSES.DISPATCHED : DRAFT_STATUSES.DISPATCH_FAILED,
        'dispatch.dispatchedByUserId': actor.id,
        'dispatch.dispatchedAt': wasSent ? now : null,
        'dispatch.invitationId': sent.invitation._id,
        'dispatch.employeeUserId': sent.invitation.invitedUserId,
        'dispatch.employeeCode': sent.invitation.employeeCode ?? null,
        'dispatch.offerLetterSha256': rendered.sha256,
        'dispatch.lastFailureCode': wasSent ? null : sent.delivery.outcome,
      },
    },
    { new: true },
  );
  return { draft: await summaryOf(draft), wasSent };
}
