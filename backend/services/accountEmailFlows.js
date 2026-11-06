/**
 * Signing up with a confirmed email address, and resetting a forgotten password.
 *
 *   registerAccount       new account, "unverified", and a confirmation link by email. Signing up
 *                         again with an unverified address replaces that account (name, password)
 *                         and revokes its earlier links first, so the real owner of an address is
 *                         never locked out by whoever typed it first.
 *   resendVerification    a new confirmation link for an unverified account
 *   verifyEmail           uses the link: the account becomes active and its email verified
 *   requestPasswordReset  a reset link for an active account (a confirmation link for an unverified one)
 *   checkPasswordResetLink / resetPassword
 *                         the reset page: is the link still good, then the new password. Resetting
 *                         revokes every link of the account and signs every device out
 *                         (passwordChangedAt), and the owner is told by email.
 *
 * Nothing here tells a caller whether an address has an account: signup, resend and forgot-password
 * succeed the same way for every well-formed address, and the per-address cooldown
 * (services/emailCooldown.js) is claimed for every address alike. Only the mailbox's owner learns
 * anything, from what arrives (or not) in it.
 *
 * Email is required: without SMTP these flows answer 503 instead of creating accounts nobody can
 * confirm.
 */

import User, { ACCOUNT_STATUSES, ROLES } from '../models/User.js';
import { ACCOUNT_TOKEN_PURPOSES } from '../models/AccountToken.js';
import { ACCOUNT_EMAIL_MESSAGES } from '../constants/messages.js';
import { HTTP_STATUS } from '../constants/httpStatus.js';
import { ACCOUNT_EMAIL_SETTINGS, ACCOUNT_LINK_PATHS, TERMS_VERSION } from '../constants/validation.js';
import { logger } from '../utils/logger.js';
import { isDuplicateKeyError } from '../utils/mongoErrors.js';
import {
  buildAccountExistsEmail,
  buildPasswordChangedEmail,
  buildPasswordResetEmail,
  buildVerificationEmail,
} from './accountEmails.js';
import {
  ACCOUNT_CODE_OUTCOMES,
  consumeAccountCode,
  consumeAccountToken,
  findUsableAccountToken,
  issueAccountToken,
  revokeAccountTokens,
} from './accountTokens.js';
import { claimEmailCooldown, EMAIL_COOLDOWN_CHANNELS } from './emailCooldown.js';
import { isMailConfigured, sendMail } from './mailService.js';

export const ACCOUNT_FLOW_ERROR_CODES = Object.freeze({
  EMAIL_UNAVAILABLE: 'EMAIL_UNAVAILABLE',
  EMAIL_COOLDOWN: 'EMAIL_COOLDOWN',
  VERIFICATION_LINK_INVALID: 'VERIFICATION_LINK_INVALID',
  VERIFICATION_CODE_INVALID: 'VERIFICATION_CODE_INVALID',
  RESET_LINK_INVALID: 'RESET_LINK_INVALID',
  RESET_CODE_INVALID: 'RESET_CODE_INVALID',
});

/** What registerAccount did, for the audit log; the caller's answer is the same in every case. */
export const SIGNUP_OUTCOMES = Object.freeze({
  CREATED: 'created',
  REPLACED_UNVERIFIED: 'replaced_unverified',
  ALREADY_REGISTERED: 'already_registered',
});

export class AccountFlowError extends Error {
  /**
   * @param {number} httpStatus
   * @param {string} code  ACCOUNT_FLOW_ERROR_CODES
   * @param {string} message
   * @param {object} [context]  e.g. { retryAfterSeconds }
   */
  constructor(httpStatus, code, message, context = undefined) {
    super(message);
    this.name = 'AccountFlowError';
    this.httpStatus = httpStatus;
    this.code = code;
    this.context = context;
  }
}

const settings = ACCOUNT_EMAIL_SETTINGS;

const linkFailure = (code, message) => new AccountFlowError(HTTP_STATUS.BAD_REQUEST, code, message);
const invalidVerificationLink = () =>
  linkFailure(ACCOUNT_FLOW_ERROR_CODES.VERIFICATION_LINK_INVALID, ACCOUNT_EMAIL_MESSAGES.VERIFICATION_LINK_INVALID);
const invalidVerificationCode = () =>
  linkFailure(ACCOUNT_FLOW_ERROR_CODES.VERIFICATION_CODE_INVALID, ACCOUNT_EMAIL_MESSAGES.VERIFICATION_CODE_INVALID);
const invalidResetLink = () =>
  linkFailure(ACCOUNT_FLOW_ERROR_CODES.RESET_LINK_INVALID, ACCOUNT_EMAIL_MESSAGES.RESET_LINK_INVALID);
