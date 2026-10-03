/**
 * Administration routes, mounted in server.js under `/api/admin`. Every route requires a session
 * (`protect`, which also enforces the CSRF token on PATCH) and the admin role.
 *
 *   GET   /users                 list and search users with role counts
 *   PATCH /users/:userId/role    change a user's role
 */

import { Router } from 'express';
import { listUsers, updateUserRole } from '../controllers/adminController.js';
import { protect } from '../middleware/authMiddleware.js';
import { requireAdmin } from '../middleware/requireRole.js';

const adminRouter = Router();

adminRouter.use(protect, requireAdmin);
adminRouter.get('/users', listUsers);
adminRouter.patch('/users/:userId/role', updateUserRole);

export default adminRouter;
