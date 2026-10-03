/**
 * OKR endpoints (routes/okrRoutes.js, mounted at /api/okrs). Rules and the alignment tree live in
 * services/okrService.js; these handlers validate input, resolve the viewer, and shape responses.
 *
 *   GET   /alignment?year=&quarter=                       the quarter's canvas: company goals →
 *                                                          team objectives → key results + milestones
 *   POST  /objectives                                     create a company or team objective
 *   PATCH /objectives/:objectiveId                        edit title/description/owner, archive
 *   POST  /objectives/:objectiveId/key-results            add a key result
 *   PATCH /key-results/:keyResultId/progress              slider: currentValue or progressPercent
 *   POST  /key-results/:keyResultId/milestones            add a milestone
 *   PATCH /key-results/:keyResultId/milestones/:milestoneId  complete / reopen / edit a milestone
 *
 * Every write returns the updated key result or objective node with its new `version`; clients send
 * that version with their next edit, and a stale one is rejected with 409. Writes are audited.
 */

import { HTTP_STATUS } from '../constants/httpStatus.js';
import { OKR_MESSAGES } from '../constants/messages.js';
import { computeKeyResultProgress } from '../models/KeyResult.js';
import {
  OkrError,
  addKeyResult,
  addMilestone,
  buildAlignmentTree,
  canViewOkrs,
  createObjective,
  loadOkrViewer,
  updateKeyResultProgress,
  updateMilestone,
  updateObjective,
} from '../services/okrService.js';
import { sendCodedError, sendError, sendSuccess } from '../utils/apiResponse.js';
import { AUDIT_OUTCOMES, recordAuditEvent } from '../utils/auditLogger.js';
import { isValidObjectIdString } from '../validators/conversationValidators.js';
import {
  validateKeyResultCreation,
  validateMilestoneChanges,
  validateMilestoneCreation,
  validateObjectiveChanges,
  validateObjectiveCreation,
  validateProgressUpdate,
} from '../validators/okrValidators.js';

function toObjectiveSummary(objective) {
  return {
    id: objective._id.toString(),
    title: objective.title,
    description: objective.description,
    level: objective.level,
    period: { year: objective.period.year, quarter: objective.period.quarter },
    parentObjectiveId: objective.parentObjectiveId ? objective.parentObjectiveId.toString() : null,
    departmentId: objective.departmentId ? objective.departmentId.toString() : null,
    ownerEmployeeId: objective.ownerEmployeeId.toString(),
    status: objective.status,
    version: objective.__v,
  };
}

function toKeyResultSummary(keyResult) {
  return {
    id: keyResult._id.toString(),
    objectiveId: keyResult.objectiveId.toString(),
    title: keyResult.title,
    ownerEmployeeId: keyResult.ownerEmployeeId.toString(),
    unit: keyResult.unit,
    startValue: keyResult.startValue,
    targetValue: keyResult.targetValue,
    currentValue: keyResult.currentValue,
    progress: computeKeyResultProgress(keyResult),
    weight: keyResult.weight,
    milestones: keyResult.milestones.map((milestone) => ({
      id: milestone._id.toString(),
      title: milestone.title,
      dueDate: milestone.dueDate,
      status: milestone.status,
      completedAt: milestone.completedAt ? milestone.completedAt.toISOString() : null,
    })),
    status: keyResult.status,
    version: keyResult.__v,
  };
}

/**
 * Wraps a handler: resolves the viewer (403 if they may not use OKRs at all), maps OkrError to its
 * status and code, and audits writes.
 */
function okrHandler(action, handlerBody, { isWrite = true } = {}) {
  return async (req, res, next) => {
    try {
      const viewer = await loadOkrViewer(req.user);
      if (!canViewOkrs(viewer)) return sendError(req, res, HTTP_STATUS.FORBIDDEN, OKR_MESSAGES.OKRS_EMPLOYEES_ONLY);
      try {
        const handlerResult = await handlerBody(req, viewer);
        if (handlerResult.validationErrors) {
          return sendError(req, res, HTTP_STATUS.BAD_REQUEST, OKR_MESSAGES.INPUT_INVALID, handlerResult.validationErrors);
        }
        if (isWrite) recordAuditEvent(req, { category: 'okr', action, outcome: AUDIT_OUTCOMES.ALLOWED, ...handlerResult.auditDetails });
        return sendSuccess(res, handlerResult.httpStatus ?? HTTP_STATUS.OK, handlerResult.message, handlerResult.data);
      } catch (okrError) {
        if (!(okrError instanceof OkrError)) throw okrError;
        if (isWrite) recordAuditEvent(req, { category: 'okr', action, outcome: okrError.httpStatus === 403 ? AUDIT_OUTCOMES.DENIED : AUDIT_OUTCOMES.REJECTED, reason: okrError.code });
        return sendCodedError(req, res, okrError.httpStatus, { code: okrError.code, message: okrError.message });
      }
    } catch (error) {
      return next(error);
    }
  };
}

function idParamErrors(params, paramNames) {
  const validationErrors = paramNames.filter((paramName) => !isValidObjectIdString(params[paramName])).map((paramName) => ({ field: paramName, message: 'must be a valid id' }));
  return validationErrors.length ? { validationErrors } : null;
}

