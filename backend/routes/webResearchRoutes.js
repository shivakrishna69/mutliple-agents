/**
 * Web research settings and cached pages, mounted at /api/web-research
 * (controllers/webResearchController.js): MANAGE_COMPANY_SETTINGS only (403 otherwise).
 */

import { Router } from 'express';
import { CAPABILITIES } from '../constants/accessRoles.js';
import { WEB_RESEARCH_MESSAGES } from '../constants/messages.js';
import { deleteSource, getSettings, getSources, putSettings } from '../controllers/webResearchController.js';
import { protect } from '../middleware/authMiddleware.js';
import { requireCapability } from '../middleware/requireRole.js';

const webResearchRouter = Router();

webResearchRouter.use(
  protect,
  requireCapability(CAPABILITIES.MANAGE_COMPANY_SETTINGS, WEB_RESEARCH_MESSAGES.NOT_ALLOWED),
  (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  },
);
webResearchRouter.get('/settings', getSettings);
webResearchRouter.put('/settings', putSettings);
webResearchRouter.get('/sources', getSources);
webResearchRouter.delete('/sources/:sourceId', deleteSource);

export default webResearchRouter;
