/**
 * Today's attendance (services/attendanceToday.js), mounted under /api/attendance:
 *
 *   GET /today?date=YYYY-MM-DD&departmentId=<id>
 *       The Today board. HR and administrators see everyone (or one department); team leads see
 *       the people who report to them; anyone else gets 403 TODAY_FORBIDDEN. Without `date`, each
 *       person's own today in their office's time zone.
 *   GET /me/today
 *       The signed-in employee's own day, for their punch screen; 404 PROFILE_NOT_FOUND without an
 *       employee profile.
 */

import { HTTP_STATUS } from '../constants/httpStatus.js';
import { ATTENDANCE_MESSAGES } from '../constants/messages.js';
import { getMyAttendanceDay, getTodayBoard } from '../services/attendanceToday.js';
import { ServiceError } from '../services/serviceError.js';
import { isRealCalendarDate } from '../utils/calendarDates.js';
import { isValidObjectIdString } from '../validators/conversationValidators.js';
import { createWorkforceHandlerFactory } from './workforceHandler.js';

const todayHandler = createWorkforceHandlerFactory({
  auditCategory: 'attendance',
  restrictedMessage: ATTENDANCE_MESSAGES.TODAY_FORBIDDEN,
  inputInvalidMessage: ATTENDANCE_MESSAGES.TODAY_QUERY_INVALID,
});

const ANYONE_READ = Object.freeze({ requiresWorkforceAdmin: false, isWrite: false });

/** GET /api/attendance/today */
export const getToday = todayHandler('view_today_board', ANYONE_READ, async (req) => {
  const { date, departmentId } = req.query;
  const validationErrors = [];
  if (date !== undefined && !isRealCalendarDate(date)) {
    validationErrors.push({ field: 'date', message: 'must be a real date written YYYY-MM-DD' });
  }
  if (departmentId !== undefined && !isValidObjectIdString(departmentId)) {
    validationErrors.push({ field: 'departmentId', message: 'must be a department id' });
  }
  if (validationErrors.length > 0) return { validationErrors };
  return {
    message: ATTENDANCE_MESSAGES.TODAY_RETRIEVED,
    data: await getTodayBoard({ viewer: req.user, date: date ?? null, departmentId: departmentId ?? null }),
  };
});

/** GET /api/attendance/me/today */
export const getMyToday = todayHandler('view_own_day', ANYONE_READ, async (req) => {
  const day = await getMyAttendanceDay({ userId: req.user.id });
  if (!day) throw new ServiceError(HTTP_STATUS.NOT_FOUND, 'PROFILE_NOT_FOUND', ATTENDANCE_MESSAGES.PROFILE_NOT_FOUND);
  return { message: ATTENDANCE_MESSAGES.MY_DAY_RETRIEVED, data: { day } };
});
