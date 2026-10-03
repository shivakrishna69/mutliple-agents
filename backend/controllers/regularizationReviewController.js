/**
 * Manager review of attendance regularization requests the AI agent escalated
 * (models/RegularizationReview.js). Mounted under /api/attendance, behind `protect`.
 *
 *   GET  /regularization-reviews?status=Pending|Approved|Rejected
 *        Reporting managers see the reviews of the people who report to them; HR and admins see
 *        all reviews. Anyone else: 403.
 *   POST /regularization-reviews/:reviewId/decision   { decision: "approve" | "reject", punchInTime?, note? }
 *        approve  writes an Attendance entry for the review's date at punchInTime (local "HH:MM" in
 *                 the employee's office time zone) with method "manager_approved" and the reviewer
 *                 as approvedByUserId, through the same rules as every regularization
 *                 (services/attendanceRegularization.js: window, shift, status, duplicates)
 *        reject   records the decision only
 *
 * Authorisation for a decision: the review's reporting manager, or an HR user or admin; never the
 * employee the review is about (no self-approval, even for HR). Decisions are final; two reviewers
 * deciding at once get one success and one 409 (optimistic concurrency).
 *
 * Ordering without a transaction: the Attendance entry is written first, then the review is marked
 * Approved. If marking fails, repeating the decision is safe: the entry already exists, so the
 * write returns it (newlyCreated false) and the review is linked to it.
 */

import mongoose from 'mongoose';
import { HTTP_STATUS } from '../constants/httpStatus.js';
import { REGULARIZATION_MESSAGES } from '../constants/messages.js';
import { REGULARIZATION_METHODS } from '../models/Attendance.js';
import EmployeeProfile from '../models/EmployeeProfile.js';
import OfficeLocation from '../models/OfficeLocation.js';
import RegularizationReview, { REVIEW_STATUSES } from '../models/RegularizationReview.js';
import User, { ROLES } from '../models/User.js';
import { zonedLocalTimeToInstant } from '../services/attendancePolicy.js';
import { RegularizationRuleError, recordRegularizedAttendance, toRegularizedAttendanceSummary } from '../services/attendanceRegularization.js';
import { sendCodedError, sendError, sendSuccess } from '../utils/apiResponse.js';
import { AUDIT_OUTCOMES, recordAuditEvent } from '../utils/auditLogger.js';
import { isValidObjectIdString } from '../validators/conversationValidators.js';
import { REVIEW_DECISIONS, validateReviewDecision } from '../validators/regularizationValidators.js';
import { toReviewSummary } from './internalAttendanceController.js';

const REVIEW_LIST_LIMIT = 100;
/** Roles that may review any employee's request. */
const ORGANISATION_WIDE_REVIEWER_ROLES = Object.freeze([ROLES.ADMIN, ROLES.HR]);

function auditReview(req, action, outcome, details) {
  recordAuditEvent(req, { category: 'attendance', action, outcome, ...details });
}

async function findOwnProfileId(userId) {
  const ownProfile = await EmployeeProfile.findOne({ userId }).select('_id').lean();
  return ownProfile ? ownProfile._id.toString() : null;
}

