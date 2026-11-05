/**
 * Signup with email confirmation, and password reset (rules in services/accountEmailFlows.js).
 *
 *   POST /api/auth/signup                 { name, email, password }  202: check your email
 *   POST /api/auth/verify-email/resend    { email }                  202: a new link if one is due
 *   POST /api/auth/verify-email           { token }                  200: confirmed and signed in
 *   POST /api/auth/password/forgot        { email }                  202: a reset link if there is an account
 *   GET  /api/auth/password/reset/:token                             200: the link works (and until when)
 *   POST /api/auth/password/reset         { token, password }        200: changed, every device signed out
 *
 * Errors carry a stable `code` (sendCodedError) for the screens to branch on:
 *   400 VERIFICATION_LINK_INVALID / RESET_LINK_INVALID   unknown, used, revoked or expired link
 *   429 EMAIL_COOLDOWN   an email went to this address less than a minute ago; the wait is in the
 *                        Retry-After header and in error.context.retryAfterSeconds
 *   503 EMAIL_UNAVAILABLE   the server has no email configured
 * Bad input is a 400 with per-field `details`; per-IP rate limits answer 429 from the middleware.
 *
 * Nothing is logged or audited with an email address or a token; accounts are named by userId.
 */

import { ACCOUNT_EMAIL_MESSAGES, VALIDATION_MESSAGES } from '../constants/messages.js';
import { HTTP_STATUS } from '../constants/httpStatus.js';
import { ACCOUNT_EMAIL_SETTINGS } from '../constants/validation.js';
import {
  AccountFlowError,
  checkPasswordResetLink,
  registerAccount,
  requestPasswordReset,
  resendVerification,
  resetPassword,
  verifyEmail,
} from '../services/accountEmailFlows.js';
import { loadEmailContext } from '../services/companySettings.js';
import { sendCodedError, sendError, sendSuccess } from '../utils/apiResponse.js';
import { AUDIT_OUTCOMES, recordAuditEvent } from '../utils/auditLogger.js';
import { logger } from '../utils/logger.js';
import { SOCKET_ERROR_CODES, disconnectUserSockets } from '../utils/socketManager.js';
import { toPublicUserProfile } from '../utils/userProfile.js';
import {
  validateEmailRequestInput,
  validatePasswordResetInput,
  validateRegistrationInput,
  validateVerifyEmailInput,
} from '../validators/authValidators.js';
import { startSession } from './authController.js';

const AUDIT_CATEGORY = 'account';
const RESEND_AFTER_SECONDS = Math.ceil(ACCOUNT_EMAIL_SETTINGS.EMAIL_COOLDOWN_MS / 1000);

function sendValidationFailure(req, res, validation) {
  return sendError(
    req,
    res,
    HTTP_STATUS.BAD_REQUEST,
    VALIDATION_MESSAGES.REQUEST_VALIDATION_FAILED,
    validation.validationErrors,
  );
}

/**
 * Wraps a handler: an AccountFlowError becomes its coded response (with Retry-After for a
 * cooldown) and a rejected audit event; anything else goes to the central error handler.
 */
function accountEmailHandler(action, handle) {
  return async (req, res, next) => {
    try {
      return await handle(req, res);
    } catch (handlerError) {
      if (!(handlerError instanceof AccountFlowError)) return next(handlerError);
      const retryAfterSeconds = handlerError.context?.retryAfterSeconds;
      if (retryAfterSeconds) res.set('Retry-After', String(retryAfterSeconds));
      recordAuditEvent(req, {
        category: AUDIT_CATEGORY,
        action,
        outcome: AUDIT_OUTCOMES.REJECTED,
        reason: handlerError.code,
      });
      return sendCodedError(req, res, handlerError.httpStatus, {
        code: handlerError.code,
        message: handlerError.message,
        context: handlerError.context,
      });
    }
  };
}

const emailContextOf = (req) => loadEmailContext(req.app.locals.config);

/**
 * Security decisions:
 *   - The role is never taken from the request: a customer, or admin for BOOTSTRAP_ADMIN_EMAIL.
 *   - No session is started: the account cannot sign in until its email is confirmed.
 *   - The answer is the same for a new address, an unverified one (taken over) and one that already
 *     has an account (its owner is emailed instead), so signup does not reveal registered emails.
 */
