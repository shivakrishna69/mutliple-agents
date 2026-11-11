/**
 * Onboarding offer routes, mounted in server.js under `/api/hr/onboarding` (HR and administrators;
 * controllers/onboardingController.js lists them). Answers hold compensation and personal data and
 * are never cached. Calculations (a preview renders a PDF) and dispatches (each sends an email)
 * have their own per-user rate limits.
 */

import { Router } from 'express';
import { EMPLOYEE_IMPORT_MESSAGES } from '../constants/messages.js';
import { EMPLOYEE_IMPORT_LIMITS } from '../constants/validation.js';
import {
  getDrafts,
  getOneDraft,
  getSettings,
  patchDraft,
  patchSettings,
  postBulkSend,
  postCalculation,
  postCancellation,
  postDispatch,
  postDraft,
  postDraftImport,
} from '../controllers/onboardingController.js';
import { protect } from '../middleware/authMiddleware.js';
import {
  offerBulkSendRateLimitByUser,
  offerCalculationRateLimitByUser,
  offerDispatchRateLimitByUser,
  offerImportRateLimitByUser,
} from '../middleware/rateLimiter.js';
import { createSingleFileUpload } from '../middleware/singleFileUpload.js';

// An offer CSV: the employee import's file limits and messages.
const receiveOfferFile = createSingleFileUpload({
  maxFileBytes: EMPLOYEE_IMPORT_LIMITS.MAX_FILE_BYTES,
  logLabel: 'Offer import',
  messages: {
    fileTooLarge: EMPLOYEE_IMPORT_MESSAGES.FILE_TOO_LARGE,
    fileRequired: EMPLOYEE_IMPORT_MESSAGES.FILE_REQUIRED,
    malformedUpload: EMPLOYEE_IMPORT_MESSAGES.MALFORMED_UPLOAD,
    multipartRequired: EMPLOYEE_IMPORT_MESSAGES.MULTIPART_REQUIRED,
  },
});

const onboardingRouter = Router();

onboardingRouter.use(protect, (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
onboardingRouter.get('/settings', getSettings);
onboardingRouter.patch('/settings', patchSettings);
onboardingRouter.post('/calculate', offerCalculationRateLimitByUser, postCalculation);
onboardingRouter.post('/create-draft', postDraft);
onboardingRouter.get('/drafts', getDrafts);
onboardingRouter.post('/drafts/import', offerImportRateLimitByUser, receiveOfferFile, postDraftImport);
onboardingRouter.post('/drafts/bulk-send', offerBulkSendRateLimitByUser, postBulkSend);
onboardingRouter.get('/drafts/:draftId', getOneDraft);
onboardingRouter.patch('/drafts/:draftId', patchDraft);
onboardingRouter.post('/drafts/:draftId/cancel', postCancellation);
onboardingRouter.post('/drafts/:draftId/dispatch', offerDispatchRateLimitByUser, postDispatch);

export default onboardingRouter;
