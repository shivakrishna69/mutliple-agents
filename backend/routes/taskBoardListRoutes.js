/**
 * The task boards this user can open, mounted at /api/task-boards (controllers/taskBoardController.js
 * getMyBoards): every department's for an administrator; their own department's and those they head
 * otherwise; an empty list for everyone else. Read only; each board is used under
 * /api/departments/:departmentId (routes/departmentBoardRoutes.js).
 */

import { Router } from 'express';
import { getMyBoards } from '../controllers/taskBoardController.js';
import { protect } from '../middleware/authMiddleware.js';

const taskBoardListRouter = Router();

taskBoardListRouter.use(protect, (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
taskBoardListRouter.get('/', getMyBoards);

export default taskBoardListRouter;
