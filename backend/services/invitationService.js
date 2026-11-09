/**
 * Employee onboarding by invitation (models/EmployeeInvitation.js).
 *
 *   HR/admin                                   invitee
 *   ─────────                                  ───────
 *   createInvitation ─► invited User +         previewInvitation (link opened: who invited me, as what)
 *                       EmployeeProfile (ID)   acceptInvitation  (password chosen) ─► account active,
 *                       ──email──►                                                    signed in
 *   resendInvitation    new link, old ones stop working
 *   revokeInvitation    account disabled, profile terminated (inviting them again reuses both)
 *
 * The account and profile exist from the invitation on (services/employeeProvisioning.js), so HR
 * sees the person, with their employee ID, before they join; the account cannot sign in until the
 * person chooses a password through the link.
 *
 * Who may invite whom (constants/accessRoles.js INVITATION_GRANTS): HR invites employees and support
 * agents; admins also HR, Finance & Payroll and IT administrators. Nobody becomes an admin by invitation.
 *
 * Accepting is made safe against double use without transactions:
 *   1. claim:     findOneAndUpdate pending+unexpired -> "accepting" (atomic; a second tab gets nothing)
 *   2. activate:  the invited account gets the password and becomes active
 *   3. finish:    "accepted" with the user id
 *   A failure in step 2 puts the invitation back to "pending", so the person can retry the same link.
 *   Invitations sent before accounts were created up front have no invited account: accepting one
 *   creates the account and profile as it always did, deleting both again if either fails.
 *
 * Email: the link is `${APP_PUBLIC_URL}/invite/<token>`. When email is not configured, or the mail
 * server refuses, the link is returned to the inviting HR user (and only then) so they can share it
 * another way; the invitation is still created.
 */

import Department from '../models/Department.js';
import EmployeeInvitation, { INVITATION_LIMITS, INVITATION_STATUSES } from '../models/EmployeeInvitation.js';
import EmployeeProfile, { EMPLOYMENT_STATUSES } from '../models/EmployeeProfile.js';
import {
  DEFAULT_EMPLOYMENT_TYPE,
  DEFAULT_JOB_LEVEL,
  EMPLOYMENT_TYPE_DEFINITIONS,
  INVITATION_GRANTS,
  JOB_LEVEL_DEFINITIONS,
  ROLE_DEFINITIONS,
  ROLES,
} from '../constants/accessRoles.js';
import User, { ACCOUNT_STATUSES } from '../models/User.js';
import { logger } from '../utils/logger.js';
import { issueEmployeeCode } from './companySettings.js';
import { listCurrentEmployees } from './employeeDirectory.js';
import {
  acceptedInvitationFields,
  activateInvitedAccount,
  findInvitableAccount,
  ProvisioningError,
  provisionInvitedEmployee,
  reopenInvitedEmployee,
  undoProvisioning,
  withdrawInvitedEmployee,
} from './employeeProvisioning.js';
import { discardUnverifiedAccount } from './accountEmailFlows.js';
import { buildInvitationEmail } from './invitationEmail.js';
import { MAIL_OUTCOMES, sendMail } from './mailService.js';
import { isDuplicateKeyError } from '../utils/mongoErrors.js';
import { createSecureToken, hashSecureToken, isWellFormedSecureToken } from '../utils/secureTokens.js';

export class InvitationError extends Error {
  constructor(httpStatus, code, message) {
    super(message);
    this.name = 'InvitationError';
    this.httpStatus = httpStatus;
    this.code = code;
  }
}

/** Display status: an unexpired "pending" is pending; an expired one is "expired". */
export const INVITATION_DISPLAY_STATUSES = Object.freeze(['pending', 'expired', 'accepted', 'revoked']);

const DAY_MS = 24 * 60 * 60 * 1000;
const INVITATION_VALIDITY_MS = INVITATION_LIMITS.VALIDITY_DAYS * DAY_MS;

/** Roles each inviter role may grant (constants/accessRoles.js INVITATION_GRANTS); none for anyone else. */
export function invitableRolesFor(inviterRole) {
  return [...(INVITATION_GRANTS[inviterRole] ?? [])];
}