/** GET /api/attendance/regularization-reviews */
export async function listRegularizationReviews(req, res, next) {
  try {
    const requestedStatus = typeof req.query.status === 'string' ? req.query.status : REVIEW_STATUSES.PENDING;
    if (!Object.values(REVIEW_STATUSES).includes(requestedStatus)) {
      return sendError(req, res, HTTP_STATUS.BAD_REQUEST, 'status must be Pending, Approved, or Rejected', [{ field: 'status', message: 'status must be Pending, Approved, or Rejected' }]);
    }

    const isOrganisationWideReviewer = ORGANISATION_WIDE_REVIEWER_ROLES.includes(req.user.role);
    const ownProfileId = await findOwnProfileId(req.user.id);
    if (!isOrganisationWideReviewer && !ownProfileId) {
      return sendError(req, res, HTTP_STATUS.FORBIDDEN, REGULARIZATION_MESSAGES.REVIEWS_FORBIDDEN);
    }
    const reviewFilter = isOrganisationWideReviewer ? { status: requestedStatus } : { status: requestedStatus, reportingManagerId: ownProfileId };

    const reviewRecords = await RegularizationReview.find(reviewFilter).sort({ createdAt: 1 }).limit(REVIEW_LIST_LIMIT).lean();

    // Names and job titles of the employees the reviews are about, for the reviewer's list.
    const employeeProfiles = await EmployeeProfile.find({ _id: { $in: reviewRecords.map((reviewRecord) => reviewRecord.employeeId) } })
      .select('userId organizationData.designation')
      .lean();
    const employeeAccounts = await User.find({ _id: { $in: employeeProfiles.map((employeeProfile) => employeeProfile.userId) } }).select('name').lean();
    const accountNameById = new Map(employeeAccounts.map((employeeAccount) => [employeeAccount._id.toString(), employeeAccount.name]));
    const employeeById = new Map(
      employeeProfiles.map((employeeProfile) => [
        employeeProfile._id.toString(),
        { name: accountNameById.get(employeeProfile.userId.toString()) ?? null, designation: employeeProfile.organizationData.designation },
      ]),
    );

    return sendSuccess(res, HTTP_STATUS.OK, REGULARIZATION_MESSAGES.REVIEWS_RETRIEVED, {
      reviews: reviewRecords.map((reviewRecord) => ({ ...toReviewSummary(reviewRecord), employee: employeeById.get(reviewRecord.employeeId.toString()) ?? null })),
      meta: { count: reviewRecords.length, limit: REVIEW_LIST_LIMIT, scope: isOrganisationWideReviewer ? 'organisation' : 'direct_reports' },
    });
  } catch (error) {
    return next(error);
  }
}

