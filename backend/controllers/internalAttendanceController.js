/**
 * Internal attendance endpoints called by the ai-service's regularization agent
 * (ai-service app/nodes/attendance_agent.py BackendRegularizationSystems), mounted under
 * /api/internal and authenticated by requireInternalApiKey.
 *
 *   POST /attendance/regularizations
 *       Body: { employee_id, date, punch_in_time, evidence_event_count, reason, thread_id }
 *       201 { data: { attendance, newlyCreated: true } }     entry written (method automatic_evidence)
 *       200 { data: { attendance, newlyCreated: false } }    the day already had an entry; nothing written
 *       400 invalid body / 404 unknown employee / 409 employment ended or no office /
 *       422 outside the 7-day window, future date, or punch time outside the office shift
 *
 *   POST /attendance/regularization-reviews
 *       Body: { employee_id, date, claimed_punch_in_time, reason, routing_reason,
 *               qualifying_event_count, allowed_geofence_radius, idempotency_key }
 *       201 { data: { review } }   stored as Pending for the employee's reporting manager
 *       200 { data: { review } }   a review with the same idempotency_key already exists
 *       400 invalid body / 404 unknown employee
 *
 * Every write is audited (category "attendance"). The reporting manager and the employee's account
 * are always read from MongoDB, never taken from the request.
 */

import { HTTP_STATUS } from '../constants/httpStatus.js';
import { REGULARIZATION_MESSAGES } from '../constants/messages.js';
import { REGULARIZATION_METHODS } from '../models/Attendance.js';
import EmployeeProfile from '../models/EmployeeProfile.js';
import RegularizationReview from '../models/RegularizationReview.js';
import { RegularizationRuleError, recordRegularizedAttendance, toRegularizedAttendanceSummary } from '../services/attendanceRegularization.js';
import { sendCodedError, sendError, sendSuccess } from '../utils/apiResponse.js';
import { AUDIT_OUTCOMES, recordAuditEvent } from '../utils/auditLogger.js';
import { validateAgentRegularization, validateAgentReviewSubmission } from '../validators/regularizationValidators.js';

const DUPLICATE_KEY_ERROR_CODE = 11000;

function auditAgentAction(req, action, outcome, details) {
  recordAuditEvent(req, { category: 'attendance', action, outcome, actor: 'ai_service', ...details });
}

export function toReviewSummary(reviewRecord) {
  return {
    id: reviewRecord._id.toString(),
    employeeId: reviewRecord.employeeId.toString(),
    reportingManagerId: reviewRecord.reportingManagerId ? reviewRecord.reportingManagerId.toString() : null,
    date: reviewRecord.date,
    claimedPunchInTime: reviewRecord.claimedPunchInTime,
    reason: reviewRecord.reason,
    routingReason: reviewRecord.routingReason,
    qualifyingEventCount: reviewRecord.qualifyingEventCount,
    allowedGeofenceRadius: reviewRecord.allowedGeofenceRadius,
    status: reviewRecord.status,
    decision: reviewRecord.decision
      ? {
          decidedByUserId: reviewRecord.decision.decidedByUserId.toString(),
          decidedAt: new Date(reviewRecord.decision.decidedAt).toISOString(),
          note: reviewRecord.decision.note,
          approvedPunchInTime: reviewRecord.decision.approvedPunchInTime,
          attendanceId: reviewRecord.decision.attendanceId ? reviewRecord.decision.attendanceId.toString() : null,
        }
      : null,
    createdAt: new Date(reviewRecord.createdAt).toISOString(),
  };
}

