/**
 * Presence routes, mounted at /api/presence. All need a signed-in session and the CSRF token on
 * changes. Live status changes arrive over Socket.IO (utils/socketManager.js "Presence").
 *
 *   GET  /me        my presence setup: recorded or not, Away threshold, the notice to acknowledge
 *   POST /notice    acknowledge the notice ({ version })
 */

import { Router } from 'express';
import { getOwnPresence, postNoticeAcknowledgement } from '../controllers/presenceController.js';
import { protect } from '../middleware/authMiddleware.js';

const presenceRouter = Router();

presenceRouter.use(protect, (req, res, next) => {
  // Responses describe people's activity; never cache them.
  res.set('Cache-Control', 'no-store');
  next();
});
presenceRouter.get('/me', getOwnPresence);
presenceRouter.post('/notice', postNoticeAcknowledgement);

export default presenceRouter;