function displayStatusOf(invitation, now = new Date()) {
  if (invitation.status === INVITATION_STATUSES.ACCEPTING) return 'pending';
  if (invitation.status === INVITATION_STATUSES.PENDING && invitation.expiresAt <= now) return 'expired';
  return invitation.status;
}

export function toInvitationSummary(invitation, { departmentNames = new Map(), managerNames = new Map() } = {}) {
  const draft = invitation.profileDraft;
  return {
    id: invitation._id.toString(),
    email: invitation.email,
    name: invitation.name,
    role: invitation.role,
    employeeCode: invitation.employeeCode ?? null,
    status: displayStatusOf(invitation),
    designation: draft.designation,
    department: { id: draft.departmentId.toString(), name: departmentNames.get(draft.departmentId.toString()) ?? null },
    reportingManager: draft.reportingManagerId
      ? { id: draft.reportingManagerId.toString(), name: managerNames.get(draft.reportingManagerId.toString()) ?? null }
      : null,
    workLocationType: draft.workLocationType,
    dateOfJoining: draft.dateOfJoining.toISOString().slice(0, 10),
    employmentStatus: draft.employmentStatus,
    jobLevel: draft.jobLevel ?? DEFAULT_JOB_LEVEL,
    employmentType: draft.employmentType ?? DEFAULT_EMPLOYMENT_TYPE,
    expiresAt: invitation.expiresAt.toISOString(),
    sendCount: invitation.sendCount,
    lastSentAt: invitation.lastSentAt.toISOString(),
    lastDeliveryOutcome: invitation.lastDelivery?.outcome ?? null,
    acceptedAt: invitation.acceptedAt ? invitation.acceptedAt.toISOString() : null,
    createdAt: invitation.createdAt.toISOString(),
  };
}

// =================================================================================================
// Form options and reference checks
// =================================================================================================

/** Dropdown data for the invite form. */
export async function loadInvitationFormOptions(inviterRole) {
  const [departments, employees] = await Promise.all([
    Department.find({ isActive: { $ne: false } })
      .select('name code')
      .sort({ name: 1 })
      .lean(),
    listCurrentEmployees(),
  ]);
  return {
    departments: departments.map((department) => ({
      id: department._id.toString(),
      name: department.name,
      code: department.code,
    })),
    managers: employees,
    roles: invitableRolesFor(inviterRole),
    // The same roles with their labels and groups, in order (constants/accessRoles.js), and the job
    // levels and employment types an employee record takes, for the form's grouped dropdowns.
    roleOptions: ROLE_DEFINITIONS.filter((definition) => invitableRolesFor(inviterRole).includes(definition.value)),
    jobLevels: JOB_LEVEL_DEFINITIONS,
    employmentTypes: EMPLOYMENT_TYPE_DEFINITIONS,
    defaults: { role: ROLES.EMPLOYEE, jobLevel: DEFAULT_JOB_LEVEL, employmentType: DEFAULT_EMPLOYMENT_TYPE },
    workLocationTypes: ['Onsite', 'Hybrid', 'Remote'],
    employmentStatuses: [EMPLOYMENT_STATUSES.PROBATION, EMPLOYMENT_STATUSES.ACTIVE],
    validityDays: INVITATION_LIMITS.VALIDITY_DAYS,
  };
}

async function assertDraftReferences(profileDraft) {
  const department = await Department.findById(profileDraft.departmentId).select('isActive').lean();
  if (!department) {
    throw new InvitationError(400, 'DEPARTMENT_NOT_FOUND', 'The selected department no longer exists');
  }
  if (department.isActive === false) {
    throw new InvitationError(400, 'DEPARTMENT_INACTIVE', 'The selected department is no longer active');
  }
  if (profileDraft.reportingManagerId) {
    const manager = await EmployeeProfile.findById(profileDraft.reportingManagerId)
      .select('organizationData.employmentStatus')
      .lean();
    if (!manager || manager.organizationData.employmentStatus === EMPLOYMENT_STATUSES.TERMINATED) {
      throw new InvitationError(400, 'MANAGER_NOT_FOUND', 'The selected reporting manager is not a current employee');
    }
  }
}

// =================================================================================================
// Delivery
// =================================================================================================

