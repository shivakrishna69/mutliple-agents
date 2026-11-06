/**
 * System routes, mounted in server.js under `/api/system`.
 *
 *   GET /health   the state of the services the portal depends on (administrators only)
 *
 * Distinct from the public /api/health probe, which only says whether this instance can serve.
 */

import { Router } from 'express';
import { getSystemHealth } from '../controllers/systemController.js';
import { protect } from '../middleware/authMiddleware.js';

const systemRouter = Router();

systemRouter.use(protect, (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
systemRouter.get('/health', getSystemHealth);

export default systemRouter;
