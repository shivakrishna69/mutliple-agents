/**
 * Service-to-service routes, mounted in server.js under `/api/internal`. Called only by the
 * ai-service; authenticated by requireInternalApiKey (no user session, no CSRF).
 *
 *   POST /attendance/regularizations         write a regularized Attendance entry (agent approval)
 *   POST /attendance/regularization-reviews  file a review for the employee's manager
 *
 * In production these routes should also be unreachable from the public internet (expose them
 * only on the internal network, or block /api/internal at the load balancer); the key is the
 * application-level control, the network boundary the second one.
 */

import { Router } from 'express';
import { createAgentRegularization, fileAgentReview } from '../controllers/internalAttendanceController.js';
import { requireInternalApiKey } from '../middleware/requireInternalApiKey.js';

const internalRouter = Router();

internalRouter.use(requireInternalApiKey, (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
internalRouter.post('/attendance/regularizations', createAgentRegularization);
internalRouter.post('/attendance/regularization-reviews', fileAgentReview);

export default internalRouter;
