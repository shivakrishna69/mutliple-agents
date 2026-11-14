/**
 * Onboarding offers (routes/onboardingRoutes.js; rules in services/onboardingService.js), by
 * capability (constants/accessRoles.js): reading needs READ_OFFERS (admins, HR, Finance & Payroll),
 * the CTC calculator and the compensation policy MANAGE_COMPENSATION (the same), and preparing,
 * changing, cancelling or sending an offer, or the offer terms, MANAGE_OFFERS (admins, HR). Everyone
 * else gets 403 with the message naming who can, and the refusal is audited. Every change and every calculation is audited too (category "onboarding"); audit
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
 *   POST  /drafts/import              a CSV (multipart, field "file"): every row a draft for review
 *                                     (201), or nothing created and every problem by line and column
 *                                     (400, details { line, field, message })
 *   POST  /drafts/bulk-send           { draftIds }: each sent in turn (as dispatch); 200 with every
 *                                     draft's outcome (sent, email_failed, refused with its reason)
 */

import { CAPABILITIES, hasCapability } from '../constants/accessRoles.js';
import { HTTP_STATUS } from '../constants/httpStatus.js';
import {
  GENDER_LABELS,
  ONBOARDING_MESSAGES,
  PROFESSIONAL_TAX_STATE_LABELS,
  TAX_REGIME_LABELS,
} from '../constants/messages.js';
import { ONBOARDING_SETTINGS } from '../constants/validation.js';
import { DRAFT_STATUSES } from '../models/OnboardingDraft.js';
import { loadEmailContext } from '../services/companySettings.js';
import { importOfferDrafts } from '../services/offerImport.js';
import {
  calculateOffer,
  cancelDraft,
  createDraft,
  dispatchDraft,
  dispatchDrafts,
  getDraft,
  getOnboardingSettings,
  listDrafts,
  toSettingsSummary,
  updateDraft,
  updateOnboardingSettings,
} from '../services/onboardingService.js';
import {
  validateBulkSend,
  validateOfferEdit,
  validateOfferInput,
  validateSettingsChanges,
  validateVersionOnly,
} from '../validators/onboardingValidators.js';
import { ServiceError } from '../services/serviceError.js';
import { createWorkforceHandlerFactory, idParamErrors } from './workforceHandler.js';

const onboardingHandler = createWorkforceHandlerFactory({
  auditCategory: 'onboarding',
  restrictedMessage: ONBOARDING_MESSAGES.HR_ONLY,
  inputInvalidMessage: ONBOARDING_MESSAGES.INPUT_INVALID,
});
// Every offer endpoint is open to READ_OFFERS (admins, HR, Finance & Payroll); changes then need
// their own capability, so a refusal says exactly who can (and is audited).
const OFFERS_READ = Object.freeze({ capability: CAPABILITIES.READ_OFFERS, isWrite: false });
const OFFERS_AUDITED = Object.freeze({ capability: CAPABILITIES.READ_OFFERS, isWrite: true });

/** Refuses (403, audited) unless the user has `capability`. */
function requireCapability(req, capability, code) {
  if (!hasCapability(req.user.role, capability)) {
    throw new ServiceError(HTTP_STATUS.FORBIDDEN, code, ONBOARDING_MESSAGES[code]);
  }
}
const requireOfferManager = (req) => requireCapability(req, CAPABILITIES.MANAGE_OFFERS, 'OFFER_MANAGERS_ONLY');
const requireCompensationManager = (req) =>
  requireCapability(req, CAPABILITIES.MANAGE_COMPENSATION, 'COMPENSATION_MANAGERS_ONLY');

const asChoices = (labels) => Object.entries(labels).map(([value, label]) => ({ value, label }));

/** What the offer form offers and allows: the choices with their labels, and the limits. */
const OFFER_FORM_CHOICES = Object.freeze({
  professionalTaxStates: asChoices(PROFESSIONAL_TAX_STATE_LABELS),
  taxRegimes: asChoices(TAX_REGIME_LABELS),
  genders: asChoices(GENDER_LABELS),
  limits: {
    ctcMin: ONBOARDING_SETTINGS.CTC_LIMITS.MIN,
    ctcMax: ONBOARDING_SETTINGS.CTC_LIMITS.MAX,
    variablePayMaxBasisPoints: ONBOARDING_SETTINGS.VARIABLE_PAY_MAX_BASIS_POINTS,
    esopUnitsMax: ONBOARDING_SETTINGS.ESOP_UNITS_MAX,
    probationMonthsMax: ONBOARDING_SETTINGS.OFFER_TERM_LIMITS.PROBATION_MONTHS_MAX,
    noticePeriodDaysMax: ONBOARDING_SETTINGS.OFFER_TERM_LIMITS.NOTICE_PERIOD_DAYS_MAX,
    offerValidityDaysMax: ONBOARDING_SETTINGS.OFFER_TERM_LIMITS.OFFER_VALIDITY_DAYS_MAX,
    bulkSendMax: ONBOARDING_SETTINGS.BULK_SEND_MAX,
  },
});

