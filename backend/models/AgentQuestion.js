/**
 * AgentQuestion: a question a department's agent could not settle, in that department's Questions
 * Inbox, for its head and knowledge lead to answer: the department is the asker's point of contact.
 *
 *   reason       UNANSWERED  the agent found no answer (outcome NOT_FOUND or REFUSED): sent at once
 *                DOWNVOTED   the person rated the agent's answer unhelpful
 *   question     the person's question, kept here so the inbox does not depend on the conversation
 *                (which its owner may delete, and which expires)
 *   agentAnswer  what the agent replied
 *   status       OPEN, ANSWERED (answer, answeredBy, answeredAt) or DISMISSED (closed without one)
 *   faqDocumentId  the knowledge base entry the answer was saved as (AgentDocument, source FAQ)
 *   expiresAt    null while OPEN; AGENT_CHAT_SETTINGS.CLOSED_QUESTION_RETENTION_DAYS after it was
 *                closed (TTL)
 *
 * One question per agent answer (assistantMessageId is unique), so escalating twice is harmless.
 */

import mongoose from 'mongoose';
import { AGENT_CHAT_SETTINGS } from '../constants/validation.js';

const { ObjectId } = mongoose.Schema.Types;

export const QUESTION_REASONS = Object.freeze({ UNANSWERED: 'UNANSWERED', DOWNVOTED: 'DOWNVOTED' });
export const QUESTION_STATUSES = Object.freeze({ OPEN: 'OPEN', ANSWERED: 'ANSWERED', DISMISSED: 'DISMISSED' });

const agentQuestionSchema = new mongoose.Schema(
  {
    departmentId: { type: ObjectId, ref: 'Department', required: true, immutable: true },
    agentId: { type: ObjectId, ref: 'DepartmentAgent', required: true, immutable: true },
    askedBy: { type: ObjectId, ref: 'User', required: true, immutable: true },
    conversationId: { type: ObjectId, ref: 'AgentConversation', required: true, immutable: true },
    assistantMessageId: { type: ObjectId, ref: 'AgentMessage', required: true, immutable: true },
    reason: { type: String, enum: Object.values(QUESTION_REASONS), required: true },
    question: { type: String, required: true, maxlength: AGENT_CHAT_SETTINGS.QUESTION_MAX_LENGTH },
    agentAnswer: { type: String, required: true },
    status: {
      type: String,
      enum: Object.values(QUESTION_STATUSES),
      default: QUESTION_STATUSES.OPEN,
      required: true,
    },
    answer: { type: String, default: null, maxlength: AGENT_CHAT_SETTINGS.LEAD_ANSWER_MAX_LENGTH },
    answeredBy: { type: ObjectId, ref: 'User', default: null },
    answeredAt: { type: Date, default: null },
    closedBy: { type: ObjectId, ref: 'User', default: null },
    closedAt: { type: Date, default: null },
    faqDocumentId: { type: ObjectId, ref: 'AgentDocument', default: null },
    expiresAt: { type: Date, default: null },
  },
  { timestamps: true, optimisticConcurrency: true },
);

agentQuestionSchema.index({ assistantMessageId: 1 }, { unique: true });
// The inbox: a department's questions by status, newest first.
agentQuestionSchema.index({ departmentId: 1, status: 1, createdAt: -1 });
agentQuestionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model('AgentQuestion', agentQuestionSchema);
