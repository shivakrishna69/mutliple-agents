/**
 * HR/admin onboarding routes, mounted at /api/people (controllers/peopleController.js).
 * All behind `protect` (session + CSRF on writes); the role check is in each handler.
 */

import { Router } from 'express';
import { getInvitationOptions, getInvitations, postInvitation, postResendInvitation, postRevokeInvitation } from '../controllers/peopleController.js';
import { protect } from '../middleware/authMiddleware.js';
import { invitationSendRateLimitByUser } from '../middleware/rateLimiter.js';

const peopleRouter = Router();

peopleRouter.use(protect, (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
peopleRouter.get('/invitations/options', getInvitationOptions);
peopleRouter.get('/invitations', getInvitations);
peopleRouter.post('/invitations', invitationSendRateLimitByUser, postInvitation);
peopleRouter.post('/invitations/:invitationId/resend', invitationSendRateLimitByUser, postResendInvitation);
peopleRouter.post('/invitations/:invitationId/revoke', postRevokeInvitation);

export default peopleRouter;