export const getSettings = onboardingHandler('view_onboarding_settings', OFFERS_READ, async () => ({
  message: ONBOARDING_MESSAGES.SETTINGS_RETRIEVED,
  data: { settings: toSettingsSummary(await getOnboardingSettings()), choices: OFFER_FORM_CHOICES },
}));

export const patchSettings = onboardingHandler('update_onboarding_settings', OFFERS_AUDITED, async (req) => {
  const validation = validateSettingsChanges(req.body);
  if (!validation.isValid) return { validationErrors: validation.validationErrors };
  // The compensation policy is Finance's too; the offer terms are HR's.
  if (validation.sanitizedInput.changes.compensation) requireCompensationManager(req);
  if (validation.sanitizedInput.changes.offerTerms) requireOfferManager(req);
  const settings = await updateOnboardingSettings({ ...validation.sanitizedInput, actorUserId: req.user.id });
  return { message: ONBOARDING_MESSAGES.SETTINGS_UPDATED, data: { settings } };
});

export const postCalculation = onboardingHandler('calculate_offer', OFFERS_AUDITED, async (req) => {
  requireCompensationManager(req);
  const validation = validateOfferInput(req.body);
  if (!validation.isValid) return { validationErrors: validation.validationErrors };
  const result = await calculateOffer(validation.sanitizedInput);
  return {
    message: ONBOARDING_MESSAGES.CALCULATED,
    data: result,
    auditDetails: { withPreview: validation.sanitizedInput.includePreview },
  };
});

export const postDraft = onboardingHandler('create_offer_draft', OFFERS_AUDITED, async (req) => {
  requireOfferManager(req);
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

/** POST /drafts/import (multipart, field "file"): every row a draft for review, or every problem. */
export const postDraftImport = onboardingHandler('import_offer_drafts', OFFERS_AUDITED, async (req) => {
  requireOfferManager(req);
  const result = await importOfferDrafts(req.file.buffer, { importer: { id: req.user.id, role: req.user.role } });
  if (result.problems) {
    return { validationErrors: result.problems, validationMessage: ONBOARDING_MESSAGES.IMPORT_ROWS_INVALID };
  }
  return {
    httpStatus: HTTP_STATUS.CREATED,
    message: ONBOARDING_MESSAGES.IMPORTED(result.drafts.length),
    data: { drafts: result.drafts, ignoredColumns: result.ignoredColumns },
    auditDetails: { draftCount: result.drafts.length },
  };
});

/** POST /drafts/bulk-send { draftIds }: each sent in turn, every outcome reported. */
export const postBulkSend = onboardingHandler('bulk_send_offers', OFFERS_AUDITED, async (req) => {
  requireOfferManager(req);
  const validation = validateBulkSend(req.body);
  if (!validation.isValid) return { validationErrors: validation.validationErrors };
  const { results, counts } = await dispatchDrafts({
    draftIds: validation.sanitizedInput.draftIds,
    actor: { id: req.user.id, name: req.user.name, role: req.user.role },
    appContext: await loadEmailContext(req.app.locals.config),
  });
  return {
    message: ONBOARDING_MESSAGES.BULK_SENT(counts),
    data: { results, counts },
    auditDetails: { requested: results.length, ...counts },
  };
});

export const getDrafts = onboardingHandler('list_offer_drafts', OFFERS_READ, async (req) => {
  const { status } = req.query;
  if (status !== undefined && !Object.values(DRAFT_STATUSES).includes(status)) {
    return {
      validationErrors: [{ field: 'status', message: `must be one of ${Object.values(DRAFT_STATUSES).join(', ')}` }],
    };
  }
  return { message: ONBOARDING_MESSAGES.DRAFTS_RETRIEVED, data: { drafts: await listDrafts({ status }) } };
});

export const getOneDraft = onboardingHandler('view_offer_draft', OFFERS_READ, async (req) => {
  const paramErrors = idParamErrors(req.params, 'draftId');
  if (paramErrors) return { validationErrors: paramErrors };
  return { message: ONBOARDING_MESSAGES.DRAFT_RETRIEVED, data: { draft: await getDraft(req.params.draftId) } };
});

export const patchDraft = onboardingHandler('update_offer_draft', OFFERS_AUDITED, async (req) => {
  requireOfferManager(req);
  const paramErrors = idParamErrors(req.params, 'draftId');
  if (paramErrors) return { validationErrors: paramErrors };
  const validation = validateOfferEdit(req.body);
  if (!validation.isValid) return { validationErrors: validation.validationErrors };
  const { version, ...offer } = validation.sanitizedInput;
  const draft = await updateDraft({ draftId: req.params.draftId, offer, version, actorUserId: req.user.id });
  return { message: ONBOARDING_MESSAGES.DRAFT_UPDATED, data: { draft }, auditDetails: { draftId: draft.id } };
});

export const postCancellation = onboardingHandler('cancel_offer_draft', OFFERS_AUDITED, async (req) => {
  requireOfferManager(req);
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

export const postDispatch = onboardingHandler('dispatch_offer', OFFERS_AUDITED, async (req) => {
  requireOfferManager(req);
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
