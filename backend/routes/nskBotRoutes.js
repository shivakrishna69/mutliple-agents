/**
 * The NSK assistant, mounted at /api/nsk-bot (controllers/nskBotController.js): signed-in people with
 * USE_NSK_ASSISTANT only (403 otherwise). Messages and deletions are rate limited per person.
 */

import { Router } from 'express';
import { CAPABILITIES } from '../constants/accessRoles.js';
import { NSK_BOT_MESSAGES } from '../constants/messages.js';
import { deleteNskSession, getNskSession, getNskSessions, postNskMessage } from '../controllers/nskBotController.js';
import { protect } from '../middleware/authMiddleware.js';
import { nskMessageRateLimitByUser, nskWriteRateLimitByUser } from '../middleware/rateLimiter.js';
import { requireCapability } from '../middleware/requireRole.js';

const nskBotRouter = Router();

nskBotRouter.use(
  protect,
  requireCapability(CAPABILITIES.USE_NSK_ASSISTANT, NSK_BOT_MESSAGES.ACCESS_DENIED),
  (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  },
);
nskBotRouter.get('/sessions', getNskSessions);
nskBotRouter.get('/sessions/:sessionId', getNskSession);
nskBotRouter.delete('/sessions/:sessionId', nskWriteRateLimitByUser, deleteNskSession);
nskBotRouter.post('/message', nskMessageRateLimitByUser, postNskMessage);

export default nskBotRouter;