/** The standard invitation email (services/invitationEmail.js). */
async function composeInvitationEmail({ invitation, inviteUrl, inviterName, companyName, companyEmail }) {
  const department = await Department.findById(invitation.profileDraft.departmentId).select('name').lean();
  return buildInvitationEmail({
    inviteeName: invitation.name,
    inviterName,
    companyName,
    designation: invitation.profileDraft.designation,
    departmentName: department?.name ?? null,
    employeeCode: invitation.employeeCode ?? null,
    companyEmail,
    inviteUrl,
    expiresAt: invitation.expiresAt,
  });
}

/**
 * Sends the invitation and records how it went. `composeEmail` builds the message from the
 * invitation, its link and the context (default: the standard invitation email); it may return
 * `attachments` (an offer letter, for one).
 */
async function deliverInvitation(invitation, rawToken, context, composeEmail = composeInvitationEmail) {
  const inviteUrl = `${context.appPublicUrl}/invite/${rawToken}`;
  const email = await composeEmail({ invitation, inviteUrl, ...context });
  const { outcome } = await sendMail({ to: invitation.email, ...email });
  invitation.lastDelivery = { outcome, at: new Date() };
  await invitation.save();
  // The link is handed back only when it did not go out by email (see the module comment).
  return { outcome, inviteUrl: outcome === MAIL_OUTCOMES.SENT ? null : inviteUrl };
}

// =================================================================================================
// HR operations
// =================================================================================================

/**
 * @param {{ inviter: { id: string, name: string, role: string }, input: object,
 *   appContext: { companyName: string, appPublicUrl: string }, validityMs?: number,
 *   composeEmail?: Function }} request
 *   validityMs: how long the link works (default INVITATION_LIMITS.VALIDITY_DAYS); composeEmail:
 *   the email to send instead of the standard invitation (see deliverInvitation)
 */
export async function createInvitation({
  inviter,
  input,
  appContext,
  validityMs = INVITATION_VALIDITY_MS,
  composeEmail = composeInvitationEmail,
}) {
  if (!invitableRolesFor(inviter.role).includes(input.role)) {
    throw new InvitationError(403, 'ROLE_NOT_ALLOWED', 'You cannot invite someone with this role');
  }
  const reopenableAccount = await withInvitationErrors(() => findInvitableAccount(input.email));
  await assertDraftReferences(input.profileDraft);

  const openInvitation = await EmployeeInvitation.findOne({
    email: input.email,
    status: { $in: [INVITATION_STATUSES.PENDING, INVITATION_STATUSES.ACCEPTING] },
  });
  if (openInvitation) {
    if (openInvitation.isUsable())
      throw new InvitationError(
        409,
        'INVITATION_EXISTS',
        'This person already has an open invitation; resend it instead',
      );
    // An expired invitation should not block a fresh one.
    openInvitation.status = INVITATION_STATUSES.REVOKED;
    openInvitation.revokedAt = new Date();
    openInvitation.revokedByUserId = inviter.id;
    await openInvitation.save();
  }

  const employeeDetails = { name: input.name, role: input.role, profileDraft: input.profileDraft };
  const provisioned = reopenableAccount
    ? { ...(await reopenInvitedEmployee({ userId: reopenableAccount._id, ...employeeDetails })), wasReopened: true }
    : {
        ...(await withInvitationErrors(() =>
          provisionInvitedEmployee({ ...employeeDetails, email: input.email, companyEmail: input.companyEmail }),
        )),
        wasReopened: false,
      };

  const { rawToken, tokenHash } = createSecureToken();
  const now = new Date();
  let invitation;
  try {
    invitation = await EmployeeInvitation.create({
      email: input.email,
      name: input.name,
      role: input.role,
      profileDraft: input.profileDraft,
      invitedUserId: provisioned.user._id,
      employeeCode: provisioned.profile.employeeCode,
      tokenHash,
      expiresAt: new Date(now.getTime() + validityMs),
      invitedByUserId: inviter.id,
      lastSentAt: now,
      lastDelivery: { outcome: MAIL_OUTCOMES.NOT_CONFIGURED, at: now },
    });
  } catch (creationError) {
    await undoProvisioning(provisioned);
    // Two HR users inviting the same email at the same moment: the partial unique index decides.
    if (isDuplicateKeyError(creationError))
      throw new InvitationError(
        409,
        'INVITATION_EXISTS',
        'This person already has an open invitation; resend it instead',
      );
    throw creationError;
  }
  const delivery = await deliverInvitation(
    invitation,
    rawToken,
    { inviterName: inviter.name, companyEmail: provisioned.user.companyEmail, ...appContext },
    composeEmail,
  );
  return { invitation, delivery };
}

