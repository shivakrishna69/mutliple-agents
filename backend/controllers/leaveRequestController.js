/**
 * Leave request endpoints (routes/leaveRoutes.js). Who may act on a request depends on the request
 * itself, so services/leaveRequests.js applies those rules; this layer establishes who is asking:
 *   employees         price, submit, list and read their own requests; withdraw or cancel them;
 *                     ask for a change once leave has started
 *   approvers         the reporting manager the request was routed to: read it, approve or reject
 *                     it, decide its change requests
 *   HR and admins     the same for every employee's requests (never their own); list any
 *                     employee's requests; the payroll export
 * Emails follow a submission, a change request and each decision, without holding up the response.
 * Every change is audited with ids and outcomes.
 */

import { HTTP_STATUS } from '../constants/httpStatus.js';
import { LEAVE_MESSAGES } from '../constants/messages.js';
import { exportLeaveForPayroll } from '../services/leavePayrollExport.js';
import { notifyApproverOfRequest, notifyEmployeeOfDecision } from '../services/leaveRequestEmails.js';
import {
  approveLeaveRequest,
  cancelLeaveRequest,
  decideLeaveChange,
  getLeaveRequest,
  listApprovalQueue,
  listEmployeeLeaveRequests,
  previewLeaveRequest,
  rejectLeaveRequest,
  requestLeaveChange,
  submitLeaveRequest,
} from '../services/leaveRequests.js';
import { findOwnEmployeeProfileId, isWorkforceAdmin } from '../services/workforceAccess.js';
import {
  validateApprovalQueueQuery,
  validateChangeDecision,
  validateChangeRequest,
  validateDecision,
  validateLeaveRequestInput,
  validatePayrollExportQuery,
  validateRequestListQuery,
} from '../validators/leaveRequestValidators.js';
import { ADMIN_READ, ANY_VIEWER, employeesOnly, leaveHandler, requireOwnEmployeeId } from './leaveController.js';
import { idParamErrors } from './workforceHandler.js';

const ANY_WRITER = Object.freeze({ requiresWorkforceAdmin: false, isWrite: true });

/** The signed-in user as services/leaveRequests.js sees them (HR, or someone with a profile). */
async function leaveActorOf(req) {
  const employeeId = await findOwnEmployeeProfileId(req.user.id);
  if (!employeeId && !isWorkforceAdmin(req.user.role)) throw employeesOnly();
  return { userId: req.user.id, role: req.user.role, employeeId };
}

const appContextOf = (req) => ({
  companyName: req.app.locals.config.companyName,
  appPublicUrl: req.app.locals.config.appPublicUrl,
});

const requestAudit = (request, extra = {}) => ({
  leaveRequestId: request.id,
  employeeId: request.employee.id,
  leaveTypeId: request.leaveType.id,
  status: request.status,
  totalDays: request.totalDays,
  ...extra,
});

/** Runs `handlerBody` with a valid :requestId and the caller as a leave actor. */
const withRequest = (handlerBody) => async (req) => {
  const invalidParams = idParamErrors(req.params, 'requestId');
  if (invalidParams) return { validationErrors: invalidParams };
  return handlerBody(req, await leaveActorOf(req));
};

// =================================================================================================
// The employee's own requests
// =================================================================================================

/** POST /api/leave/requests/preview : what the leave would cost (nothing is saved) */
export const postPreview = leaveHandler('preview_leave_request', ANY_VIEWER, async (req) => {
  const validation = validateLeaveRequestInput(req.body, { isPreview: true });
  if (!validation.isValid) return validation;
  const employeeId = await requireOwnEmployeeId(req);
  return {
    message: LEAVE_MESSAGES.REQUEST_PREVIEWED,
    data: { preview: await previewLeaveRequest({ employeeId, input: validation.sanitizedInput }) },
  };
});

/** POST /api/leave/requests */
export const postRequest = leaveHandler('submit_leave_request', ANY_WRITER, async (req) => {
  const validation = validateLeaveRequestInput(req.body);
  if (!validation.isValid) return validation;
  const employeeId = await requireOwnEmployeeId(req);
  const request = await submitLeaveRequest({ employeeId, actorUserId: req.user.id, input: validation.sanitizedInput });
  notifyApproverOfRequest(request, appContextOf(req));
  return {
    httpStatus: HTTP_STATUS.CREATED,
    message: LEAVE_MESSAGES.REQUEST_SUBMITTED,
    data: { request },
    auditDetails: requestAudit(request, { approverEmployeeId: request.approverEmployeeId }),
  };
});

/** GET /api/leave/requests[?leaveYear=&status=] */
export const getOwnRequests = leaveHandler('list_own_leave_requests', ANY_VIEWER, async (req) => {
  const validation = validateRequestListQuery(req.query);
  if (!validation.isValid) return validation;
  const employeeId = await requireOwnEmployeeId(req);
  return {
    message: LEAVE_MESSAGES.REQUESTS_RETRIEVED,
    data: { requests: await listEmployeeLeaveRequests({ employeeId, ...validation.sanitizedInput }) },
  };
});

/** GET /api/leave/requests/:requestId */
export const getRequest = leaveHandler(
  'view_leave_request',
  ANY_VIEWER,
  withRequest(async (req, actor) => ({
    message: LEAVE_MESSAGES.REQUEST_RETRIEVED,
    data: { request: await getLeaveRequest({ requestId: req.params.requestId, actor }) },
  })),
);

