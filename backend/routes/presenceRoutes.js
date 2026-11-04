/**
 * Presence routes, mounted at /api/presence. All need a signed-in session and the CSRF token on
 * changes. Live status changes arrive over Socket.IO (utils/realtime/presenceHandlers.js).
 *
 *   GET  /me                  my presence setup: recorded or not, Away threshold, the notice
 *   POST /notice              acknowledge the notice ({ version })
 *   GET  /me/daily?from=&to=  my own days: online, available, away and punched-in minutes
 *   GET  /now?departmentId=   who is available, away, offline, on leave or off work (HR and
 *                             administrators: everyone; managers: their reports; others 403)
 *   GET  /daily?date=&departmentId=  everyone's numbers for a day (same audience)
 */

import { Router } from 'express';
import {
  getDaily,
  getNow,
  getOwnDaily,
  getOwnPresence,
  postNoticeAcknowledgement,
} from '../controllers/presenceController.js';
import { protect } from '../middleware/authMiddleware.js';

const presenceRouter = Router();

presenceRouter.use(protect, (req, res, next) => {
  // Responses describe people's activity; never cache them.
  res.set('Cache-Control', 'no-store');
  next();
});
presenceRouter.get('/me', getOwnPresence);
presenceRouter.post('/notice', postNoticeAcknowledgement);
presenceRouter.get('/me/daily', getOwnDaily);
presenceRouter.get('/now', getNow);
presenceRouter.get('/daily', getDaily);

export default presenceRouter;
