/**
 * Analytics routes, mounted in server.js under `/api/analytics`.
 *
 *   GET /workforce-risk   attrition and burnout risk of current employees (HR and admins; audited)
 *
 * Responses contain sensitive inferred personal data and are never cached.
 */

import { Router } from 'express';
import { getWorkforceRiskReport } from '../controllers/analyticsController.js';
import { protect } from '../middleware/authMiddleware.js';
import { requireEmployeeWorkspace } from '../middleware/requireRole.js';

const analyticsRouter = Router();

analyticsRouter.use(protect, requireEmployeeWorkspace, (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
analyticsRouter.get('/workforce-risk', getWorkforceRiskReport);

export default analyticsRouter;
