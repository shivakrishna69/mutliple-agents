/**
 * Office routes, mounted at /api/offices. HR and admins only (controllers/officeController.js);
 * all require a signed-in session and the CSRF token on changes.
 *
 *   GET    /                     every office with its working day and weekly offs
 *   GET    /:officeLocationId    one office
 *   POST   /                     add an office (weekly offs default to Saturday and Sunday)
 *   PATCH  /:officeLocationId    change an office, including workday.weeklyOffRules (send version)
 *   DELETE /:officeLocationId    remove an office no employee, attendance or holiday refers to
 */

import { Router } from 'express';
import { getOfficeById, getOffices, patchOffice, postOffice, removeOffice } from '../controllers/officeController.js';
import { protect } from '../middleware/authMiddleware.js';
import { workplaceSetupWriteRateLimitByUser } from '../middleware/rateLimiter.js';

const officeRouter = Router();

officeRouter.use(protect, (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
officeRouter.get('/', getOffices);
officeRouter.get('/:officeLocationId', getOfficeById);
officeRouter.post('/', workplaceSetupWriteRateLimitByUser, postOffice);
officeRouter.patch('/:officeLocationId', workplaceSetupWriteRateLimitByUser, patchOffice);
officeRouter.delete('/:officeLocationId', workplaceSetupWriteRateLimitByUser, removeOffice);

export default officeRouter;
