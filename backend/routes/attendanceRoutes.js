/**
 * Attendance routes, mounted in server.js under `/api/attendance`.
 *
 *   POST /punch-in                                       record today's arrival (office punches geofenced)
 *   POST /punch-out                                      close it (forgotten ones close automatically)
 *   GET  /me/today                                       my day: office, radius, modes I may use, my punch
 *   GET  /today?date=&departmentId=                      who is working (team leads: their team; HR: everyone)
 *   POST /regularize                                     talk to the attendance regularization agent
 *   GET  /regularization-reviews                         escalated requests to review (managers, HR, admins)
 *   POST /regularization-reviews/:reviewId/decision      approve or reject one
 *
 * `protect` verifies the session (and the CSRF token on POST) and loads req.user. The per-user rate
 * limits stop a script from sweeping coordinates to map the geofence boundary, and from spending
 * model calls through the regularization agent.
 */

import { Router } from 'express';
import { punchIn, punchOut, regularizeAttendance } from '../controllers/attendanceController.js';
import { getMyToday, getToday } from '../controllers/attendanceTodayController.js';
import {
  decideRegularizationReview,
  listRegularizationReviews,
} from '../controllers/regularizationReviewController.js';
import { protect } from '../middleware/authMiddleware.js';
import { attendancePunchRateLimitByUser, regularizationRateLimitByUser } from '../middleware/rateLimiter.js';

const attendanceRouter = Router();

attendanceRouter.use(protect, (req, res, next) => {
  // Responses describe one person's location and attendance; never cache them.
  res.set('Cache-Control', 'no-store');
  next();
});
attendanceRouter.post('/punch-in', attendancePunchRateLimitByUser, punchIn);
attendanceRouter.post('/punch-out', attendancePunchRateLimitByUser, punchOut);
attendanceRouter.get('/me/today', getMyToday);
attendanceRouter.get('/today', getToday);
attendanceRouter.post('/regularize', regularizationRateLimitByUser, regularizeAttendance);
attendanceRouter.get('/regularization-reviews', listRegularizationReviews);
attendanceRouter.post('/regularization-reviews/:reviewId/decision', decideRegularizationReview);

export default attendanceRouter;
