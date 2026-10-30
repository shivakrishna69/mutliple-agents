/**
 * Company routes, mounted at /api/company (controllers/companyController.js).
 *
 *   GET   /branding    name, short code, logo and colours (public, for the sign-in page)
 *   GET   /settings    the full settings (HR and administrators)
 *   PATCH /settings    change them (administrators; send version)
 */

import { Router } from 'express';
import {
  getCompanyBranding,
  getCompanySettingsHandler,
  patchCompanySettings,
} from '../controllers/companyController.js';
import { protect } from '../middleware/authMiddleware.js';
import { workplaceSetupWriteRateLimitByUser } from '../middleware/rateLimiter.js';

const companyRouter = Router();

companyRouter.get('/branding', getCompanyBranding);
companyRouter.use(protect, (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
companyRouter.get('/settings', getCompanySettingsHandler);
companyRouter.patch('/settings', workplaceSetupWriteRateLimitByUser, patchCompanySettings);

export default companyRouter;