/** POST /api/attendance/regularization-reviews/:reviewId/decision */
export async function decideRegularizationReview(req, res, next) {
  try {
    const { reviewId } = req.params;
    if (!isValidObjectIdString(reviewId)) {
      return sendError(req, res, HTTP_STATUS.BAD_REQUEST, REGULARIZATION_MESSAGES.INVALID_REVIEW_ID, [{ field: 'reviewId', message: REGULARIZATION_MESSAGES.INVALID_REVIEW_ID }]);
    }
    const decisionValidation = validateReviewDecision(req.body);
    if (!decisionValidation.isValid) {
      return sendError(req, res, HTTP_STATUS.BAD_REQUEST, decisionValidation.validationErrors[0].message, decisionValidation.validationErrors);
    }
    const { decision, punchInTime, note } = decisionValidation.sanitizedInput;

    const reviewRecord = await RegularizationReview.findById(reviewId);
    if (!reviewRecord) return sendError(req, res, HTTP_STATUS.NOT_FOUND, REGULARIZATION_MESSAGES.REVIEW_NOT_FOUND);

    // ---- Authorisation ---------------------------------------------------------------------------
    const ownProfileId = await findOwnProfileId(req.user.id);
    const auditContext = { reviewId, employeeId: reviewRecord.employeeId.toString(), decision };
    if (ownProfileId && reviewRecord.employeeId.toString() === ownProfileId) {
      auditReview(req, 'decide_review', AUDIT_OUTCOMES.DENIED, { ...auditContext, reason: 'own_request' });
      return sendError(req, res, HTTP_STATUS.FORBIDDEN, REGULARIZATION_MESSAGES.CANNOT_DECIDE_OWN_REVIEW);
    }
    const isReportingManager = Boolean(ownProfileId && reviewRecord.reportingManagerId && reviewRecord.reportingManagerId.toString() === ownProfileId);
    if (!isReportingManager && !ORGANISATION_WIDE_REVIEWER_ROLES.includes(req.user.role)) {
      auditReview(req, 'decide_review', AUDIT_OUTCOMES.DENIED, { ...auditContext, reason: 'not_reviewer' });
      return sendError(req, res, HTTP_STATUS.FORBIDDEN, ownProfileId ? REGULARIZATION_MESSAGES.REVIEW_NOT_YOURS : REGULARIZATION_MESSAGES.REVIEWS_FORBIDDEN);
    }
    if (reviewRecord.status !== REVIEW_STATUSES.PENDING) {
      return sendError(req, res, HTTP_STATUS.CONFLICT, REGULARIZATION_MESSAGES.REVIEW_ALREADY_DECIDED);
    }

    // ---- Approve: write the Attendance entry first ---------------------------------------------
    let writeResult = null;
    if (decision === REVIEW_DECISIONS.APPROVE) {
      if (!reviewRecord.date) return sendError(req, res, HTTP_STATUS.CONFLICT, REGULARIZATION_MESSAGES.REVIEW_HAS_NO_DATE);
      const employeeProfile = await EmployeeProfile.findById(reviewRecord.employeeId).select('organizationData.officeLocationId').lean();
      const office = employeeProfile?.organizationData.officeLocationId ? await OfficeLocation.findById(employeeProfile.organizationData.officeLocationId).select('timeZone').lean() : null;
      if (!office) {
        return sendCodedError(req, res, HTTP_STATUS.CONFLICT, { code: 'OFFICE_NOT_CONFIGURED', message: 'The employee has no office with a shift configured' });
      }
      const punchInInstant = zonedLocalTimeToInstant(reviewRecord.date, punchInTime, office.timeZone);
      if (!punchInInstant) {
        return sendError(req, res, HTTP_STATUS.UNPROCESSABLE_CONTENT, REGULARIZATION_MESSAGES.PUNCH_TIME_DOES_NOT_EXIST, [{ field: 'punchInTime', message: REGULARIZATION_MESSAGES.PUNCH_TIME_DOES_NOT_EXIST }]);
      }
      try {
        writeResult = await recordRegularizedAttendance({
          employeeId: reviewRecord.employeeId.toString(),
          date: reviewRecord.date,
          punchInTime: punchInInstant,
          method: REGULARIZATION_METHODS.MANAGER_APPROVED,
          approvedByUserId: req.user.id,
          reviewId: reviewRecord._id,
          evidenceEventCount: reviewRecord.qualifyingEventCount,
          reason: reviewRecord.reason,
        });
      } catch (ruleError) {
        if (!(ruleError instanceof RegularizationRuleError)) throw ruleError;
        auditReview(req, 'decide_review', AUDIT_OUTCOMES.REJECTED, { ...auditContext, reason: ruleError.code });
        return sendCodedError(req, res, ruleError.httpStatus, { code: ruleError.code, message: ruleError.message });
      }
    }

    // ---- Record the decision -----------------------------------------------------------------
    reviewRecord.status = decision === REVIEW_DECISIONS.APPROVE ? REVIEW_STATUSES.APPROVED : REVIEW_STATUSES.REJECTED;
    reviewRecord.decision = {
      decidedByUserId: req.user.id,
      decidedAt: new Date(),
      note,
      approvedPunchInTime: punchInTime,
      attendanceId: writeResult ? writeResult.attendance._id : null,
    };
    try {
      await reviewRecord.save();
    } catch (saveError) {
      if (saveError instanceof mongoose.Error.VersionError) {
        return sendError(req, res, HTTP_STATUS.CONFLICT, REGULARIZATION_MESSAGES.REVIEW_CONCURRENT_UPDATE);
      }
      throw saveError;
    }

    auditReview(req, 'decide_review', AUDIT_OUTCOMES.ALLOWED, {
      ...auditContext,
      attendanceId: writeResult ? writeResult.attendance._id.toString() : null,
      newlyCreated: writeResult ? writeResult.newlyCreated : null,
    });
    return sendSuccess(res, HTTP_STATUS.OK, REGULARIZATION_MESSAGES.REVIEW_DECIDED, {
      review: toReviewSummary(reviewRecord),
      attendance: writeResult ? toRegularizedAttendanceSummary(writeResult.attendance) : null,
      newlyCreated: writeResult ? writeResult.newlyCreated : null,
    });
  } catch (error) {
    return next(error);
  }
}
