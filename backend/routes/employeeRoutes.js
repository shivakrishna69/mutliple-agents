/**
 * Employee record routes, mounted at /api/employees. HR and admins only; all require a signed-in
 * session and the CSRF token on changes. `:employeeId` is an EmployeeProfile id.
 *
 *   PUT /:employeeId/office    set the employee's base office ({ officeLocationId }, null clears it)
 */

import { Router } from 'express';
import { putEmployeeOffice } from '../controllers/officeController.js';
import { protect } from '../middleware/authMiddleware.js';
import { workplaceSetupWriteRateLimitByUser } from '../middleware/rateLimiter.js';

const employeeRouter = Router();

employeeRouter.use(protect, (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
employeeRouter.put('/:employeeId/office', workplaceSetupWriteRateLimitByUser, putEmployeeOffice);

export default employeeRouter;