/** GET /api/okrs/alignment?year=&quarter= */
export const getAlignment = okrHandler(
  'view_alignment',
  async (req, viewer) => {
    const year = Number(req.query.year);
    const quarter = Number(req.query.quarter);
    const validationErrors = [];
    if (!Number.isInteger(year) || year < 2000 || year > 2100) validationErrors.push({ field: 'year', message: 'must be a year' });
    if (!Number.isInteger(quarter) || quarter < 1 || quarter > 4) validationErrors.push({ field: 'quarter', message: 'must be 1-4' });
    if (validationErrors.length) return { validationErrors };
    return { message: OKR_MESSAGES.ALIGNMENT_RETRIEVED, data: await buildAlignmentTree(viewer, { year, quarter }) };
  },
  { isWrite: false },
);

/** POST /api/okrs/objectives */
export const postObjective = okrHandler('create_objective', async (req, viewer) => {
  const validation = validateObjectiveCreation(req.body);
  if (!validation.isValid) return validation;
  const objective = await createObjective(viewer, validation.sanitizedInput);
  return { httpStatus: HTTP_STATUS.CREATED, message: OKR_MESSAGES.OBJECTIVE_CREATED, data: { objective: toObjectiveSummary(objective) }, auditDetails: { objectiveId: objective._id.toString(), level: objective.level } };
});

/** PATCH /api/okrs/objectives/:objectiveId */
export const patchObjective = okrHandler('update_objective', async (req, viewer) => {
  const paramErrors = idParamErrors(req.params, ['objectiveId']);
  if (paramErrors) return paramErrors;
  const validation = validateObjectiveChanges(req.body);
  if (!validation.isValid) return validation;
  const objective = await updateObjective(viewer, req.params.objectiveId, validation.sanitizedInput);
  return { message: OKR_MESSAGES.OBJECTIVE_UPDATED, data: { objective: toObjectiveSummary(objective) }, auditDetails: { objectiveId: req.params.objectiveId } };
});

/** POST /api/okrs/objectives/:objectiveId/key-results */
export const postKeyResult = okrHandler('create_key_result', async (req, viewer) => {
  const paramErrors = idParamErrors(req.params, ['objectiveId']);
  if (paramErrors) return paramErrors;
  const validation = validateKeyResultCreation(req.body);
  if (!validation.isValid) return validation;
  const keyResult = await addKeyResult(viewer, req.params.objectiveId, validation.sanitizedInput);
  return { httpStatus: HTTP_STATUS.CREATED, message: OKR_MESSAGES.KEY_RESULT_CREATED, data: { keyResult: toKeyResultSummary(keyResult) }, auditDetails: { objectiveId: req.params.objectiveId, keyResultId: keyResult._id.toString() } };
});

/** PATCH /api/okrs/key-results/:keyResultId/progress */
export const patchKeyResultProgress = okrHandler('update_progress', async (req, viewer) => {
  const paramErrors = idParamErrors(req.params, ['keyResultId']);
  if (paramErrors) return paramErrors;
  const validation = validateProgressUpdate(req.body);
  if (!validation.isValid) return validation;
  const keyResult = await updateKeyResultProgress(viewer, req.params.keyResultId, validation.sanitizedInput);
  return { message: OKR_MESSAGES.PROGRESS_UPDATED, data: { keyResult: toKeyResultSummary(keyResult) }, auditDetails: { keyResultId: req.params.keyResultId, currentValue: keyResult.currentValue } };
});

/** POST /api/okrs/key-results/:keyResultId/milestones */
export const postMilestone = okrHandler('create_milestone', async (req, viewer) => {
  const paramErrors = idParamErrors(req.params, ['keyResultId']);
  if (paramErrors) return paramErrors;
  const validation = validateMilestoneCreation(req.body);
  if (!validation.isValid) return validation;
  const keyResult = await addMilestone(viewer, req.params.keyResultId, validation.sanitizedInput);
  return { httpStatus: HTTP_STATUS.CREATED, message: OKR_MESSAGES.MILESTONE_CREATED, data: { keyResult: toKeyResultSummary(keyResult) }, auditDetails: { keyResultId: req.params.keyResultId } };
});

/** PATCH /api/okrs/key-results/:keyResultId/milestones/:milestoneId */
export const patchMilestone = okrHandler('update_milestone', async (req, viewer) => {
  const paramErrors = idParamErrors(req.params, ['keyResultId', 'milestoneId']);
  if (paramErrors) return paramErrors;
  const validation = validateMilestoneChanges(req.body);
  if (!validation.isValid) return validation;
  const keyResult = await updateMilestone(viewer, req.params.keyResultId, req.params.milestoneId, validation.sanitizedInput);
  return { message: OKR_MESSAGES.MILESTONE_UPDATED, data: { keyResult: toKeyResultSummary(keyResult) }, auditDetails: { keyResultId: req.params.keyResultId, milestoneId: req.params.milestoneId, status: validation.sanitizedInput.status } };
});
