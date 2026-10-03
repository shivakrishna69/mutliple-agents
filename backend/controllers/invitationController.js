/**
 * Public invitation endpoints (routes/invitationRoutes.js, mounted at /api/invitations). No session:
 * the random token in the URL is the credential, so both routes are rate-limited per client IP and
 * never reveal whether a token exists beyond "invalid / expired / used".
 *
 *   GET  /:token          -> 200 { invitation: { name, email, companyName, designation, departmentName, expiresAt } }
 *   POST /:token/accept   { password } -> 201 { user, csrfToken } + session cookies (signed in)
 *
 * Errors carry a code: INVITATION_INVALID (404), INVITATION_EXPIRED / INVITATION_USED (410),
 * INVITATION_IN_PROGRESS / EMAIL_ALREADY_REGISTERED / INVITATION_OUTDATED (409).
 */

import { HTTP_STATUS } from '../constants/httpStatus.js';
import { PEOPLE_MESSAGES } from '../constants/messages.js';
import { InvitationError, acceptInvitation, previewInvitation } from '../services/invitationService.js';
import { sendCodedError, sendError, sendSuccess } from '../utils/apiResponse.js';
import { AUDIT_OUTCOMES, recordAuditEvent } from '../utils/auditLogger.js';
import { setSessionCookies } from '../utils/authCookies.js';
import { issueSessionTokens } from '../utils/authToken.js';
import { logger } from '../utils/logger.js';
import { toPublicUserProfile } from '../utils/userProfile.js';
import { checkNewPassword } from '../validators/authValidators.js';

function handleInvitationError(req, res, error, action) {
  recordAuditEvent(req, { category: 'people', action, outcome: AUDIT_OUTCOMES.REJECTED, reason: error.code });
  return sendCodedError(req, res, error.httpStatus, { code: error.code, message: error.message });
}

export async function getInvitationPreview(req, res, next) {
  try {
    const invitation = await previewInvitation(req.params.token, { companyName: req.app.locals.config.companyName });
    return sendSuccess(res, HTTP_STATUS.OK, PEOPLE_MESSAGES.INVITATION_RETRIEVED, { invitation });
  } catch (error) {
    if (error instanceof InvitationError) return handleInvitationError(req, res, error, 'view_invitation');
    return next(error);
  }
}

export async function postAcceptInvitation(req, res, next) {
  try {
    const passwordError = checkNewPassword(req.body?.password);
    if (passwordError) return sendError(req, res, HTTP_STATUS.BAD_REQUEST, passwordError, [{ field: 'password', message: passwordError }]);

    const newUser = await acceptInvitation(req.params.token, req.body.password);
    const authConfig = req.app.locals.config;
    const sessionTokens = issueSessionTokens(newUser._id, authConfig);
    setSessionCookies(res, authConfig, sessionTokens);

    recordAuditEvent(req, { category: 'people', action: 'accept_invitation', outcome: AUDIT_OUTCOMES.ALLOWED, userId: newUser._id.toString(), role: newUser.role });
    logger.info('Invitation accepted', { requestId: req.id, userId: newUser._id.toString() });
    return sendSuccess(res, HTTP_STATUS.CREATED, PEOPLE_MESSAGES.INVITATION_ACCEPTED, { user: toPublicUserProfile(newUser), csrfToken: sessionTokens.csrfToken });
  } catch (error) {
    if (error instanceof InvitationError) return handleInvitationError(req, res, error, 'accept_invitation');
    return next(error);
  }
}
