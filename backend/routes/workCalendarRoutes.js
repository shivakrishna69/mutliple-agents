/**
 * Work calendar routes, mounted at /api/work-calendar. All require a signed-in session (and the
 * CSRF token on changes); controllers/workCalendarController.js decides who may do what.
 *
 *   GET    /offices                                  offices and their weekly offs (HR, admins)
 *   PATCH  /offices/:officeLocationId/weekly-offs    set an office's weekly offs (HR, admins)
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
  getOfficeCalendars,
  patchHoliday,
  patchOfficeWeeklyOffs,
  postHoliday,
  removeHoliday,
} from '../controllers/workCalendarController.js';
import { protect } from '../middleware/authMiddleware.js';
import { workCalendarWriteRateLimitByUser } from '../middleware/rateLimiter.js';

const workCalendarRouter = Router();

workCalendarRouter.use(protect, (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
workCalendarRouter.get('/offices', getOfficeCalendars);
workCalendarRouter.patch(
  '/offices/:officeLocationId/weekly-offs',
  workCalendarWriteRateLimitByUser,
  patchOfficeWeeklyOffs,
);
workCalendarRouter.get('/holidays', getHolidays);
workCalendarRouter.post('/holidays', workCalendarWriteRateLimitByUser, postHoliday);
workCalendarRouter.patch('/holidays/:holidayId', workCalendarWriteRateLimitByUser, patchHoliday);
workCalendarRouter.delete('/holidays/:holidayId', workCalendarWriteRateLimitByUser, removeHoliday);
workCalendarRouter.get('/days', getCalendarDays);

export default workCalendarRouter;
