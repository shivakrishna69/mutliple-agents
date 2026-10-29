/**
 * Service-to-service routes, mounted in server.js under `/api/internal`. Called only by the
 * ai-service; authenticated by requireInternalApiKey (no user session, no CSRF).
 *
 *   POST /attendance/regularizations         write a regularized Attendance entry (agent approval)
 *   POST /attendance/regularization-reviews  file a review for the employee's manager
 *   POST /analytics/employee-scores          the scoring job writes attrition / burnout scores
 *   POST /agent-telemetry/events             live agent telemetry, relayed to admin sockets
 *   GET  /leave/types                        the leave assistant's reads (controllers/internalLeaveController.js):
 *   GET  /leave/employees/:id/balances       types, balances, requests and the office calendar of the
 *   GET  /leave/employees/:id/requests       employee the backend asked about, and what a leave would
 *   GET  /leave/employees/:id/calendar       cost; nothing is written
 *   POST /leave/employees/:id/preview
 *
 * In production these routes should also be unreachable from the public internet (expose them
 * only on the internal network, or block /api/internal at the load balancer); the key is the
 * application-level control, the network boundary the second one.
 */

import { Router } from 'express';
import { ingestAgentTelemetry } from '../controllers/agentTelemetryController.js';
import { ingestEmployeeScores } from '../controllers/analyticsController.js';
import { createAgentRegularization, fileAgentReview } from '../controllers/internalAttendanceController.js';
import {
  getAssistantBalances,
  getAssistantCalendar,
  getAssistantLeaveTypes,
  getAssistantRequests,
  postAssistantPreview,
} from '../controllers/internalLeaveController.js';
import { requireInternalApiKey } from '../middleware/requireInternalApiKey.js';

const internalRouter = Router();

internalRouter.use(requireInternalApiKey, (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
internalRouter.post('/attendance/regularizations', createAgentRegularization);
internalRouter.post('/attendance/regularization-reviews', fileAgentReview);
internalRouter.post('/analytics/employee-scores', ingestEmployeeScores);
internalRouter.post('/agent-telemetry/events', ingestAgentTelemetry);
internalRouter.get('/leave/types', getAssistantLeaveTypes);
internalRouter.get('/leave/employees/:employeeId/balances', getAssistantBalances);
internalRouter.get('/leave/employees/:employeeId/requests', getAssistantRequests);
internalRouter.get('/leave/employees/:employeeId/calendar', getAssistantCalendar);
internalRouter.post('/leave/employees/:employeeId/preview', postAssistantPreview);

export default internalRouter;