const invalidResetCode = () =>
  linkFailure(ACCOUNT_FLOW_ERROR_CODES.RESET_CODE_INVALID, ACCOUNT_EMAIL_MESSAGES.RESET_CODE_INVALID);

function assertMailAvailable() {
  if (!isMailConfigured()) {
    throw new AccountFlowError(
      HTTP_STATUS.SERVICE_UNAVAILABLE,
      ACCOUNT_FLOW_ERROR_CODES.EMAIL_UNAVAILABLE,
      ACCOUNT_EMAIL_MESSAGES.EMAIL_UNAVAILABLE,
    );
  }
}

async function claimCooldownOrThrow(channel, email) {
  const claim = await claimEmailCooldown(channel, email, settings.EMAIL_COOLDOWN_MS);
  if (!claim.allowed) {
    throw new AccountFlowError(
      HTTP_STATUS.TOO_MANY_REQUESTS,
      ACCOUNT_FLOW_ERROR_CODES.EMAIL_COOLDOWN,
      ACCOUNT_EMAIL_MESSAGES.EMAIL_COOLDOWN,
      { retryAfterSeconds: claim.retryAfterSeconds },
    );
  }
}

const pageUrl = (appPublicUrl, path) => `${appPublicUrl}${path}`;
const tokenUrl = (appPublicUrl, path, rawToken) => `${appPublicUrl}${path}/${rawToken}`;

/** Sends one account email. Delivery problems are logged by mailService and not reported to the caller. */
async function deliver(user, message, kind) {
  const { outcome } = await sendMail({ to: user.email, ...message });
  logger.info('Account email handed over', { kind, outcome, userId: user._id.toString() });
}

async function sendVerificationLink(user, { companyName, appPublicUrl }) {
  const { rawToken, code } = await issueAccountToken(
    user._id,
    ACCOUNT_TOKEN_PURPOSES.EMAIL_VERIFICATION,
    settings.EMAIL_VERIFICATION_VALIDITY_MS,
    new Date(),
    { codeDigits: settings.VERIFICATION_CODE_DIGITS },
  );
  const message = buildVerificationEmail({
    name: user.name,
    companyName,
    verificationUrl: tokenUrl(appPublicUrl, ACCOUNT_LINK_PATHS.EMAIL_VERIFICATION, rawToken),
    verificationCode: code,
    validityMs: settings.EMAIL_VERIFICATION_VALIDITY_MS,
  });
  await deliver(user, message, 'email_verification');
}

/**
 * A new unverified account, or the unverified account with this email taken over by the new
 * signup; or, when the email belongs to any other account, that account untouched.
 */
async function createOrReplaceUnverifiedAccount({ email, password, details }) {
  // Two passes: when a signup for the same new address creates it between our lookup and insert,
  // the second pass finds it.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const existing = await User.findOne({ email });
    if (!existing) {
      try {
        const created = await User.create({ ...details, email, password, status: ACCOUNT_STATUSES.UNVERIFIED });
        return { outcome: SIGNUP_OUTCOMES.CREATED, user: created };
      } catch (creationError) {
        if (!(isDuplicateKeyError(creationError) && creationError.keyPattern?.email)) throw creationError;
        continue;
      }
    }
    if (existing.status !== ACCOUNT_STATUSES.UNVERIFIED) {
      return { outcome: SIGNUP_OUTCOMES.ALREADY_REGISTERED, user: existing };
    }
    // Earlier links first: none of them may confirm the account with the new password.
    await revokeAccountTokens(existing._id);
    existing.set({ ...details, password });
    await existing.save();
    return { outcome: SIGNUP_OUTCOMES.REPLACED_UNVERIFIED, user: existing };
  }
  throw new Error('Signup could neither create nor find the account');
}

/**
 * POST /api/auth/signup. Input already validated and normalised (validators/authValidators.js).
 * @param {{ firstName: string, lastName: string, name: string, email: string, phoneNumber: string,
 *   dateOfBirth: Date|null, gender: string|null, password: string, bootstrapAdminEmail: string|null,
 *   emailContext: { companyName: string, appPublicUrl: string } }} signup
 * @returns {Promise<{ outcome: string, userId: string }>}  for the audit log only
 */
