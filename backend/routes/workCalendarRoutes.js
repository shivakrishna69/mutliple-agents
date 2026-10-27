/**
 * Work calendar routes, mounted at /api/work-calendar. All require a signed-in session (and the
 * CSRF token on changes); controllers/workCalendarController.js decides who may do what. Offices
 * and their weekly offs are under /api/offices (routes/officeRoutes.js).
 *
 *   GET    /holidays?year=YYYY[&officeLocationId=]   holidays (employees: their office's)
 *   POST   /holidays                                 add a holiday (HR, admins)
 *   PATCH  /holidays/:holidayId                      change a holiday (HR, admins)
 *   DELETE /holidays/:holidayId                      remove a holiday (HR, admins)
 *   GET    /days?from=&to=[&officeLocationId=]       each day as working / weekly off / holiday
 */

import { Router } from 'express';
import {
  getCalendarDays,
  getHolidays,
  patchHoliday,
  postHoliday,
  removeHoliday,
} from '../controllers/workCalendarController.js';
import { protect } from '../middleware/authMiddleware.js';
import { workplaceSetupWriteRateLimitByUser } from '../middleware/rateLimiter.js';

const workCalendarRouter = Router();

workCalendarRouter.use(protect, (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
workCalendarRouter.get('/holidays', getHolidays);
workCalendarRouter.post('/holidays', workplaceSetupWriteRateLimitByUser, postHoliday);
workCalendarRouter.patch('/holidays/:holidayId', workplaceSetupWriteRateLimitByUser, patchHoliday);
workCalendarRouter.delete('/holidays/:holidayId', workplaceSetupWriteRateLimitByUser, removeHoliday);
workCalendarRouter.get('/days', getCalendarDays);

export default workCalendarRouter;
