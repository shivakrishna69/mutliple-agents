/**
 * Webhook routes, mounted in server.js under `/api/webhooks`:
 *
 *   POST /api/webhooks/incoming -> verifyWebhookSignature -> receiveIncomingMessage
 *
 * Signature verification runs before anything else touches the payload, so unsigned or
 * tampered requests never reach validation, the database, or the ai-service.
 * The raw body it verifies is captured by express.json's `verify` hook in server.js.
 */

import { Router } from 'express';
import { receiveIncomingMessage } from '../controllers/webhookController.js';
import { verifyWebhookSignature } from '../middleware/webhookSignature.js';

const webhookRouter = Router();

webhookRouter.post('/incoming', verifyWebhookSignature, receiveIncomingMessage);

export default webhookRouter;