export async function registerAccount({
  firstName,
  lastName,
  name,
  email,
  phoneNumber,
  dateOfBirth,
  gender,
  password,
  bootstrapAdminEmail,
  emailContext,
}) {
  assertMailAvailable();
  await claimCooldownOrThrow(EMAIL_COOLDOWN_CHANNELS.EMAIL_VERIFICATION, email);

  // Every self-registered account is a customer, except the deployment's configured first admin
  // (BOOTSTRAP_ADMIN_EMAIL), which must confirm its email like everyone else.
  const role = bootstrapAdminEmail && email === bootstrapAdminEmail ? ROLES.ADMIN : ROLES.CUSTOMER;
  // The signup's own details; they also replace those of an unconfirmed account with this address.
  const details = {
    firstName,
    lastName,
    name,
    phoneNumber,
    phoneVerifiedAt: null,
    dateOfBirth,
    gender,
    role,
    termsVersion: TERMS_VERSION,
    termsAcceptedAt: new Date(),
  };
  const { outcome, user } = await createOrReplaceUnverifiedAccount({ email, password, details });

  if (outcome !== SIGNUP_OUTCOMES.ALREADY_REGISTERED) {
    await sendVerificationLink(user, emailContext);
  } else if (user.status === ACCOUNT_STATUSES.ACTIVE) {
    // Invited and disabled accounts get nothing: they cannot sign in, and their owner was told by HR.
    const { companyName, appPublicUrl } = emailContext;
    const message = buildAccountExistsEmail({
      name: user.name,
      companyName,
      signInUrl: pageUrl(appPublicUrl, ACCOUNT_LINK_PATHS.SIGN_IN),
      forgotPasswordUrl: pageUrl(appPublicUrl, ACCOUNT_LINK_PATHS.FORGOT_PASSWORD),
    });
    await deliver(user, message, 'account_exists');
  }
  return { outcome, userId: user._id.toString() };
}

/**
 * POST /api/auth/verify-email/resend.
 * @returns {Promise<{ userId: string|null }>}  the account a link was sent to, for the audit log only
 */
export async function resendVerification({ email, emailContext }) {
  assertMailAvailable();
  await claimCooldownOrThrow(EMAIL_COOLDOWN_CHANNELS.EMAIL_VERIFICATION, email);
  const user = await User.findOne({ email, status: ACCOUNT_STATUSES.UNVERIFIED });
  if (!user) return { userId: null };
  await sendVerificationLink(user, emailContext);
  return { userId: user._id.toString() };
}

/**
 * POST /api/auth/verify-email: the account becomes active, with its email confirmed now.
 * @returns {Promise<object>}  the User document
 */
export async function verifyEmail(rawToken, now = new Date()) {
  const userId = await consumeAccountToken(rawToken, ACCOUNT_TOKEN_PURPOSES.EMAIL_VERIFICATION, now);
  if (!userId) throw invalidVerificationLink();
  return activateVerifiedAccount(userId, now, invalidVerificationLink);
}

/**
 * POST /api/auth/verify-email with { email, code }: the code from the confirmation email, typed in
 * instead of opening its link. A wrong code, an unknown address and an account with nothing to
 * confirm all get the same answer; wrong codes count towards VERIFICATION_CODE_MAX_ATTEMPTS.
 * @returns {Promise<object>}  the User document
 */
export async function verifyEmailWithCode({ email, code }, now = new Date()) {
  const user = await User.findOne({ email, status: ACCOUNT_STATUSES.UNVERIFIED }).select('_id').lean();
  const outcome = user
    ? await consumeAccountCode(
        user._id,
        ACCOUNT_TOKEN_PURPOSES.EMAIL_VERIFICATION,
        code,
        settings.VERIFICATION_CODE_MAX_ATTEMPTS,
        now,
      )
    : ACCOUNT_CODE_OUTCOMES.NONE;
  if (outcome !== ACCOUNT_CODE_OUTCOMES.USED) throw invalidVerificationCode();
  return activateVerifiedAccount(user._id, now, invalidVerificationCode);
}

/** The confirmed account becomes active; its other links are revoked. */
async function activateVerifiedAccount(userId, now, invalidError) {
  const user = await User.findOneAndUpdate(
    { _id: userId, status: ACCOUNT_STATUSES.UNVERIFIED },
    { $set: { status: ACCOUNT_STATUSES.ACTIVE, emailVerifiedAt: now } },
    { new: true },
  );
  if (!user) throw invalidError();
  await revokeAccountTokens(userId);
  return user;
}

/**
 * POST /api/auth/password/forgot.
 * @returns {Promise<{ userId: string|null, sent: 'password_reset'|'email_verification'|null }>}  for the audit log only
 */
