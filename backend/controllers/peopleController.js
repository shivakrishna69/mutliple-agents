/**
 * People onboarding for HR and admins (routes/peopleRoutes.js, mounted at /api/people, behind
 * `protect`). Every handler checks the role itself and records an audit event.
 *
 *   GET  /invitations/options          departments, possible managers, roles this user may grant
 *   GET  /invitations?status=          pending | expired | accepted | revoked (default: all)
 *   POST /invitations                  { name, email, role, designation, departmentId,
 *                                        reportingManagerId?, workLocationType, dateOfJoining,
 *                                        employmentStatus } -> 201 { invitation, delivery }
 *   POST /invitations/:id/resend       new link, new expiry -> 200 { invitation, delivery }
 *   POST /invitations/:id/revoke       -> 200 { invitation }
 *
 * `delivery` = { outcome: sent | not_configured | failed, inviteUrl }. `inviteUrl` is present only
 * when the email did not go out, so HR can share the link another way.
 */

import { HTTP_STATUS } from '../constants/httpStatus.js';
import { PEOPLE_MESSAGES } from '../constants/messages.js';
import { ROLES } from '../models/User.js';
import {
  INVITATION_DISPLAY_STATUSES,
  InvitationError,
  createInvitation,
  listInvitations,
  loadInvitationFormOptions,
  resendInvitation,
  revokeInvitation,
  toInvitationSummary,
} from '../services/invitationService.js';
import { sendCodedError, sendError, sendSuccess } from '../utils/apiResponse.js';
import { AUDIT_OUTCOMES, recordAuditEvent } from '../utils/auditLogger.js';
import { isValidObjectIdString } from '../validators/conversationValidators.js';
import { validateInvitationInput } from '../validators/peopleValidators.js';

const PEOPLE_MANAGER_ROLES = [ROLES.ADMIN, ROLES.HR];

function audit(req, action, outcome, details = {}) {
  recordAuditEvent(req, { category: 'people', action, outcome, ...details });
}

function appContextOf(req) {
  const { appPublicUrl, companyName } = req.app.locals.config;
  return { appPublicUrl, companyName };
}

/** Wraps a handler with the HR/admin check and InvitationError mapping. */
function peopleHandler(action, handler) {
  return async (req, res, next) => {
    if (!PEOPLE_MANAGER_ROLES.includes(req.user.role)) {
      audit(req, action, AUDIT_OUTCOMES.DENIED);
      return sendError(req, res, HTTP_STATUS.FORBIDDEN, PEOPLE_MESSAGES.RESTRICTED);
    }
    try {
      return await handler(req, res);
    } catch (error) {
      if (error instanceof InvitationError) {
        audit(req, action, AUDIT_OUTCOMES.REJECTED, { reason: error.code });
        return sendCodedError(req, res, error.httpStatus, { code: error.code, message: error.message });
      }
      return next(error);
    }
  };
}

function requireInvitationId(req, res) {
  if (isValidObjectIdString(req.params.invitationId)) return true;
  sendError(req, res, HTTP_STATUS.BAD_REQUEST, PEOPLE_MESSAGES.INVITATION_ID_INVALID);
  return false;
}

export const getInvitationOptions = peopleHandler('invitation_options', async (req, res) => {
  const options = await loadInvitationFormOptions(req.user.role);
  return sendSuccess(res, HTTP_STATUS.OK, PEOPLE_MESSAGES.OPTIONS_RETRIEVED, options);
});

export const getInvitations = peopleHandler('list_invitations', async (req, res) => {
  const { status } = req.query;
  if (status !== undefined && !INVITATION_DISPLAY_STATUSES.includes(status)) {
    return sendError(req, res, HTTP_STATUS.BAD_REQUEST, PEOPLE_MESSAGES.STATUS_INVALID);
  }
  const invitations = await listInvitations({ status });
  return sendSuccess(res, HTTP_STATUS.OK, PEOPLE_MESSAGES.INVITATIONS_RETRIEVED, { invitations });
});

export const postInvitation = peopleHandler('create_invitation', async (req, res) => {
  const validation = validateInvitationInput(req.body);
  if (!validation.isValid) return sendError(req, res, HTTP_STATUS.BAD_REQUEST, PEOPLE_MESSAGES.INVITATION_INVALID, validation.validationErrors);
  const { invitation, delivery } = await createInvitation({ inviter: { id: req.user.id, name: req.user.name, role: req.user.role }, input: validation.sanitizedInput, appContext: appContextOf(req) });
  audit(req, 'create_invitation', AUDIT_OUTCOMES.ALLOWED, { invitationId: invitation._id.toString(), invitedRole: invitation.role, delivery: delivery.outcome });
  return sendSuccess(res, HTTP_STATUS.CREATED, PEOPLE_MESSAGES.INVITATION_CREATED, { invitation: toInvitationSummary(invitation), delivery });
});

export const postResendInvitation = peopleHandler('resend_invitation', async (req, res) => {
  if (!requireInvitationId(req, res)) return undefined;
  const { invitation, delivery } = await resendInvitation({ invitationId: req.params.invitationId, inviter: { id: req.user.id, name: req.user.name, role: req.user.role }, appContext: appContextOf(req) });
  audit(req, 'resend_invitation', AUDIT_OUTCOMES.ALLOWED, { invitationId: invitation._id.toString(), delivery: delivery.outcome });
  return sendSuccess(res, HTTP_STATUS.OK, PEOPLE_MESSAGES.INVITATION_RESENT, { invitation: toInvitationSummary(invitation), delivery });
});

export const postRevokeInvitation = peopleHandler('revoke_invitation', async (req, res) => {
  if (!requireInvitationId(req, res)) return undefined;
  const invitation = await revokeInvitation({ invitationId: req.params.invitationId, inviter: { id: req.user.id, role: req.user.role } });
  audit(req, 'revoke_invitation', AUDIT_OUTCOMES.ALLOWED, { invitationId: invitation._id.toString() });
  return sendSuccess(res, HTTP_STATUS.OK, PEOPLE_MESSAGES.INVITATION_REVOKED, { invitation: toInvitationSummary(invitation) });
});
