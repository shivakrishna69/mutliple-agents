/**
 * A department's agent, mounted by routes/departmentRoutes.js at /api/departments/:departmentId/agent:
 *   - its knowledge base (controllers/departmentKnowledgeController.js) and its Questions Inbox
 *     (controllers/agentQuestionController.js): for the department's head, its knowledge lead and
 *     administrators only (middleware/departmentKnowledgeScope.js);
 *   - its chat (controllers/agentChatController.js): asking, for the people in its audience
 *     (middleware/departmentAgentAskScope.js); conversations and feedback, for their owner.
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
import {
  clearAgentConversations,
  deleteAgentConversation,
  getAgentConversation,
  getAgentConversations,
  postAgentChat,
  postAgentFeedback,
} from '../controllers/agentChatController.js';
import {
  getDepartmentQuestions,
  postQuestionAnswer,
  postQuestionDismissal,
  postQuestionFaq,
} from '../controllers/agentQuestionController.js';
import { departmentAgentAskScope } from '../middleware/departmentAgentAskScope.js';
import { departmentKnowledgeScope } from '../middleware/departmentKnowledgeScope.js';
import { receiveKnowledgeUpload } from '../middleware/knowledgeUpload.js';
import {
  agentChatWriteRateLimitByUser,
  agentQuestionRateLimitByUser,
  knowledgeUploadRateLimitByUser,
  knowledgeWriteRateLimitByUser,
} from '../middleware/rateLimiter.js';

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

// --- The agent's chat ---------------------------------------------------------------------------
departmentKnowledgeRouter.post('/chat', agentQuestionRateLimitByUser, departmentAgentAskScope, postAgentChat);
departmentKnowledgeRouter.get('/conversations', getAgentConversations);
departmentKnowledgeRouter.get('/conversations/:conversationId', getAgentConversation);
departmentKnowledgeRouter.delete(
  '/conversations/:conversationId',
  agentChatWriteRateLimitByUser,
  deleteAgentConversation,
);
departmentKnowledgeRouter.delete('/conversations', agentChatWriteRateLimitByUser, clearAgentConversations);
departmentKnowledgeRouter.post('/feedback', agentChatWriteRateLimitByUser, postAgentFeedback);

// --- The Questions Inbox ---------------------------------------------------------------------------
departmentKnowledgeRouter.get('/questions', departmentKnowledgeScope, getDepartmentQuestions);
departmentKnowledgeRouter.post(
  '/questions/:questionId/answer',
  agentChatWriteRateLimitByUser,
  departmentKnowledgeScope,
  postQuestionAnswer,
);
departmentKnowledgeRouter.post(
  '/questions/:questionId/dismiss',
  agentChatWriteRateLimitByUser,
  departmentKnowledgeScope,
  postQuestionDismissal,
);
departmentKnowledgeRouter.post(
  '/questions/:questionId/faq',
  agentChatWriteRateLimitByUser,
  departmentKnowledgeScope,
  postQuestionFaq,
);

export default departmentKnowledgeRouter;
