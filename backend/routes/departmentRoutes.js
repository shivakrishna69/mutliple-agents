/**
 * Department routes, mounted at /api/departments. HR and administrators only
 * (controllers/departmentController.js); all need a signed-in session and the CSRF token on changes.
 *
 *   GET    /                    departments by name with head counts (?includeInactive=true for all)
 *   GET    /:departmentId       one department
 *   POST   /                    add one ({ name, code, slug?, budgetCode?, parentDepartmentId?, departmentHeadId? });
 *                               without a slug, one is made from the name
 *   PATCH  /:departmentId       change one, including isActive (send version); renaming keeps the slug
 *   DELETE /:departmentId       remove one nothing refers to (otherwise deactivate it)
 *   GET    /agents/available    the department agents this person may ask (everyone signed in;
 *                               controllers/agentChatController.js)
 *   /:departmentId/agent/...    the department's knowledge base, its agent's chat and its Questions
 *                               Inbox (routes/departmentKnowledgeRoutes.js)
 */

import { Router } from 'express';
import {
  getDepartmentById,
  getDepartments,
  patchDepartment,
  postDepartment,
  removeDepartment,
} from '../controllers/departmentController.js';
import { getAvailableAgents } from '../controllers/agentChatController.js';
import { protect } from '../middleware/authMiddleware.js';
import { workplaceSetupWriteRateLimitByUser } from '../middleware/rateLimiter.js';
import departmentKnowledgeRouter from './departmentKnowledgeRoutes.js';

const departmentRouter = Router();

departmentRouter.use(protect, (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
// Before the /:departmentId routes, so "agents" is never read as a department id.
departmentRouter.get('/agents/available', getAvailableAgents);
departmentRouter.use('/:departmentId/agent', departmentKnowledgeRouter);
departmentRouter.get('/', getDepartments);
departmentRouter.get('/:departmentId', getDepartmentById);
departmentRouter.post('/', workplaceSetupWriteRateLimitByUser, postDepartment);
departmentRouter.patch('/:departmentId', workplaceSetupWriteRateLimitByUser, patchDepartment);
departmentRouter.delete('/:departmentId', workplaceSetupWriteRateLimitByUser, removeDepartment);

export default departmentRouter;