export async function requestPasswordReset({ email, emailContext }) {
  assertMailAvailable();
  await claimCooldownOrThrow(EMAIL_COOLDOWN_CHANNELS.PASSWORD_RESET, email);
  const user = await User.findOne({ email });
  if (user?.status === ACCOUNT_STATUSES.UNVERIFIED) {
    // Its password cannot be used yet anyway; what it needs is the confirmation link.
    await sendVerificationLink(user, emailContext);
    return { userId: user._id.toString(), sent: 'email_verification' };
  }
  if (user?.status !== ACCOUNT_STATUSES.ACTIVE) return { userId: null, sent: null };

  const { companyName, appPublicUrl } = emailContext;
  // One record holds both the link and the code, so using either one uses up the other.
  const { rawToken, code } = await issueAccountToken(
    user._id,
    ACCOUNT_TOKEN_PURPOSES.PASSWORD_RESET,
    settings.PASSWORD_RESET_VALIDITY_MS,
    new Date(),
    { codeDigits: settings.VERIFICATION_CODE_DIGITS },
  );
  const message = buildPasswordResetEmail({
    name: user.name,
    companyName,
    resetUrl: tokenUrl(appPublicUrl, ACCOUNT_LINK_PATHS.PASSWORD_RESET, rawToken),
    resetCode: code,
    validityMs: settings.PASSWORD_RESET_VALIDITY_MS,
  });
  await deliver(user, message, 'password_reset');
  return { userId: user._id.toString(), sent: 'password_reset' };
}

/**
 * GET /api/auth/password/reset/:token: whether the link still works, without using it up.
 * @returns {Promise<{ expiresAt: Date }>}
 */
export async function checkPasswordResetLink(rawToken, now = new Date()) {
  const token = await findUsableAccountToken(rawToken, ACCOUNT_TOKEN_PURPOSES.PASSWORD_RESET, now);
  if (!token || !(await User.exists({ _id: token.userId, status: ACCOUNT_STATUSES.ACTIVE }))) throw invalidResetLink();
  return { expiresAt: token.expiresAt };
}

/**
 * POST /api/auth/password/reset { token, ... }. The password has already passed the signup rules.
 * @returns {Promise<object>}  the User document
 */
export async function resetPassword({ rawToken, password, emailContext }, now = new Date()) {
  const userId = await consumeAccountToken(rawToken, ACCOUNT_TOKEN_PURPOSES.PASSWORD_RESET, now);
  if (!userId) throw invalidResetLink();
  return setNewPassword({ userId, password, emailContext, now, invalidError: invalidResetLink });
}

/**
 * POST /api/auth/password/reset { email, code, ... }: the code from the reset email instead of its
 * link. A wrong code is counted; the wrong code that reaches VERIFICATION_CODE_MAX_ATTEMPTS
 * cancels the code and its link. An address without an active account gets the same answer as a
 * wrong code, so this does not reveal which addresses are registered.
 * @returns {Promise<object>}  the User document
 */
export async function resetPasswordWithCode({ email, code, password, emailContext }, now = new Date()) {
  const account = await User.findOne({ email, status: ACCOUNT_STATUSES.ACTIVE }).select('_id').lean();
  const outcome = account
    ? await consumeAccountCode(
        account._id,
        ACCOUNT_TOKEN_PURPOSES.PASSWORD_RESET,
        code,
        settings.VERIFICATION_CODE_MAX_ATTEMPTS,
        now,
      )
    : ACCOUNT_CODE_OUTCOMES.NONE;
  if (outcome !== ACCOUNT_CODE_OUTCOMES.USED) throw invalidResetCode();
  return setNewPassword({ userId: account._id, password, emailContext, now, invalidError: invalidResetCode });
}

/** The new password; every session and every other account link ends, and the owner is told. */
async function setNewPassword({ userId, password, emailContext, now, invalidError }) {
  const user = await User.findOne({ _id: userId, status: ACCOUNT_STATUSES.ACTIVE });
  if (!user) throw invalidError();

  // Sessions issued before passwordChangedAt are rejected (services/sessionAuthenticator.js).
  user.set({ password, passwordChangedAt: now });
  await user.save();
  await revokeAccountTokens(userId);

  const { companyName, appPublicUrl } = emailContext;
  const message = buildPasswordChangedEmail({
    name: user.name,
    companyName,
    signInUrl: pageUrl(appPublicUrl, ACCOUNT_LINK_PATHS.SIGN_IN),
    changedAt: now,
  });
  await deliver(user, message, 'password_changed');
  return user;
}

/**
 * Removes the unverified signup of an address, if there is one, so HR can invite that person:
 * nobody ever signed in to it, and nothing else refers to it. Returns true when one was removed.
 */
export async function discardUnverifiedAccount(email) {
  const discarded = await User.findOneAndDelete({ email, status: ACCOUNT_STATUSES.UNVERIFIED });
  if (!discarded) return false;
  await revokeAccountTokens(discarded._id);
  logger.info('Unverified signup replaced by an invitation', { userId: discarded._id.toString() });
  return true;
}
