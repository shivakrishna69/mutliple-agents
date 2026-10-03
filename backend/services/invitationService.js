/**
 * Employee onboarding by invitation (models/EmployeeInvitation.js).
 *
 *   HR/admin                      invitee (no account yet)
 *   ─────────                     ───────────────────────
 *   createInvitation  ──email──►  previewInvitation (link opened: who invited me, as what)
 *   resendInvitation              acceptInvitation  (password chosen) ─► User + EmployeeProfile,
 *   revokeInvitation                                                     signed in
 *
 * Who may invite whom: HR and admins invite employees (role "customer") and support agents;
 * only admins invite HR. Nobody becomes an admin by invitation.
 *
 * Accepting is made safe against double use without transactions:
 *   1. claim:   findOneAndUpdate pending+unexpired -> "accepting" (atomic; a second tab gets nothing)
 *   2. create:  User, then EmployeeProfile (the profile's own validation re-checks department and
 *               manager)
 *   3. finish:  "accepted" with the new user id
 *   A failure in step 2 deletes whatever step 2 created and puts the invitation back to "pending",
 *   so the person can simply retry the same link.
 *
 * Email: the link is `${APP_PUBLIC_URL}/invite/<token>`. When email is not configured, or the mail
 * server refuses, the link is returned to the inviting HR user (and only then) so they can share it
 * another way; the invitation is still created.
 */

import { createHash, randomBytes } from 'node:crypto';
import Department from '../models/Department.js';
import EmployeeInvitation, { INVITABLE_ROLES, INVITATION_LIMITS, INVITATION_STATUSES } from '../models/EmployeeInvitation.js';
import EmployeeProfile, { EMPLOYMENT_STATUSES } from '../models/EmployeeProfile.js';
import User, { ROLES } from '../models/User.js';
import { logger } from '../utils/logger.js';
import { buildInvitationEmail } from './invitationEmail.js';
import { MAIL_OUTCOMES, sendMail } from './mailService.js';

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

/** Roles each inviter role may grant. */
export function invitableRolesFor(inviterRole) {
  if (inviterRole === ROLES.ADMIN) return [...INVITABLE_ROLES];
  if (inviterRole === ROLES.HR) return INVITABLE_ROLES.filter((invitableRole) => invitableRole !== ROLES.HR);
  return [];
}

export const hashInvitationToken = (rawToken) => createHash('sha256').update(rawToken, 'utf8').digest('hex');

