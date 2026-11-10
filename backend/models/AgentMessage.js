/**
 * AgentMessage: one message of an AgentConversation.
 *
 *   role        USER       the person's question
 *               ASSISTANT  the agent's answer, with its outcome, the passages it cited and its
 *                          token use; the person may rate it (feedback)
 *               LEAD       a reply from the department (the head or the knowledge lead), added when
 *                          they answer the question in the Questions Inbox
 *   outcome     ASSISTANT only: ANSWERED, NOT_FOUND or REFUSED (ai-service AnswerOutcome)
 *   citations   ASSISTANT only: the knowledge passages the answer cites, as they were when it was
 *               written (document name, headings, page, a quoted excerpt). Never the whole document.
 *   questionId  the department question it led to (AgentQuestion), when it was escalated
 *   expiresAt   createdAt + AGENT_CHAT_SETTINGS.RETENTION_DAYS (TTL)
 */

import mongoose from 'mongoose';
import { AGENT_CHAT_SETTINGS } from '../constants/validation.js';

const { ObjectId } = mongoose.Schema.Types;

export const AGENT_MESSAGE_ROLES = Object.freeze({ USER: 'USER', ASSISTANT: 'ASSISTANT', LEAD: 'LEAD' });
export const AGENT_ANSWER_OUTCOMES = Object.freeze({
  ANSWERED: 'ANSWERED',
  NOT_FOUND: 'NOT_FOUND',
  REFUSED: 'REFUSED',
});
export const FEEDBACK_RATINGS = Object.freeze({ UP: 'UP', DOWN: 'DOWN' });

const citationSchema = new mongoose.Schema(
  {
    number: { type: Number, required: true, min: 1 },
    documentId: { type: ObjectId, ref: 'AgentDocument', required: true },
    documentName: { type: String, default: null },
    chunkIndex: { type: Number, required: true, min: 0 },
    headingPath: { type: [String], default: [] },
    page: { type: Number, default: null },
    excerpt: { type: String, required: true },
    score: { type: Number, required: true },
  },
  { _id: false },
);

const agentMessageSchema = new mongoose.Schema(
  {
    conversationId: { type: ObjectId, ref: 'AgentConversation', required: true, immutable: true },
    userId: { type: ObjectId, ref: 'User', required: true, immutable: true },
    departmentId: { type: ObjectId, ref: 'Department', required: true, immutable: true },
    role: { type: String, enum: Object.values(AGENT_MESSAGE_ROLES), required: true, immutable: true },
    content: { type: String, required: true, minlength: 1 },
    outcome: { type: String, enum: [...Object.values(AGENT_ANSWER_OUTCOMES), null], default: null },
    citations: { type: [citationSchema], default: [] },
    usage: {
      inputTokens: { type: Number, default: null },
      outputTokens: { type: Number, default: null },
    },
    // LEAD only: who replied.
    authorId: { type: ObjectId, ref: 'User', default: null },
    feedback: {
      rating: { type: String, enum: [...Object.values(FEEDBACK_RATINGS), null], default: null },
      comment: { type: String, default: null, maxlength: AGENT_CHAT_SETTINGS.FEEDBACK_COMMENT_MAX_LENGTH },
      ratedAt: { type: Date, default: null },
    },
    questionId: { type: ObjectId, ref: 'AgentQuestion', default: null },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

// A conversation's messages in order, and the history sent with a question.
agentMessageSchema.index({ conversationId: 1, createdAt: 1 });
agentMessageSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model('AgentMessage', agentMessageSchema);