/** Runs a provisioning step, turning its refusals into the invitation errors the API returns. */
async function withInvitationErrors(provisioningStep) {
  try {
    return await provisioningStep();
  } catch (stepError) {
    if (stepError instanceof ProvisioningError) throw new InvitationError(409, stepError.code, stepError.message);
    throw stepError;
  }
}

/** Whether the person behind an open invitation could still use it (they have not signed up meanwhile). */
async function assertInviteeStillInvited(invitation) {
  const accountTaken = invitation.invitedUserId
    ? !(await User.exists({ _id: invitation.invitedUserId, status: ACCOUNT_STATUSES.INVITED }))
    : await User.exists({ email: invitation.email });
  if (accountTaken)
    throw new InvitationError(409, 'EMAIL_ALREADY_REGISTERED', 'Someone with this email already has an account');
}

/**
 * New link (old links stop working), fresh expiry, email sent again. Pending or expired only.
 * `validityMs` and `composeEmail` as for createInvitation.
 */
export async function resendInvitation({
  invitationId,
  inviter,
  appContext,
  validityMs = INVITATION_VALIDITY_MS,
  composeEmail = composeInvitationEmail,
}) {
  const invitation = await EmployeeInvitation.findById(invitationId).select('+tokenHash');
  if (!invitation) throw new InvitationError(404, 'INVITATION_NOT_FOUND', 'Invitation not found');
  if (invitation.status !== INVITATION_STATUSES.PENDING)
    throw new InvitationError(409, 'INVITATION_CLOSED', 'Only open invitations can be resent');
  if (!invitableRolesFor(inviter.role).includes(invitation.role))
    throw new InvitationError(403, 'ROLE_NOT_ALLOWED', 'You cannot manage invitations for this role');
  await assertInviteeStillInvited(invitation);

  const { rawToken, tokenHash } = createSecureToken();
  const now = new Date();
  invitation.tokenHash = tokenHash;
  invitation.expiresAt = new Date(now.getTime() + validityMs);
  invitation.sendCount += 1;
  invitation.lastSentAt = now;
  const invitee = invitation.invitedUserId
    ? await User.findById(invitation.invitedUserId).select('companyEmail').lean()
    : null;
  const delivery = await deliverInvitation(
    invitation,
    rawToken,
    {
      inviterName: inviter.name,
      companyEmail: invitee?.companyEmail ?? null,
      ...appContext,
    },
    composeEmail,
  );
  return { invitation, delivery };
}

export async function revokeInvitation({ invitationId, inviter }) {
  const invitation = await EmployeeInvitation.findById(invitationId);
  if (!invitation) throw new InvitationError(404, 'INVITATION_NOT_FOUND', 'Invitation not found');
  if (invitation.status !== INVITATION_STATUSES.PENDING)
    throw new InvitationError(409, 'INVITATION_CLOSED', 'This invitation is no longer open');
  if (!invitableRolesFor(inviter.role).includes(invitation.role))
    throw new InvitationError(403, 'ROLE_NOT_ALLOWED', 'You cannot manage invitations for this role');
  invitation.status = INVITATION_STATUSES.REVOKED;
  invitation.revokedAt = new Date();
  invitation.revokedByUserId = inviter.id;
  await invitation.save();
  if (invitation.invitedUserId) await withdrawInvitedEmployee(invitation.invitedUserId);
  return invitation;
}