/** POST /api/internal/attendance/regularizations */
export async function createAgentRegularization(req, res, next) {
  try {
    const inputValidation = validateAgentRegularization(req.body);
    if (!inputValidation.isValid) {
      return sendError(req, res, HTTP_STATUS.BAD_REQUEST, inputValidation.validationErrors[0].message, inputValidation.validationErrors);
    }
    const { employeeId, date, punchInTime, evidenceEventCount, reason, threadId } = inputValidation.sanitizedInput;

    let writeResult;
    try {
      writeResult = await recordRegularizedAttendance({
        employeeId,
        date,
        punchInTime,
        method: REGULARIZATION_METHODS.AUTOMATIC_EVIDENCE,
        evidenceEventCount,
        reason,
        sourceThreadId: threadId,
      });
    } catch (ruleError) {
      if (!(ruleError instanceof RegularizationRuleError)) throw ruleError;
      auditAgentAction(req, 'regularize', AUDIT_OUTCOMES.REJECTED, { employeeId, date, reason: ruleError.code });
      return sendCodedError(req, res, ruleError.httpStatus, { code: ruleError.code, message: ruleError.message });
    }

    const attendanceSummary = toRegularizedAttendanceSummary(writeResult.attendance);
    auditAgentAction(req, 'regularize', AUDIT_OUTCOMES.ALLOWED, {
      employeeId,
      date,
      attendanceId: attendanceSummary.id,
      newlyCreated: writeResult.newlyCreated,
      calculationStatus: attendanceSummary.calculationStatus,
      evidenceEventCount,
      sourceThreadId: threadId,
    });
    return sendSuccess(
      res,
      writeResult.newlyCreated ? HTTP_STATUS.CREATED : HTTP_STATUS.OK,
      writeResult.newlyCreated ? REGULARIZATION_MESSAGES.REGULARIZATION_RECORDED : REGULARIZATION_MESSAGES.REGULARIZATION_ALREADY_RECORDED,
      { attendance: attendanceSummary, newlyCreated: writeResult.newlyCreated },
    );
  } catch (error) {
    return next(error);
  }
}

/** POST /api/internal/attendance/regularization-reviews */
export async function fileAgentReview(req, res, next) {
  try {
    const inputValidation = validateAgentReviewSubmission(req.body);
    if (!inputValidation.isValid) {
      return sendError(req, res, HTTP_STATUS.BAD_REQUEST, inputValidation.validationErrors[0].message, inputValidation.validationErrors);
    }
    const reviewInput = inputValidation.sanitizedInput;

    const existingReview = await RegularizationReview.findOne({ idempotencyKey: reviewInput.idempotencyKey }).lean();
    if (existingReview) {
      return sendSuccess(res, HTTP_STATUS.OK, REGULARIZATION_MESSAGES.REVIEW_ALREADY_FILED, { review: toReviewSummary(existingReview) });
    }

    const employeeProfile = await EmployeeProfile.findById(reviewInput.employeeId).select('userId organizationData.reportingManagerId').lean();
    if (!employeeProfile) {
      return sendCodedError(req, res, HTTP_STATUS.NOT_FOUND, { code: 'EMPLOYEE_NOT_FOUND', message: 'Employee not found' });
    }

    let storedReview;
    try {
      storedReview = await RegularizationReview.create({
        employeeId: employeeProfile._id,
        requestedByUserId: employeeProfile.userId,
        reportingManagerId: employeeProfile.organizationData.reportingManagerId ?? null,
        date: reviewInput.date,
        claimedPunchInTime: reviewInput.claimedPunchInTime,
        reason: reviewInput.reason,
        routingReason: reviewInput.routingReason,
        qualifyingEventCount: reviewInput.qualifyingEventCount,
        allowedGeofenceRadius: reviewInput.allowedGeofenceRadius,
        idempotencyKey: reviewInput.idempotencyKey,
      });
    } catch (writeError) {
      if (writeError?.code !== DUPLICATE_KEY_ERROR_CODE) throw writeError;
      // A concurrent retry stored it first.
      const racedReview = await RegularizationReview.findOne({ idempotencyKey: reviewInput.idempotencyKey }).lean();
      return sendSuccess(res, HTTP_STATUS.OK, REGULARIZATION_MESSAGES.REVIEW_ALREADY_FILED, { review: toReviewSummary(racedReview) });
    }

    auditAgentAction(req, 'file_review', AUDIT_OUTCOMES.ALLOWED, {
      reviewId: storedReview._id.toString(),
      employeeId: reviewInput.employeeId,
      date: reviewInput.date,
      routingReason: reviewInput.routingReason,
    });
    return sendSuccess(res, HTTP_STATUS.CREATED, REGULARIZATION_MESSAGES.REVIEW_FILED, { review: toReviewSummary(storedReview) });
  } catch (error) {
    return next(error);
  }
}
