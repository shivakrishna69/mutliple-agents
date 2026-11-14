/**
 * Offboarding through NSK (services/nskBot/offboarding/offboardingService.js), mounted on the NSK
 * router (/api/nsk-bot, signed-in people with USE_NSK_ASSISTANT), each route with its own capability:
 *
 *   POST   /offboarding/preview            RUN_OFFBOARDING        { employeeId, separation, adjustments?,
 *                                                                  version? } → the draft case with its
 *                                                                  settlement, banner, notes, blockers
 *   POST   /offboarding/execute            RUN_OFFBOARDING        { caseId, version } → 202: notice
 *                                                                  started, documents queued (progress
 *                                                                  over Socket.IO, OFFBOARDING_PROGRESS);
 *                                                                  on a FAILED case, generation again
 *   GET    /offboarding/cases              VIEW_FINAL_SETTLEMENT  ?status=   newest first
 *   GET    /offboarding/cases/:caseId      VIEW_FINAL_SETTLEMENT
 *   DELETE /offboarding/cases/:caseId      RUN_OFFBOARDING        ?version=  a draft only
 *   GET    /offboarding/it-checklist       VIEW_IT_OFFBOARDING    who is serving notice; no pay figures
 *   GET    /artifacts/:artifactId/download USE_NSK_ASSISTANT, then the document's own roles
 *                                                                  (ARTIFACT_CAPABILITIES) → a 60-second link
 *
 * Every change and every download is audited (category "offboarding") with ids, never figures.
 */

import { CAPABILITIES } from '../constants/accessRoles.js';
import { HTTP_STATUS } from '../constants/httpStatus.js';
import { OFFBOARDING_MESSAGES } from '../constants/messages.js';
import {
  cancelDraft,
  createArtifactDownload,
  executeOffboarding,
  getCase,
  itChecklist,
  listCases,
  previewOffboarding,
} from '../services/nskBot/offboarding/offboardingService.js';
import {
  idParamErrors,
  validateCaseListQuery,
  validateOffboardingCancel,
  validateOffboardingExecute,
  validateOffboardingPreview,
} from '../validators/offboardingValidators.js';
import { createWorkforceHandlerFactory } from './workforceHandler.js';

export const OFFBOARDING_AUDIT_CATEGORY = 'offboarding';

const offboardingHandler = createWorkforceHandlerFactory({
  auditCategory: OFFBOARDING_AUDIT_CATEGORY,
  restrictedMessage: OFFBOARDING_MESSAGES.NOT_ALLOWED,
  inputInvalidMessage: OFFBOARDING_MESSAGES.INPUT_INVALID,
});
const viewHandler = createWorkforceHandlerFactory({
  auditCategory: OFFBOARDING_AUDIT_CATEGORY,
  restrictedMessage: OFFBOARDING_MESSAGES.VIEW_NOT_ALLOWED,
  inputInvalidMessage: OFFBOARDING_MESSAGES.INPUT_INVALID,
});
const checklistHandler = createWorkforceHandlerFactory({
  auditCategory: OFFBOARDING_AUDIT_CATEGORY,
  restrictedMessage: OFFBOARDING_MESSAGES.CHECKLIST_NOT_ALLOWED,
  inputInvalidMessage: OFFBOARDING_MESSAGES.INPUT_INVALID,
});

const actorOf = (req) => ({ id: req.user.id, role: req.user.role });
const RUN = Object.freeze({ capability: CAPABILITIES.RUN_OFFBOARDING, isWrite: true });
const VIEW = Object.freeze({ capability: CAPABILITIES.VIEW_FINAL_SETTLEMENT, isWrite: false });

export const postOffboardingPreview = offboardingHandler('preview_offboarding', RUN, async (req) => {
  const validation = validateOffboardingPreview(req.body);
  if (!validation.isValid) return { validationErrors: validation.validationErrors };
  const offboardingCase = await previewOffboarding({ actor: actorOf(req), input: validation.sanitizedInput });
  return {
    message: OFFBOARDING_MESSAGES.PREVIEWED,
    data: { case: offboardingCase },
    auditDetails: {
      caseId: offboardingCase.id,
      employeeId: offboardingCase.employeeId,
      version: offboardingCase.version,
    },
  };
});

export const postOffboardingExecute = offboardingHandler('execute_offboarding', RUN, async (req) => {
  const validation = validateOffboardingExecute(req.body);
  if (!validation.isValid) return { validationErrors: validation.validationErrors };
  const { offboardingCase, retried } = await executeOffboarding({ actor: actorOf(req), ...validation.sanitizedInput });
  return {
    httpStatus: HTTP_STATUS.ACCEPTED,
    message: retried ? OFFBOARDING_MESSAGES.RETRY_STARTED : OFFBOARDING_MESSAGES.STARTED,
    data: { case: offboardingCase },
    auditDetails: { caseId: offboardingCase.id, employeeId: offboardingCase.employeeId, retried },
  };
});

export const getOffboardingCases = viewHandler('list_offboarding_cases', VIEW, async (req) => {
  const validation = validateCaseListQuery(req.query);
  if (!validation.isValid) return { validationErrors: validation.validationErrors };
  return {
    message: OFFBOARDING_MESSAGES.CASES_RETRIEVED,
    data: { cases: await listCases({ actor: actorOf(req), ...validation.sanitizedInput }) },
  };
});

export const getOffboardingCase = viewHandler('view_offboarding_case', VIEW, async (req) => {
  const validationErrors = idParamErrors(req.params, 'caseId');
  if (validationErrors) return { validationErrors };
  return {
    message: OFFBOARDING_MESSAGES.CASE_RETRIEVED,
    data: { case: await getCase({ actor: actorOf(req), caseId: req.params.caseId }) },
  };
});

export const deleteOffboardingCase = offboardingHandler('cancel_offboarding', RUN, async (req) => {
  const validation = validateOffboardingCancel(req.params, req.query);
  if (!validation.isValid) return { validationErrors: validation.validationErrors };
  const offboardingCase = await cancelDraft({ actor: actorOf(req), ...validation.sanitizedInput });
  return {
    message: OFFBOARDING_MESSAGES.CANCELLED,
    data: { case: offboardingCase },
    auditDetails: { caseId: offboardingCase.id, employeeId: offboardingCase.employeeId },
  };
});

export const getItChecklist = checklistHandler(
  'view_it_offboarding_checklist',
  { capability: CAPABILITIES.VIEW_IT_OFFBOARDING, isWrite: false },
  async () => ({ message: OFFBOARDING_MESSAGES.CHECKLIST_RETRIEVED, data: await itChecklist() }),
);

// isWrite: every download is audited, allowed or refused.
export const getArtifactDownload = offboardingHandler(
  'download_offboarding_document',
  { capability: CAPABILITIES.USE_NSK_ASSISTANT, isWrite: true },
  async (req) => {
    const validationErrors = idParamErrors(req.params, 'artifactId');
    if (validationErrors) return { validationErrors };
    const download = await createArtifactDownload({ actor: actorOf(req), artifactId: req.params.artifactId });
    return {
      message: OFFBOARDING_MESSAGES.DOWNLOAD_READY,
      data: { download: download.download, kind: download.kind, caseId: download.caseId },
      auditDetails: {
        artifactId: req.params.artifactId,
        caseId: download.caseId,
        employeeId: download.employeeId,
        kind: download.kind,
      },
    };
  },
);
