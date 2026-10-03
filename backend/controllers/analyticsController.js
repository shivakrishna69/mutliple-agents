/**
 * Workforce analytics endpoints (services/workforceRiskService.js).
 *
 *   GET  /api/analytics/workforce-risk            HR and admins only (routes/analyticsRoutes.js)
 *        ?departmentId=&band=safe|elevated|critical|unscored&sortBy=attrition|burnout&limit=1..500
 *        200 { employees: [...], summary, thresholds }
 *   POST /api/internal/analytics/employee-scores  the scoring job (routes/internalRoutes.js,
 *        X-Internal-Api-Key)
 *        { model_version, scores: [{ employee_id, attrition_risk_index, current_burnout_score }] }
 *        200 { updated, unknownEmployeeIds }
 *
 * The scores are inferred, sensitive personal data. Every read is written to the audit log with the
 * viewer, the filters and how many employees were returned, so access can be reviewed. They are
 * decision support only and must not drive automated decisions about an individual.
 */

import { HTTP_STATUS } from '../constants/httpStatus.js';
import { ANALYTICS_MESSAGES } from '../constants/messages.js';
import { ROLES } from '../models/User.js';
import { RISK_BANDS, RISK_LIST_LIMITS, RISK_SORT_FIELDS, getWorkforceRisk, recordEmployeeScores } from '../services/workforceRiskService.js';
import { sendError, sendSuccess } from '../utils/apiResponse.js';
import { AUDIT_OUTCOMES, recordAuditEvent } from '../utils/auditLogger.js';
import { isValidObjectIdString } from '../validators/conversationValidators.js';

const ANALYTICS_VIEWER_ROLES = Object.freeze([ROLES.ADMIN, ROLES.HR]);
const MAX_SCORES_PER_BATCH = 1000;
const MODEL_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** GET /api/analytics/workforce-risk */
export async function getWorkforceRiskReport(req, res, next) {
  try {
    if (!ANALYTICS_VIEWER_ROLES.includes(req.user.role)) {
      recordAuditEvent(req, { category: 'analytics', action: 'view_workforce_risk', outcome: AUDIT_OUTCOMES.DENIED, reason: 'role_not_allowed' });
      return sendError(req, res, HTTP_STATUS.FORBIDDEN, ANALYTICS_MESSAGES.ANALYTICS_RESTRICTED);
    }

    const fieldErrors = [];
    const { departmentId, band, sortBy = RISK_SORT_FIELDS.ATTRITION, limit } = req.query;
    if (departmentId !== undefined && !isValidObjectIdString(departmentId)) fieldErrors.push({ field: 'departmentId', message: 'must be a department id' });
    if (band !== undefined && !Object.values(RISK_BANDS).includes(band)) fieldErrors.push({ field: 'band', message: `must be one of ${Object.values(RISK_BANDS).join(', ')}` });
    if (!Object.values(RISK_SORT_FIELDS).includes(sortBy)) fieldErrors.push({ field: 'sortBy', message: 'must be attrition or burnout' });
    const parsedLimit = limit === undefined ? RISK_LIST_LIMITS.DEFAULT : Number(limit);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > RISK_LIST_LIMITS.MAX) fieldErrors.push({ field: 'limit', message: `must be 1-${RISK_LIST_LIMITS.MAX}` });
    if (fieldErrors.length > 0) return sendError(req, res, HTTP_STATUS.BAD_REQUEST, ANALYTICS_MESSAGES.QUERY_INVALID, fieldErrors);

    const report = await getWorkforceRisk({ departmentId: departmentId ?? null, band: band ?? null, sortBy, limit: parsedLimit });
    recordAuditEvent(req, {
      category: 'analytics',
      action: 'view_workforce_risk',
      outcome: AUDIT_OUTCOMES.ALLOWED,
      filters: { departmentId: departmentId ?? null, band: band ?? null, sortBy, limit: parsedLimit },
      employeesReturned: report.employees.length,
    });
    return sendSuccess(res, HTTP_STATUS.OK, ANALYTICS_MESSAGES.RISK_REPORT_RETRIEVED, report);
  } catch (error) {
    return next(error);
  }
}

function isScore(candidateValue) {
  return typeof candidateValue === 'number' && Number.isFinite(candidateValue) && candidateValue >= 0 && candidateValue <= 100;
}

/** POST /api/internal/analytics/employee-scores */
export async function ingestEmployeeScores(req, res, next) {
  try {
    const { model_version: modelVersion, scores } = req.body ?? {};
    const fieldErrors = [];
    if (typeof modelVersion !== 'string' || !MODEL_VERSION_PATTERN.test(modelVersion)) fieldErrors.push({ field: 'model_version', message: 'must be 1-64 letters, digits, ".", "_" or "-"' });
    if (!Array.isArray(scores) || scores.length === 0 || scores.length > MAX_SCORES_PER_BATCH) {
      fieldErrors.push({ field: 'scores', message: `must be a list of 1-${MAX_SCORES_PER_BATCH} entries` });
    } else {
      const seenEmployeeIds = new Set();
      scores.forEach((score, scoreIndex) => {
        const employeeId = score?.employee_id;
        if (!isValidObjectIdString(employeeId)) fieldErrors.push({ field: `scores[${scoreIndex}].employee_id`, message: 'must be an employee id' });
        else if (seenEmployeeIds.has(employeeId.toLowerCase())) fieldErrors.push({ field: `scores[${scoreIndex}].employee_id`, message: 'appears more than once' });
        else seenEmployeeIds.add(employeeId.toLowerCase());
        if (!isScore(score?.attrition_risk_index)) fieldErrors.push({ field: `scores[${scoreIndex}].attrition_risk_index`, message: 'must be a number from 0 to 100' });
        if (!isScore(score?.current_burnout_score)) fieldErrors.push({ field: `scores[${scoreIndex}].current_burnout_score`, message: 'must be a number from 0 to 100' });
      });
    }
    if (fieldErrors.length > 0) return sendError(req, res, HTTP_STATUS.BAD_REQUEST, ANALYTICS_MESSAGES.SCORES_INVALID, fieldErrors.slice(0, 50));

    const result = await recordEmployeeScores({
      modelVersion,
      computedAt: new Date(),
      scores: scores.map((score) => ({ employeeId: score.employee_id.toLowerCase(), attritionRiskIndex: score.attrition_risk_index, currentBurnoutScore: score.current_burnout_score })),
    });
    recordAuditEvent(req, { category: 'analytics', action: 'ingest_scores', outcome: AUDIT_OUTCOMES.ALLOWED, actor: 'analytics_job', modelVersion, updated: result.updated, unknown: result.unknownEmployeeIds.length });
    return sendSuccess(res, HTTP_STATUS.OK, ANALYTICS_MESSAGES.SCORES_RECORDED, result);
  } catch (error) {
    return next(error);
  }
}
