/**
 * OKR routes, mounted in server.js under `/api/okrs`. All require a session (and the CSRF token on
 * POST/PATCH); who may read or change what is decided in services/okrService.js.
 *
 *   GET   /alignment
 *   POST  /objectives
 *   PATCH /objectives/:objectiveId
 *   POST  /objectives/:objectiveId/key-results
 *   PATCH /key-results/:keyResultId/progress
 *   POST  /key-results/:keyResultId/milestones
 *   PATCH /key-results/:keyResultId/milestones/:milestoneId
 */

import { Router } from 'express';
import { getAlignment, patchKeyResultProgress, patchMilestone, patchObjective, postKeyResult, postMilestone, postObjective } from '../controllers/okrController.js';
import { protect } from '../middleware/authMiddleware.js';
import { okrWriteRateLimitByUser } from '../middleware/rateLimiter.js';

const okrRouter = Router();

okrRouter.use(protect, (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
okrRouter.get('/alignment', getAlignment);
okrRouter.post('/objectives', okrWriteRateLimitByUser, postObjective);
okrRouter.patch('/objectives/:objectiveId', okrWriteRateLimitByUser, patchObjective);
okrRouter.post('/objectives/:objectiveId/key-results', okrWriteRateLimitByUser, postKeyResult);
okrRouter.patch('/key-results/:keyResultId/progress', okrWriteRateLimitByUser, patchKeyResultProgress);
okrRouter.post('/key-results/:keyResultId/milestones', okrWriteRateLimitByUser, postMilestone);
okrRouter.patch('/key-results/:keyResultId/milestones/:milestoneId', okrWriteRateLimitByUser, patchMilestone);

export default okrRouter;