function newInvitationToken() {
  const rawToken = randomBytes(INVITATION_LIMITS.TOKEN_BYTES).toString('base64url');
  return { rawToken, tokenHash: hashInvitationToken(rawToken) };
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
    status: displayStatusOf(invitation),
    designation: draft.designation,
    department: { id: draft.departmentId.toString(), name: departmentNames.get(draft.departmentId.toString()) ?? null },
    reportingManager: draft.reportingManagerId ? { id: draft.reportingManagerId.toString(), name: managerNames.get(draft.reportingManagerId.toString()) ?? null } : null,
    workLocationType: draft.workLocationType,
    dateOfJoining: draft.dateOfJoining.toISOString().slice(0, 10),
    employmentStatus: draft.employmentStatus,
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

/** Current employees as { employeeId, name, designation, departmentId }, sorted by name. */
async function loadCurrentEmployees() {
  const profiles = await EmployeeProfile.find({ 'organizationData.employmentStatus': { $ne: EMPLOYMENT_STATUSES.TERMINATED } })
    .select('userId organizationData.designation organizationData.departmentId')
    .lean();
  const accounts = await User.find({ _id: { $in: profiles.map((profile) => profile.userId) } }).select('name').lean();
  const nameByUserId = new Map(accounts.map((account) => [account._id.toString(), account.name]));
  return profiles
    .map((profile) => ({
      employeeId: profile._id.toString(),
      name: nameByUserId.get(profile.userId.toString()) ?? 'Unnamed',
      designation: profile.organizationData.designation,
      departmentId: profile.organizationData.departmentId?.toString() ?? null,
    }))
    .sort((first, second) => first.name.localeCompare(second.name));
}

/** Dropdown data for the invite form. */
export async function loadInvitationFormOptions(inviterRole) {
  const [departments, employees] = await Promise.all([Department.find().select('name code').sort({ name: 1 }).lean(), loadCurrentEmployees()]);
  return {
    departments: departments.map((department) => ({ id: department._id.toString(), name: department.name, code: department.code })),
    managers: employees,
    roles: invitableRolesFor(inviterRole),
    workLocationTypes: ['Onsite', 'Hybrid', 'Remote'],
    employmentStatuses: [EMPLOYMENT_STATUSES.PROBATION, EMPLOYMENT_STATUSES.ACTIVE],
    validityDays: INVITATION_LIMITS.VALIDITY_DAYS,
  };
}

async function assertDraftReferences(profileDraft) {
  if (!(await Department.exists({ _id: profileDraft.departmentId }))) {
    throw new InvitationError(400, 'DEPARTMENT_NOT_FOUND', 'The selected department no longer exists');
  }
  if (profileDraft.reportingManagerId) {
    const manager = await EmployeeProfile.findById(profileDraft.reportingManagerId).select('organizationData.employmentStatus').lean();
    if (!manager || manager.organizationData.employmentStatus === EMPLOYMENT_STATUSES.TERMINATED) {
      throw new InvitationError(400, 'MANAGER_NOT_FOUND', 'The selected reporting manager is not a current employee');
    }
  }
}

// =================================================================================================
// Delivery
// =================================================================================================

async function deliverInvitation(invitation, rawToken, { inviterName, companyName, appPublicUrl }) {
  const inviteUrl = `${appPublicUrl}/invite/${rawToken}`;
  const department = await Department.findById(invitation.profileDraft.departmentId).select('name').lean();
  const email = buildInvitationEmail({
    inviteeName: invitation.name,
    inviterName,
    companyName,
    designation: invitation.profileDraft.designation,
    departmentName: department?.name ?? null,
    inviteUrl,
    expiresAt: invitation.expiresAt,
  });
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
 * @param {{ inviter: { id: string, name: string, role: string }, input: object, appContext: { companyName: string, appPublicUrl: string } }} request
 */
export async function createInvitation({ inviter, input, appContext }) {
  if (!invitableRolesFor(inviter.role).includes(input.role)) {
    throw new InvitationError(403, 'ROLE_NOT_ALLOWED', 'You cannot invite someone with this role');
  }
  if (await User.exists({ email: input.email })) {
    throw new InvitationError(409, 'EMAIL_ALREADY_REGISTERED', 'Someone with this email already has an account');
  }
  await assertDraftReferences(input.profileDraft);

  const openInvitation = await EmployeeInvitation.findOne({ email: input.email, status: { $in: [INVITATION_STATUSES.PENDING, INVITATION_STATUSES.ACCEPTING] } });
  if (openInvitation) {
    if (openInvitation.isUsable()) throw new InvitationError(409, 'INVITATION_EXISTS', 'This person already has an open invitation; resend it instead');
    // An expired invitation should not block a fresh one.
    openInvitation.status = INVITATION_STATUSES.REVOKED;
    openInvitation.revokedAt = new Date();
    openInvitation.revokedByUserId = inviter.id;
    await openInvitation.save();
  }

  const { rawToken, tokenHash } = newInvitationToken();
  const now = new Date();
  let invitation;
  try {
    invitation = await EmployeeInvitation.create({
      email: input.email,
      name: input.name,
      role: input.role,
      profileDraft: input.profileDraft,
      tokenHash,
      expiresAt: new Date(now.getTime() + INVITATION_LIMITS.VALIDITY_DAYS * DAY_MS),
      invitedByUserId: inviter.id,
      lastSentAt: now,
      lastDelivery: { outcome: MAIL_OUTCOMES.NOT_CONFIGURED, at: now },
    });
  } catch (creationError) {
    // Two HR users inviting the same email at the same moment: the partial unique index decides.
    if (creationError?.code === 11000) throw new InvitationError(409, 'INVITATION_EXISTS', 'This person already has an open invitation; resend it instead');
    throw creationError;
  }
  const delivery = await deliverInvitation(invitation, rawToken, { inviterName: inviter.name, ...appContext });
  return { invitation, delivery };
}

/** New link (old links stop working), fresh expiry, email sent again. Pending or expired only. */
export async function resendInvitation({ invitationId, inviter, appContext }) {
  const invitation = await EmployeeInvitation.findById(invitationId).select('+tokenHash');
  if (!invitation) throw new InvitationError(404, 'INVITATION_NOT_FOUND', 'Invitation not found');
  if (invitation.status !== INVITATION_STATUSES.PENDING) throw new InvitationError(409, 'INVITATION_CLOSED', 'Only open invitations can be resent');
  if (!invitableRolesFor(inviter.role).includes(invitation.role)) throw new InvitationError(403, 'ROLE_NOT_ALLOWED', 'You cannot manage invitations for this role');
  if (await User.exists({ email: invitation.email })) throw new InvitationError(409, 'EMAIL_ALREADY_REGISTERED', 'Someone with this email already has an account');

  const { rawToken, tokenHash } = newInvitationToken();
  const now = new Date();
  invitation.tokenHash = tokenHash;
  invitation.expiresAt = new Date(now.getTime() + INVITATION_LIMITS.VALIDITY_DAYS * DAY_MS);
  invitation.sendCount += 1;
  invitation.lastSentAt = now;
  const delivery = await deliverInvitation(invitation, rawToken, { inviterName: inviter.name, ...appContext });
  return { invitation, delivery };
}

export async function revokeInvitation({ invitationId, inviter }) {
  const invitation = await EmployeeInvitation.findById(invitationId);
  if (!invitation) throw new InvitationError(404, 'INVITATION_NOT_FOUND', 'Invitation not found');
  if (invitation.status !== INVITATION_STATUSES.PENDING) throw new InvitationError(409, 'INVITATION_CLOSED', 'This invitation is no longer open');
  if (!invitableRolesFor(inviter.role).includes(invitation.role)) throw new InvitationError(403, 'ROLE_NOT_ALLOWED', 'You cannot manage invitations for this role');
  invitation.status = INVITATION_STATUSES.REVOKED;
  invitation.revokedAt = new Date();
  invitation.revokedByUserId = inviter.id;
  await invitation.save();
  return invitation;
}

/** Newest first, optionally filtered by display status. */
export async function listInvitations({ status }) {
  const now = new Date();
  const statusFilter = {
    pending: { status: { $in: [INVITATION_STATUSES.PENDING, INVITATION_STATUSES.ACCEPTING] }, expiresAt: { $gt: now } },
    expired: { status: INVITATION_STATUSES.PENDING, expiresAt: { $lte: now } },
    accepted: { status: INVITATION_STATUSES.ACCEPTED },
    revoked: { status: INVITATION_STATUSES.REVOKED },
  }[status] ?? {};
  const invitations = await EmployeeInvitation.find(statusFilter).sort({ createdAt: -1 }).limit(INVITATION_LIMITS.LIST_LIMIT);
  const departmentIds = [...new Set(invitations.map((invitation) => invitation.profileDraft.departmentId.toString()))];
  const managerIds = [...new Set(invitations.map((invitation) => invitation.profileDraft.reportingManagerId?.toString()).filter(Boolean))];
  const [departments, managers] = await Promise.all([
    Department.find({ _id: { $in: departmentIds } }).select('name').lean(),
    EmployeeProfile.find({ _id: { $in: managerIds } }).select('userId').lean(),
  ]);
  const managerAccounts = await User.find({ _id: { $in: managers.map((manager) => manager.userId) } }).select('name').lean();
  const accountNames = new Map(managerAccounts.map((account) => [account._id.toString(), account.name]));
  const lookups = {
    departmentNames: new Map(departments.map((department) => [department._id.toString(), department.name])),
    managerNames: new Map(managers.map((manager) => [manager._id.toString(), accountNames.get(manager.userId.toString()) ?? null])),
  };
  return invitations.map((invitation) => toInvitationSummary(invitation, lookups));
}

// =================================================================================================
// Invitee operations (public, by token)
// =================================================================================================

async function findInvitationByToken(rawToken) {
  if (typeof rawToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(rawToken)) return null;
  return EmployeeInvitation.findOne({ tokenHash: hashInvitationToken(rawToken) });
}

function assertUsable(invitation) {
  if (!invitation || invitation.status === INVITATION_STATUSES.REVOKED) throw new InvitationError(404, 'INVITATION_INVALID', 'This invitation link is not valid. Ask HR for a new one.');
  if (invitation.status === INVITATION_STATUSES.ACCEPTED) throw new InvitationError(410, 'INVITATION_USED', 'This invitation has already been used. Sign in with your email and password.');
  if (invitation.status === INVITATION_STATUSES.ACCEPTING) throw new InvitationError(409, 'INVITATION_IN_PROGRESS', 'This invitation is being activated in another window.');
  if (invitation.expiresAt <= new Date()) throw new InvitationError(410, 'INVITATION_EXPIRED', 'This invitation has expired. Ask HR to send a new one.');
}

/** What the accept page shows before the person sets a password. */
export async function previewInvitation(rawToken, { companyName }) {
  const invitation = await findInvitationByToken(rawToken);
  assertUsable(invitation);
  const department = await Department.findById(invitation.profileDraft.departmentId).select('name').lean();
  return {
    name: invitation.name,
    email: invitation.email,
    companyName,
    designation: invitation.profileDraft.designation,
    departmentName: department?.name ?? null,
    expiresAt: invitation.expiresAt.toISOString(),
  };
}

/** Creates the account and profile. Returns the new User document. */
export async function acceptInvitation(rawToken, password) {
  const invitation = await findInvitationByToken(rawToken);
  assertUsable(invitation);

  // Step 1: claim atomically.
  const claimedInvitation = await EmployeeInvitation.findOneAndUpdate(
    { _id: invitation._id, status: INVITATION_STATUSES.PENDING, expiresAt: { $gt: new Date() } },
    { $set: { status: INVITATION_STATUSES.ACCEPTING } },
    { new: true },
  );
  if (!claimedInvitation) throw new InvitationError(409, 'INVITATION_IN_PROGRESS', 'This invitation is being activated in another window.');

  let createdUser = null;
  let createdProfileId = null;
  try {
    // Step 2: account, then profile.
    if (await User.exists({ email: claimedInvitation.email })) {
      throw new InvitationError(409, 'EMAIL_ALREADY_REGISTERED', 'An account with this email already exists. Sign in instead, or ask HR for help.');
    }
    createdUser = await User.create({ name: claimedInvitation.name, email: claimedInvitation.email, password, role: claimedInvitation.role });
    const draft = claimedInvitation.profileDraft;
    const createdProfile = await EmployeeProfile.create({
      userId: createdUser._id,
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
    await EmployeeInvitation.updateOne({ _id: claimedInvitation._id }, { $set: { status: INVITATION_STATUSES.ACCEPTED, acceptedUserId: createdUser._id, acceptedAt: new Date() } });
    return createdUser;
  } catch (acceptError) {
    if (createdProfileId) await EmployeeProfile.deleteOne({ _id: createdProfileId }).catch((cleanupError) => logger.error('Invitation rollback could not delete profile', { profileId: createdProfileId.toString(), error: cleanupError.message }));
    if (createdUser) await User.deleteOne({ _id: createdUser._id }).catch((cleanupError) => logger.error('Invitation rollback could not delete user', { userId: createdUser._id.toString(), error: cleanupError.message }));
    await EmployeeInvitation.updateOne({ _id: claimedInvitation._id, status: INVITATION_STATUSES.ACCEPTING }, { $set: { status: INVITATION_STATUSES.PENDING } });
    if (acceptError instanceof InvitationError) throw acceptError;
    if (acceptError?.code === 11000) throw new InvitationError(409, 'EMAIL_ALREADY_REGISTERED', 'An account with this email already exists. Sign in instead, or ask HR for help.');
    if (acceptError?.name === 'ValidationError') {
      logger.warn('Invitation profile no longer valid', { invitationId: claimedInvitation._id.toString(), error: acceptError.message.slice(0, 200) });
      throw new InvitationError(409, 'INVITATION_OUTDATED', 'Your invitation details changed (department or manager). Ask HR to send a new invitation.');
    }
    throw acceptError;
  }
}
