/**
 * A department's task board, mounted by routes/departmentRoutes.js at /api/departments/:departmentId
 * (controllers/taskBoardController.js lists the endpoints). Every route is scoped to the department
 * first (middleware/departmentBoardScope.js); changes are rate limited per user. A path this router
 * does not know falls through to the department routes.
 */

import { Router } from 'express';
import {
  getBoard,
  getSprints,
  getTaskDetail,
  getTasks,
  getTeamWorkMetrics,
  patchSprint,
  patchTask,
  postSprint,
  postTask,
  postTaskComment,
  putTaskLeads,
} from '../controllers/taskBoardController.js';
import { departmentBoardScope } from '../middleware/departmentBoardScope.js';
import { taskWriteRateLimitByUser } from '../middleware/rateLimiter.js';

// mergeParams: the department id comes from the parent router's path.
const departmentBoardRouter = Router({ mergeParams: true });

departmentBoardRouter.get('/board', departmentBoardScope, getBoard);
departmentBoardRouter.put('/task-leads', taskWriteRateLimitByUser, departmentBoardScope, putTaskLeads);
departmentBoardRouter.get('/sprints', departmentBoardScope, getSprints);
departmentBoardRouter.post('/sprints', taskWriteRateLimitByUser, departmentBoardScope, postSprint);
departmentBoardRouter.patch('/sprints/:sprintId', taskWriteRateLimitByUser, departmentBoardScope, patchSprint);
departmentBoardRouter.get('/tasks', departmentBoardScope, getTasks);
departmentBoardRouter.post('/tasks', taskWriteRateLimitByUser, departmentBoardScope, postTask);
// Before /tasks/:taskId, so "metrics" is never read as a task id.
departmentBoardRouter.get('/tasks/metrics', departmentBoardScope, getTeamWorkMetrics);
departmentBoardRouter.get('/tasks/:taskId', departmentBoardScope, getTaskDetail);
departmentBoardRouter.patch('/tasks/:taskId', taskWriteRateLimitByUser, departmentBoardScope, patchTask);
departmentBoardRouter.post('/tasks/:taskId/comments', taskWriteRateLimitByUser, departmentBoardScope, postTaskComment);

export default departmentBoardRouter;
