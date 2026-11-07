/**
 * A department's knowledge base, mounted by routes/departmentRoutes.js at
 * /api/departments/:departmentId/agent (controllers/departmentKnowledgeController.js lists the
 * endpoints). For the department's head, its knowledge lead and administrators only.
 *
 * Order matters: the session (protect, applied by the departments router) and the per-user rate
 * limit run first, then the department scope (who may act on this department), and only then is an
 * upload read, so a refused user never makes the server buffer a file.
 */

import { Router } from 'express';
import {
  deleteKnowledgeDocumentHandler,
  getKnowledgeDocuments,
  getKnowledgeSettings,
  getLeadCandidates,
  patchKnowledgeSettings,
  postKnowledgeDocument,
} from '../controllers/departmentKnowledgeController.js';
import { departmentKnowledgeScope } from '../middleware/departmentKnowledgeScope.js';
import { receiveKnowledgeUpload } from '../middleware/knowledgeUpload.js';
import { knowledgeUploadRateLimitByUser, knowledgeWriteRateLimitByUser } from '../middleware/rateLimiter.js';

// mergeParams: the department id comes from the parent router's path.
const departmentKnowledgeRouter = Router({ mergeParams: true });

departmentKnowledgeRouter.get('/settings', departmentKnowledgeScope, getKnowledgeSettings);
departmentKnowledgeRouter.patch(
  '/settings',
  knowledgeWriteRateLimitByUser,
  departmentKnowledgeScope,
  patchKnowledgeSettings,
);
departmentKnowledgeRouter.get('/lead-candidates', departmentKnowledgeScope, getLeadCandidates);
departmentKnowledgeRouter.get('/documents', departmentKnowledgeScope, getKnowledgeDocuments);
departmentKnowledgeRouter.post(
  '/documents',
  knowledgeUploadRateLimitByUser,
  departmentKnowledgeScope,
  receiveKnowledgeUpload,
  postKnowledgeDocument,
);
departmentKnowledgeRouter.delete(
  '/documents/:docId',
  knowledgeWriteRateLimitByUser,
  departmentKnowledgeScope,
  deleteKnowledgeDocumentHandler,
);

export default departmentKnowledgeRouter;
