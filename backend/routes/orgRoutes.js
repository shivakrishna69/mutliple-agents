/**
 * Organisation chart routes, mounted in server.js under `/api/org`.
 *
 *   GET /hierarchy     the whole organisation as nested nodes
 *   GET /manager/:id   every direct and indirect report of one employee
 *
 * Access: signed-in staff (admin or agent). The chart lists internal names and job titles, so
 * customer accounts are refused with 403. Both routes are read-only, so no CSRF token is needed.
 */

import { Router } from 'express';
import { getManagerReports, getOrgHierarchy } from '../controllers/orgController.js';
import { protect } from '../middleware/authMiddleware.js';
import { requireStaff } from '../middleware/requireRole.js';

const orgRouter = Router();

orgRouter.use(protect, requireStaff);
orgRouter.get('/hierarchy', getOrgHierarchy);
orgRouter.get('/manager/:id', getManagerReports);

export default orgRouter;
