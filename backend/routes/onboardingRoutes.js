/**
 * Onboarding offer routes, mounted in server.js under `/api/hr/onboarding` (HR and administrators;
 * controllers/onboardingController.js lists them). Answers hold compensation and personal data and
 * are never cached. Calculations (a preview renders a PDF) and dispatches (each sends an email)
 * have their own per-user rate limits.
 */

import { Router } from 'express';
import {
  getDrafts,
  getOneDraft,
  getSettings,
  patchDraft,
  patchSettings,
  postCalculation,
  postCancellation,
  postDispatch,
  postDraft,
} from '../controllers/onboardingController.js';
import { protect } from '../middleware/authMiddleware.js';
import { offerCalculationRateLimitByUser, offerDispatchRateLimitByUser } from '../middleware/rateLimiter.js';

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
onboardingRouter.get('/drafts/:draftId', getOneDraft);
onboardingRouter.patch('/drafts/:draftId', patchDraft);
onboardingRouter.post('/drafts/:draftId/cancel', postCancellation);
onboardingRouter.post('/drafts/:draftId/dispatch', offerDispatchRateLimitByUser, postDispatch);

export default onboardingRouter;