/** POST /api/leave/requests/:requestId/cancel : withdraw a pending request, or cancel leave not yet started */
export const postCancel = leaveHandler(
  'cancel_leave_request',
  ANY_WRITER,
  withRequest(async (req, actor) => {
    const { request, wasWithdrawn } = await cancelLeaveRequest({ requestId: req.params.requestId, actor });
    return {
      message: wasWithdrawn ? LEAVE_MESSAGES.REQUEST_WITHDRAWN : LEAVE_MESSAGES.REQUEST_CANCELLED,
      data: { request },
      auditDetails: requestAudit(request, { wasWithdrawn }),
    };
  }),
);

/** POST /api/leave/requests/:requestId/change { kind, newEndDate?, newEndDayPortion?, reason } */
export const postChange = leaveHandler(
  'request_leave_change',
  ANY_WRITER,
  withRequest(async (req, actor) => {
    const validation = validateChangeRequest(req.body);
    if (!validation.isValid) return validation;
    const request = await requestLeaveChange({ requestId: req.params.requestId, actor, ...validation.sanitizedInput });
    notifyApproverOfRequest(request, appContextOf(req));
    return {
      message: LEAVE_MESSAGES.CHANGE_REQUESTED,
      data: { request },
      auditDetails: requestAudit(request, { changeKind: validation.sanitizedInput.kind }),
    };
  }),
);

// =================================================================================================
// Decisions
// =================================================================================================

/** GET /api/leave/approvals[?queue=requests|changes] */
export const getApprovalQueue = leaveHandler('list_leave_approvals', ANY_VIEWER, async (req) => {
  const validation = validateApprovalQueueQuery(req.query);
  if (!validation.isValid) return validation;
  const actor = await leaveActorOf(req);
  return {
    message: LEAVE_MESSAGES.REQUESTS_RETRIEVED,
    data: { requests: await listApprovalQueue({ actor, ...validation.sanitizedInput }) },
  };
});

function decisionHandler(action, { decide, noteRequired, message, isApproved }) {
  return leaveHandler(
    action,
    ANY_WRITER,
    withRequest(async (req, actor) => {
      const validation = validateDecision(req.body, { noteRequired });
      if (!validation.isValid) return validation;
      const { note } = validation.sanitizedInput;
      const request = await decide({ requestId: req.params.requestId, actor, note });
      notifyEmployeeOfDecision(
        request,
        { isApproved, isChange: false, deciderName: req.user.name, note },
        appContextOf(req),
      );
      return { message, data: { request }, auditDetails: requestAudit(request) };
    }),
  );
}

/** POST /api/leave/requests/:requestId/approve { note? } */
export const postApprove = decisionHandler('approve_leave_request', {
  decide: approveLeaveRequest,
  noteRequired: false,
  message: LEAVE_MESSAGES.REQUEST_APPROVED,
  isApproved: true,
});

/** POST /api/leave/requests/:requestId/reject { note } */
export const postReject = decisionHandler('reject_leave_request', {
  decide: rejectLeaveRequest,
  noteRequired: true,
  message: LEAVE_MESSAGES.REQUEST_REJECTED,
  isApproved: false,
});

/** POST /api/leave/requests/:requestId/change/decision { approve, note? } */
export const postChangeDecision = leaveHandler(
  'decide_leave_change',
  ANY_WRITER,
  withRequest(async (req, actor) => {
    const validation = validateChangeDecision(req.body);
    if (!validation.isValid) return validation;
    const { isApproved, note } = validation.sanitizedInput;
    const request = await decideLeaveChange({ requestId: req.params.requestId, actor, isApproved, note });
    notifyEmployeeOfDecision(
      request,
      { isApproved, isChange: true, deciderName: req.user.name, note },
      appContextOf(req),
    );
    return {
      message: isApproved ? LEAVE_MESSAGES.CHANGE_APPROVED : LEAVE_MESSAGES.CHANGE_REJECTED,
      data: { request },
      auditDetails: requestAudit(request, { changeApproved: isApproved }),
    };
  }),
);

// =================================================================================================
// HR
// =================================================================================================

/** GET /api/leave/employees/:employeeId/requests[?leaveYear=&status=] */
export const getRequestsOfEmployee = leaveHandler('list_leave_requests', ADMIN_READ, async (req) => {
  const invalidParams = idParamErrors(req.params, 'employeeId');
  if (invalidParams) return { validationErrors: invalidParams };
  const validation = validateRequestListQuery(req.query);
  if (!validation.isValid) return validation;
  return {
    message: LEAVE_MESSAGES.REQUESTS_RETRIEVED,
    data: {
      requests: await listEmployeeLeaveRequests({ employeeId: req.params.employeeId, ...validation.sanitizedInput }),
    },
  };
});

/** GET /api/leave/payroll-export?month=YYYY-MM[&changedSince=] */
export const getPayrollExport = leaveHandler('export_leave_for_payroll', ADMIN_READ, async (req) => {
  const validation = validatePayrollExportQuery(req.query);
  if (!validation.isValid) return validation;
  return {
    message: LEAVE_MESSAGES.PAYROLL_EXPORT_RETRIEVED,
    data: await exportLeaveForPayroll(validation.sanitizedInput),
  };
});
