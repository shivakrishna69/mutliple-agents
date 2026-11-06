/**
 * Onboarding offers (routes/onboardingRoutes.js; rules in services/onboardingService.js). HR and
 * administrators only: everyone else gets 403 ONBOARDING_MESSAGES.HR_ONLY, and the refusal is
 * audited. Every change and every calculation is audited too (category "onboarding"); audit
 * records name drafts and users by id, never the candidate's details.
 *
 *   GET   /settings                   the compensation policy and offer terms
 *   PATCH /settings                   change them { compensation?, offerTerms?, version }
 *   POST  /calculate                  the structure (and with includePreview, a watermarked letter)
 *   POST  /create-draft               save the offer for review (201)
 *   GET   /drafts?status=             drafts, newest first
 *   GET   /drafts/:draftId            one draft
 *   PATCH /drafts/:draftId            change it while it waits for review { ...offer, version }
 *   POST  /drafts/:draftId/cancel     { version }
 *   POST  /drafts/:draftId/dispatch   send it: 200 when the email went out, 202 when the employee
 *                                     was created but the email failed (dispatch again to retry)
 */

import { HTTP_STATUS } from '../constants/httpStatus.js';
import { ONBOARDING_MESSAGES } from '../constants/messages.js';
import { DRAFT_STATUSES } from '../models/OnboardingDraft.js';
import { loadEmailContext } from '../services/companySettings.js';
import {
  calculateOffer,
  cancelDraft,
  createDraft,
  dispatchDraft,
  getDraft,
  getOnboardingSettings,
  listDrafts,
  toSettingsSummary,
  updateDraft,
  updateOnboardingSettings,
} from '../services/onboardingService.js';
import {
  validateOfferEdit,
  validateOfferInput,
  validateSettingsChanges,
  validateVersionOnly,
} from '../validators/onboardingValidators.js';
import { createWorkforceHandlerFactory, idParamErrors } from './workforceHandler.js';

const onboardingHandler = createWorkforceHandlerFactory({
  auditCategory: 'onboarding',
  restrictedMessage: ONBOARDING_MESSAGES.HR_ONLY,
  inputInvalidMessage: ONBOARDING_MESSAGES.INPUT_INVALID,
});
const HR_READ = Object.freeze({ requiresWorkforceAdmin: true, isWrite: false });
const HR_AUDITED = Object.freeze({ requiresWorkforceAdmin: true, isWrite: true });

export const getSettings = onboardingHandler('view_onboarding_settings', HR_READ, async () => ({
  message: ONBOARDING_MESSAGES.SETTINGS_RETRIEVED,
  data: { settings: toSettingsSummary(await getOnboardingSettings()) },
}));

export const patchSettings = onboardingHandler('update_onboarding_settings', HR_AUDITED, async (req) => {
  const validation = validateSettingsChanges(req.body);
  if (!validation.isValid) return { validationErrors: validation.validationErrors };
  const settings = await updateOnboardingSettings({ ...validation.sanitizedInput, actorUserId: req.user.id });
  return { message: ONBOARDING_MESSAGES.SETTINGS_UPDATED, data: { settings } };
});

export const postCalculation = onboardingHandler('calculate_offer', HR_AUDITED, async (req) => {
  const validation = validateOfferInput(req.body);
  if (!validation.isValid) return { validationErrors: validation.validationErrors };
  const result = await calculateOffer(validation.sanitizedInput);
  return {
    message: ONBOARDING_MESSAGES.CALCULATED,
    data: result,
    auditDetails: { withPreview: validation.sanitizedInput.includePreview },
  };
});

export const postDraft = onboardingHandler('create_offer_draft', HR_AUDITED, async (req) => {
  const validation = validateOfferInput(req.body);
  if (!validation.isValid) return { validationErrors: validation.validationErrors };
  const draft = await createDraft({ offer: validation.sanitizedInput, actorUserId: req.user.id });
  return {
    httpStatus: HTTP_STATUS.CREATED,
    message: ONBOARDING_MESSAGES.DRAFT_CREATED,
    data: { draft },
    auditDetails: { draftId: draft.id },
  };
});

export const getDrafts = onboardingHandler('list_offer_drafts', HR_READ, async (req) => {
  const { status } = req.query;
  if (status !== undefined && !Object.values(DRAFT_STATUSES).includes(status)) {
    return {
      validationErrors: [{ field: 'status', message: `must be one of ${Object.values(DRAFT_STATUSES).join(', ')}` }],
    };
  }
  return { message: ONBOARDING_MESSAGES.DRAFTS_RETRIEVED, data: { drafts: await listDrafts({ status }) } };
});

export const getOneDraft = onboardingHandler('view_offer_draft', HR_READ, async (req) => {
  const paramErrors = idParamErrors(req.params, 'draftId');
  if (paramErrors) return { validationErrors: paramErrors };
  return { message: ONBOARDING_MESSAGES.DRAFT_RETRIEVED, data: { draft: await getDraft(req.params.draftId) } };
});

export const patchDraft = onboardingHandler('update_offer_draft', HR_AUDITED, async (req) => {
  const paramErrors = idParamErrors(req.params, 'draftId');
  if (paramErrors) return { validationErrors: paramErrors };
  const validation = validateOfferEdit(req.body);
  if (!validation.isValid) return { validationErrors: validation.validationErrors };
  const { version, ...offer } = validation.sanitizedInput;
  const draft = await updateDraft({ draftId: req.params.draftId, offer, version, actorUserId: req.user.id });
  return { message: ONBOARDING_MESSAGES.DRAFT_UPDATED, data: { draft }, auditDetails: { draftId: draft.id } };
});

export const postCancellation = onboardingHandler('cancel_offer_draft', HR_AUDITED, async (req) => {
  const paramErrors = idParamErrors(req.params, 'draftId');
  if (paramErrors) return { validationErrors: paramErrors };
  const validation = validateVersionOnly(req.body);
  if (!validation.isValid) return { validationErrors: validation.validationErrors };
  const draft = await cancelDraft({
    draftId: req.params.draftId,
    version: validation.sanitizedInput.version,
    actorUserId: req.user.id,
  });
  return { message: ONBOARDING_MESSAGES.DRAFT_CANCELLED, data: { draft }, auditDetails: { draftId: draft.id } };
});

export const postDispatch = onboardingHandler('dispatch_offer', HR_AUDITED, async (req) => {
  const paramErrors = idParamErrors(req.params, 'draftId');
  if (paramErrors) return { validationErrors: paramErrors };
  const { draft, wasSent } = await dispatchDraft({
    draftId: req.params.draftId,
    actor: { id: req.user.id, name: req.user.name, role: req.user.role },
    appContext: await loadEmailContext(req.app.locals.config),
  });
  return {
    httpStatus: wasSent ? HTTP_STATUS.OK : HTTP_STATUS.ACCEPTED,
    message: wasSent ? ONBOARDING_MESSAGES.DISPATCHED : ONBOARDING_MESSAGES.DISPATCH_EMAIL_FAILED,
    data: { draft },
    auditDetails: { draftId: draft.id, employeeCode: draft.dispatch.employeeCode, emailSent: wasSent },
  };
});
