/**
 * Dashboard routes, mounted in server.js under `/api/dashboard`.
 *
 *   GET /overview?range=today|7d|30d   the signed-in person's dashboard (sections by role)
 *
 * Answers hold personal and organisation data and are never cached.
 */

import { Router } from 'express';
import { getDashboardOverview } from '../controllers/dashboardController.js';
import { protect } from '../middleware/authMiddleware.js';

const dashboardRouter = Router();

dashboardRouter.use(protect, (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
dashboardRouter.get('/overview', getDashboardOverview);

export default dashboardRouter;
