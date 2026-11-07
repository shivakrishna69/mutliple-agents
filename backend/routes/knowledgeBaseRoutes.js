/**
 * The department knowledge bases this user manages, mounted at /api/knowledge-bases
 * (controllers/departmentKnowledgeController.js getKnowledgeBases): every department for an
 * administrator, the ones a user heads or leads otherwise, an empty list for everyone else. Read
 * only; each department's knowledge base is managed under /api/departments/:departmentId/agent.
 */

import { Router } from 'express';
import { getKnowledgeBases } from '../controllers/departmentKnowledgeController.js';
import { protect } from '../middleware/authMiddleware.js';

const knowledgeBaseRouter = Router();

knowledgeBaseRouter.use(protect, (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
knowledgeBaseRouter.get('/', getKnowledgeBases);

export default knowledgeBaseRouter;
