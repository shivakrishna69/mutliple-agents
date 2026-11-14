/**
 * The NSK assistant, mounted at /api/nsk-bot (controllers/nskBotController.js): signed-in people with
 * USE_NSK_ASSISTANT only (403 otherwise). Messages and changes are rate limited per person. The
 * offboarding routes (controllers/offboardingController.js) each require their own capability too.
 */

import { Router } from 'express';
import { CAPABILITIES } from '../constants/accessRoles.js';
import { NSK_BOT_MESSAGES } from '../constants/messages.js';
import { deleteNskSession, getNskSession, getNskSessions, postNskMessage } from '../controllers/nskBotController.js';
import {
  deleteOffboardingCase,
  getArtifactDownload,
  getItChecklist,
  getOffboardingCase,
  getOffboardingCases,
  postOffboardingExecute,
  postOffboardingPreview,
} from '../controllers/offboardingController.js';
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

// Offboarding (controllers/offboardingController.js): each route checks its own capability.
nskBotRouter.post('/offboarding/preview', nskWriteRateLimitByUser, postOffboardingPreview);
nskBotRouter.post('/offboarding/execute', nskWriteRateLimitByUser, postOffboardingExecute);
nskBotRouter.get('/offboarding/cases', getOffboardingCases);
nskBotRouter.get('/offboarding/cases/:caseId', getOffboardingCase);
nskBotRouter.delete('/offboarding/cases/:caseId', nskWriteRateLimitByUser, deleteOffboardingCase);
nskBotRouter.get('/offboarding/it-checklist', getItChecklist);
nskBotRouter.get('/artifacts/:artifactId/download', nskWriteRateLimitByUser, getArtifactDownload);

export default nskBotRouter;
