/**
 * Creating a new employee before they join: an invited account (User, no password, cannot sign in)
 * and their EmployeeProfile with a new employee ID, so HR sees everyone from the moment they are
 * invited. The person activates the account through their invitation link (services/
 * invitationService.js). Shared by single invitations and bulk imports, so both follow one rule.
 *
 * Without transactions, the account is created first (its unique email decides between two
 * attempts at once), then the profile; if the profile fails, the account is deleted again.
 */

import EmployeeProfile, { EMPLOYMENT_STATUSES } from '../models/EmployeeProfile.js';
import User, { ACCOUNT_STATUSES } from '../models/User.js';
import { logger } from '../utils/logger.js';
import { isDuplicateKeyError } from '../utils/mongoErrors.js';
import { suggestCompanyEmail } from './companyEmail.js';
import { getCompanySettings, issueEmployeeCode } from './companySettings.js';

export class ProvisioningError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProvisioningError';
    this.code = code;
  }
}

export const PROVISIONING_ERRORS = Object.freeze({
  EMAIL_ALREADY_REGISTERED: 'Someone with this email already has an account',
  INVITATION_EXISTS: 'This person has already been invited; resend their invitation instead',
  COMPANY_EMAIL_TAKEN: 'Another account already has this company email',
});

/** How an existing account with this email affects inviting them. */
export async function findInvitableAccount(email) {
  const existing = await User.findOne({ email }).select('+password').lean();
  if (!existing) return null;
  if (existing.status === ACCOUNT_STATUSES.INVITED)
    throw new ProvisioningError('INVITATION_EXISTS', PROVISIONING_ERRORS.INVITATION_EXISTS);
  // A revoked invitation that was never used can be invited again: same account, same employee ID.
  if (existing.status === ACCOUNT_STATUSES.DISABLED && !existing.password) return existing;
  throw new ProvisioningError('EMAIL_ALREADY_REGISTERED', PROVISIONING_ERRORS.EMAIL_ALREADY_REGISTERED);
}

async function createAccount({ name, email, role, companyEmail }) {
  const { emailDomain } = await getCompanySettings();
  for (;;) {
    const address = companyEmail ?? (await suggestCompanyEmail(name, emailDomain));
    try {
      return await User.create({
        name,
        email,
        role,
        status: ACCOUNT_STATUSES.INVITED,
        personalEmail: email,
        companyEmail: address,
      });
    } catch (creationError) {
      if (!isDuplicateKeyError(creationError)) throw creationError;
      if (creationError.keyPattern?.email)
        throw new ProvisioningError('EMAIL_ALREADY_REGISTERED', PROVISIONING_ERRORS.EMAIL_ALREADY_REGISTERED);
      // The company address: one HR chose is refused; a suggested one was taken a moment ago, so suggest again.
      if (companyEmail) throw new ProvisioningError('COMPANY_EMAIL_TAKEN', PROVISIONING_ERRORS.COMPANY_EMAIL_TAKEN);
    }
  }
}

/**
 * A new invited account and profile.
 * @param {{ name: string, email: string, role: string, profileDraft: object, companyEmail?: string|null }} details
 *   `profileDraft` holds the organizationData fields; `companyEmail` overrides the suggested address.
 * @returns {Promise<{ user: object, profile: object }>}
 */
export async function provisionInvitedEmployee({ name, email, role, profileDraft, companyEmail = null }) {
  const user = await createAccount({ name, email, role, companyEmail });
  try {
    const profile = await EmployeeProfile.create({
      userId: user._id,
      employeeCode: await issueEmployeeCode(),
      organizationData: profileDraft,
    });
    return { user, profile };
  } catch (profileError) {
    await User.deleteOne({ _id: user._id }).catch((cleanupError) =>
      logger.error('Provisioning rollback could not delete the account', {
        userId: user._id.toString(),
        error: cleanupError.message,
      }),
    );
    throw profileError;
  }
}

/**
 * Invites a person again whose earlier invitation was revoked before they used it: the same account
 * and employee ID, with the new details.
 */
export async function reopenInvitedEmployee({ userId, name, role, profileDraft }) {
  const user = await User.findById(userId);
  user.set({ name, role, status: ACCOUNT_STATUSES.INVITED });
  await user.save();
  const profile = await EmployeeProfile.findOne({ userId });
  for (const [field, value] of Object.entries(profileDraft)) profile.set(`organizationData.${field}`, value);
  await profile.save();
  return { user, profile };
}

/** Undoes provisioning that could not be finished: a new account is deleted, a reopened one disabled. */
export async function undoProvisioning({ user, profile, wasReopened }) {
  if (wasReopened) {
    await withdrawInvitedEmployee(user._id);
    return;
  }
  await EmployeeProfile.deleteOne({ _id: profile._id });
  await User.deleteOne({ _id: user._id });
}

/** A revoked invitation: the account is disabled and the profile marked as no longer employed. */
export async function withdrawInvitedEmployee(userId) {
  await User.updateOne(
    { _id: userId, status: ACCOUNT_STATUSES.INVITED },
    { $set: { status: ACCOUNT_STATUSES.DISABLED } },
  );
  await EmployeeProfile.updateOne(
    { userId },
    { $set: { 'organizationData.employmentStatus': EMPLOYMENT_STATUSES.TERMINATED } },
  );
}

/** The person chose their password through their invitation link: the account becomes usable. */
export async function activateInvitedAccount(userId, password) {
  const user = await User.findOne({ _id: userId, status: ACCOUNT_STATUSES.INVITED });
  if (!user) return null;
  user.set({ password, status: ACCOUNT_STATUSES.ACTIVE });
  await user.save();
  return user;
}
