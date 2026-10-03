/**
 * Customer support chat routes, mounted in server.js under `/api/support`.
 *
 *   POST /api/support/messages  -> protect (session + CSRF) -> per-user rate limit -> sendCustomerMessage
 *
 * Customers read their conversation and its history through the shared conversation routes
 * (GET /api/conversations, GET /api/conversations/:id/messages), which scope results to them.
 */

import { Router } from 'express';
import { sendCustomerMessage } from '../controllers/supportController.js';
import { protect } from '../middleware/authMiddleware.js';
import { supportMessageRateLimitByUser } from '../middleware/rateLimiter.js';

const supportRouter = Router();

supportRouter.post('/messages', protect, supportMessageRateLimitByUser, sendCustomerMessage);

export default supportRouter;