export const registerUser = accountEmailHandler('signup', async (req, res) => {
  const validation = validateRegistrationInput(req.body);
  if (!validation.isValid) return sendValidationFailure(req, res, validation);
  const { name, email, password } = validation.sanitizedInput;

  const { outcome, userId } = await registerAccount({
    name,
    email,
    password,
    bootstrapAdminEmail: req.app.locals.config.bootstrapAdminEmail,
    emailContext: await emailContextOf(req),
  });
  recordAuditEvent(req, {
    category: AUDIT_CATEGORY,
    action: 'signup',
    outcome: AUDIT_OUTCOMES.ALLOWED,
    signupOutcome: outcome,
    userId,
  });
  return sendSuccess(res, HTTP_STATUS.ACCEPTED, ACCOUNT_EMAIL_MESSAGES.SIGNUP_CHECK_EMAIL, {
    email,
    resendAfterSeconds: RESEND_AFTER_SECONDS,
  });
});

export const resendVerificationEmail = accountEmailHandler('email_verification_resend', async (req, res) => {
  const validation = validateEmailRequestInput(req.body);
  if (!validation.isValid) return sendValidationFailure(req, res, validation);
  const { email } = validation.sanitizedInput;

  const { userId } = await resendVerification({ email, emailContext: await emailContextOf(req) });
  recordAuditEvent(req, {
    category: AUDIT_CATEGORY,
    action: 'email_verification_resend',
    outcome: AUDIT_OUTCOMES.ALLOWED,
    userId,
  });
  return sendSuccess(res, HTTP_STATUS.ACCEPTED, ACCOUNT_EMAIL_MESSAGES.VERIFICATION_RESENT, {
    resendAfterSeconds: RESEND_AFTER_SECONDS,
  });
});

/** Confirms the email and signs the person in with a new session, like a login. */
export const confirmEmail = accountEmailHandler('email_verification', async (req, res) => {
  const validation = validateVerifyEmailInput(req.body);
  if (!validation.isValid) return sendValidationFailure(req, res, validation);

  const user = await verifyEmail(validation.sanitizedInput.token);
  const csrfToken = startSession(res, req.app.locals.config, user._id);
  recordAuditEvent(req, {
    category: AUDIT_CATEGORY,
    action: 'email_verification',
    outcome: AUDIT_OUTCOMES.ALLOWED,
    userId: user._id.toString(),
  });
  logger.info('Email verified', { requestId: req.id, userId: user._id.toString() });
  return sendSuccess(res, HTTP_STATUS.OK, ACCOUNT_EMAIL_MESSAGES.EMAIL_VERIFIED, {
    user: toPublicUserProfile(user),
    csrfToken,
  });
});

export const forgotPassword = accountEmailHandler('password_reset_request', async (req, res) => {
  const validation = validateEmailRequestInput(req.body);
  if (!validation.isValid) return sendValidationFailure(req, res, validation);
  const { email } = validation.sanitizedInput;

  const { userId, sent } = await requestPasswordReset({ email, emailContext: await emailContextOf(req) });
  recordAuditEvent(req, {
    category: AUDIT_CATEGORY,
    action: 'password_reset_request',
    outcome: AUDIT_OUTCOMES.ALLOWED,
    userId,
    sent,
  });
  return sendSuccess(res, HTTP_STATUS.ACCEPTED, ACCOUNT_EMAIL_MESSAGES.PASSWORD_RESET_REQUESTED, {
    resendAfterSeconds: RESEND_AFTER_SECONDS,
  });
});

/** Lets the reset page say "this link has expired" before the person types a new password. */
export const describePasswordResetLink = accountEmailHandler('password_reset_check', async (req, res) => {
  const { expiresAt } = await checkPasswordResetLink(req.params.token);
  return sendSuccess(res, HTTP_STATUS.OK, ACCOUNT_EMAIL_MESSAGES.RESET_LINK_VALID, {
    expiresAt: expiresAt.toISOString(),
  });
});

/**
 * Sets the new password. Every session of the account ends (passwordChangedAt) and its open sockets
 * close now; nobody is signed in by this request, so the person signs in with the new password.
 */
export const applyPasswordReset = accountEmailHandler('password_reset', async (req, res) => {
  const validation = validatePasswordResetInput(req.body);
  if (!validation.isValid) return sendValidationFailure(req, res, validation);
  const { token, password } = validation.sanitizedInput;

  const user = await resetPassword({ rawToken: token, password, emailContext: await emailContextOf(req) });
  const userId = user._id.toString();
  disconnectUserSockets(userId, SOCKET_ERROR_CODES.PASSWORD_CHANGED);
  recordAuditEvent(req, {
    category: AUDIT_CATEGORY,
    action: 'password_reset',
    outcome: AUDIT_OUTCOMES.ALLOWED,
    userId,
  });
  logger.info('Password reset', { requestId: req.id, userId });
  return sendSuccess(res, HTTP_STATUS.OK, ACCOUNT_EMAIL_MESSAGES.PASSWORD_RESET_DONE, {});
});
