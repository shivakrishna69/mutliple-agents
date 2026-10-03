/**
 * Public invitation routes, mounted at /api/invitations (controllers/invitationController.js).
 * No session or CSRF: the unguessable token in the path is the credential. Rate-limited per client
 * IP so the token space cannot be scanned and password setting cannot be hammered.
 */

import { Router } from 'express';
import { getInvitationPreview, postAcceptInvitation } from '../controllers/invitationController.js';
import { invitationLookupRateLimitByClientIp } from '../middleware/rateLimiter.js';

const invitationRouter = Router();

invitationRouter.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  // The token is in the URL: never send it on to other sites as a Referer.
  res.set('Referrer-Policy', 'no-referrer');
  next();
});
invitationRouter.get('/:token', invitationLookupRateLimitByClientIp, getInvitationPreview);
invitationRouter.post('/:token/accept', invitationLookupRateLimitByClientIp, postAcceptInvitation);

export default invitationRouter;
