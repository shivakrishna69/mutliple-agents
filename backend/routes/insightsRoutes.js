/**
 * The daily briefing, mounted at /api/insights (controllers/insightsController.js). Signed in; never
 * cached by the browser (it changes as leave and tasks move).
 *
 *   GET /daily-briefing
 */

import { Router } from 'express';
import { getBriefing } from '../controllers/insightsController.js';
import { protect } from '../middleware/authMiddleware.js';

const insightsRouter = Router();

insightsRouter.use(protect, (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
insightsRouter.get('/daily-briefing', getBriefing);

export default insightsRouter;
