/**
 * Conversation routes, mounted in server.js under `/api/conversations`. All require a session
 * (`protect`, which also enforces the CSRF token on POST); staff actions also require an admin or
 * agent role. See controllers/conversationController.js for visibility rules and responses.
 *
 *   GET  /                                   list            any signed-in user (scoped by role)
 *   GET  /:conversationId                    details         any signed-in user with access
 *   GET  /:conversationId/messages           history         any signed-in user with access
 *   POST /:conversationId/claim              claim           staff
 *   POST /:conversationId/release            release         staff (assigned agent or admin)
 *   POST /:conversationId/messages           agent reply     staff (assigned agent)
 */

import { Router } from 'express';
import {
  claimConversation,
  getConversation,
  listConversationMessages,
  listConversations,
  releaseConversation,
  sendAgentMessage,
} from '../controllers/conversationController.js';
import { protect } from '../middleware/authMiddleware.js';
import { requireStaff } from '../middleware/requireRole.js';

const conversationRouter = Router();

conversationRouter.use(protect);

conversationRouter.get('/', listConversations);
conversationRouter.get('/:conversationId', getConversation);
conversationRouter.get('/:conversationId/messages', listConversationMessages);
conversationRouter.post('/:conversationId/claim', requireStaff, claimConversation);
conversationRouter.post('/:conversationId/release', requireStaff, releaseConversation);
conversationRouter.post('/:conversationId/messages', requireStaff, sendAgentMessage);

export default conversationRouter;