/** Newest first, optionally filtered by display status. */
export async function listInvitations({ status }) {
  const now = new Date();
  const statusFilter =
    {
      pending: {
        status: { $in: [INVITATION_STATUSES.PENDING, INVITATION_STATUSES.ACCEPTING] },
        expiresAt: { $gt: now },
      },
      expired: { status: INVITATION_STATUSES.PENDING, expiresAt: { $lte: now } },
      accepted: { status: INVITATION_STATUSES.ACCEPTED },
      revoked: { status: INVITATION_STATUSES.REVOKED },
    }[status] ?? {};
  const invitations = await EmployeeInvitation.find(statusFilter)
    .sort({ createdAt: -1 })
    .limit(INVITATION_LIMITS.LIST_LIMIT);
  const departmentIds = [...new Set(invitations.map((invitation) => invitation.profileDraft.departmentId.toString()))];
  const managerIds = [
    ...new Set(invitations.map((invitation) => invitation.profileDraft.reportingManagerId?.toString()).filter(Boolean)),
  ];
  const [departments, managers] = await Promise.all([
    Department.find({ _id: { $in: departmentIds } })
      .select('name')
      .lean(),
    EmployeeProfile.find({ _id: { $in: managerIds } })
      .select('userId')
      .lean(),
  ]);
  const managerAccounts = await User.find({ _id: { $in: managers.map((manager) => manager.userId) } })
    .select('name')
    .lean();
  const accountNames = new Map(managerAccounts.map((account) => [account._id.toString(), account.name]));
  const lookups = {
    departmentNames: new Map(departments.map((department) => [department._id.toString(), department.name])),
    managerNames: new Map(
      managers.map((manager) => [manager._id.toString(), accountNames.get(manager.userId.toString()) ?? null]),
    ),
  };
  return invitations.map((invitation) => toInvitationSummary(invitation, lookups));
}

// =================================================================================================
// Invitee operations (public, by token)
// =================================================================================================

async function findInvitationByToken(rawToken) {
  if (!isWellFormedSecureToken(rawToken)) return null;
  return EmployeeInvitation.findOne({ tokenHash: hashSecureToken(rawToken) });
}

function assertUsable(invitation) {
  if (!invitation || invitation.status === INVITATION_STATUSES.REVOKED)
    throw new InvitationError(404, 'INVITATION_INVALID', 'This invitation link is not valid. Ask HR for a new one.');
  if (invitation.status === INVITATION_STATUSES.ACCEPTED)
    throw new InvitationError(
      410,
      'INVITATION_USED',
      'This invitation has already been used. Sign in with your email and password.',
    );
  if (invitation.status === INVITATION_STATUSES.ACCEPTING)
    throw new InvitationError(409, 'INVITATION_IN_PROGRESS', 'This invitation is being activated in another window.');
  if (invitation.expiresAt <= new Date())
    throw new InvitationError(410, 'INVITATION_EXPIRED', 'This invitation has expired. Ask HR to send a new one.');
}

/** What the accept page shows before the person sets a password. */
export async function previewInvitation(rawToken, { companyName }) {
  const invitation = await findInvitationByToken(rawToken);
  assertUsable(invitation);
  const [department, inviter] = await Promise.all([
    Department.findById(invitation.profileDraft.departmentId).select('name').lean(),
    User.findById(invitation.invitedByUserId).select('name').lean(),
  ]);
  return {
    name: invitation.name,
    email: invitation.email,
    companyName,
    designation: invitation.profileDraft.designation,
    departmentName: department?.name ?? null,
    // Who sent it and the ID issued with it, so the person recognises a genuine invitation.
    inviterName: inviter?.name ?? null,
    employeeCode: invitation.employeeCode ?? null,
    expiresAt: invitation.expiresAt.toISOString(),
  };
}

/** Activates the invited account with the chosen password. Returns the User document. */
export async function acceptInvitation(rawToken, password) {
  const invitation = await findInvitationByToken(rawToken);
  assertUsable(invitation);

  // Step 1: claim atomically.
  const claimedInvitation = await EmployeeInvitation.findOneAndUpdate(
    { _id: invitation._id, status: INVITATION_STATUSES.PENDING, expiresAt: { $gt: new Date() } },
    { $set: { status: INVITATION_STATUSES.ACCEPTING } },
    { new: true },
  );
  if (!claimedInvitation)
    throw new InvitationError(409, 'INVITATION_IN_PROGRESS', 'This invitation is being activated in another window.');

  return claimedInvitation.invitedUserId
    ? activateClaimedInvitation(claimedInvitation, password)
    : acceptLegacyInvitation(claimedInvitation, password);
}

