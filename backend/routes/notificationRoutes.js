/**
 * The signed-in person's in-app notifications, mounted at /api/notifications
 * (controllers/notificationController.js lists the endpoints). A session is required; changes need
 * the CSRF token.
 */

import { Router } from 'express';
import {
  getNotifications,
  postAllNotificationsRead,
  postNotificationRead,
} from '../controllers/notificationController.js';
import { protect } from '../middleware/authMiddleware.js';
import { agentChatWriteRateLimitByUser } from '../middleware/rateLimiter.js';

const notificationRouter = Router();

notificationRouter.use(protect, (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
notificationRouter.get('/', getNotifications);
notificationRouter.post('/read-all', agentChatWriteRateLimitByUser, postAllNotificationsRead);
notificationRouter.post('/:notificationId/read', agentChatWriteRateLimitByUser, postNotificationRead);

export default notificationRouter;