const releaseClaim = (claimedInvitation) =>
  EmployeeInvitation.updateOne(
    { _id: claimedInvitation._id, status: INVITATION_STATUSES.ACCEPTING },
    { $set: { status: INVITATION_STATUSES.PENDING } },
  );

/** Steps 2 and 3 for an invitation whose account was created with it. */
async function activateClaimedInvitation(claimedInvitation, password) {
  let activatedUser;
  try {
    activatedUser = await activateInvitedAccount(claimedInvitation.invitedUserId, password);
  } catch (activationError) {
    await releaseClaim(claimedInvitation);
    throw activationError;
  }
  if (!activatedUser) {
    // The account was disabled or activated some other way since the link was sent.
    await releaseClaim(claimedInvitation);
    throw new InvitationError(404, 'INVITATION_INVALID', 'This invitation link is not valid. Ask HR for a new one.');
  }
  await EmployeeInvitation.updateOne(
    { _id: claimedInvitation._id },
    { $set: { status: INVITATION_STATUSES.ACCEPTED, acceptedUserId: activatedUser._id, acceptedAt: new Date() } },
  );
  return activatedUser;
}

/** Steps 2 and 3 for an invitation sent before accounts were created with it: create both now. */
async function acceptLegacyInvitation(claimedInvitation, password) {
  let createdUser = null;
  let createdProfileId = null;
  try {
    // Step 2: account, then profile. An unconfirmed signup with this address gives way to the invitation.
    await discardUnverifiedAccount(claimedInvitation.email);
    if (await User.exists({ email: claimedInvitation.email })) {
      throw new InvitationError(
        409,
        'EMAIL_ALREADY_REGISTERED',
        'An account with this email already exists. Sign in instead, or ask HR for help.',
      );
    }
    createdUser = await User.create({
      name: claimedInvitation.name,
      email: claimedInvitation.email,
      password,
      role: claimedInvitation.role,
      ...acceptedInvitationFields(),
    });
    const draft = claimedInvitation.profileDraft;
    const createdProfile = await EmployeeProfile.create({
      userId: createdUser._id,
      employeeCode: await issueEmployeeCode(),
      organizationData: {
        designation: draft.designation,
        departmentId: draft.departmentId,
        reportingManagerId: draft.reportingManagerId,
        workLocationType: draft.workLocationType,
        dateOfJoining: draft.dateOfJoining,
        employmentStatus: draft.employmentStatus,
      },
    });

    createdProfileId = createdProfile._id;

    // Step 3: finish.
    await EmployeeInvitation.updateOne(
      { _id: claimedInvitation._id },
      { $set: { status: INVITATION_STATUSES.ACCEPTED, acceptedUserId: createdUser._id, acceptedAt: new Date() } },
    );
    return createdUser;
  } catch (acceptError) {
    if (createdProfileId)
      await EmployeeProfile.deleteOne({ _id: createdProfileId }).catch((cleanupError) =>
        logger.error('Invitation rollback could not delete profile', {
          profileId: createdProfileId.toString(),
          error: cleanupError.message,
        }),
      );
    if (createdUser)
      await User.deleteOne({ _id: createdUser._id }).catch((cleanupError) =>
        logger.error('Invitation rollback could not delete user', {
          userId: createdUser._id.toString(),
          error: cleanupError.message,
        }),
      );
    await releaseClaim(claimedInvitation);
    if (acceptError instanceof InvitationError) throw acceptError;
    if (isDuplicateKeyError(acceptError))
      throw new InvitationError(
        409,
        'EMAIL_ALREADY_REGISTERED',
        'An account with this email already exists. Sign in instead, or ask HR for help.',
      );
    if (acceptError?.name === 'ValidationError') {
      logger.warn('Invitation profile no longer valid', {
        invitationId: claimedInvitation._id.toString(),
        error: acceptError.message.slice(0, 200),
      });
      throw new InvitationError(
        409,
        'INVITATION_OUTDATED',
        'Your invitation details changed (department or manager). Ask HR to send a new invitation.',
      );
    }
    throw acceptError;
  }
}
