/**
 * AgentConversation: one person's conversation with one department's agent. Only its owner can read
 * it. Its messages are in AgentMessage.
 *
 *   userId          the person asking (immutable)
 *   departmentId    the department whose agent answers (immutable)
 *   agentId         that department's agent (immutable)
 *   title           the start of the first question, for the conversation list
 *   lastMessageAt   when the last message was added
 *   expiresAt       lastMessageAt + AGENT_CHAT_SETTINGS.RETENTION_DAYS: MongoDB's TTL monitor deletes
 *                   the conversation then (its messages expire on their own the same way)
 */

import mongoose from 'mongoose';
import { AGENT_CHAT_SETTINGS } from '../constants/validation.js';

const { ObjectId } = mongoose.Schema.Types;

const agentConversationSchema = new mongoose.Schema(
  {
    userId: { type: ObjectId, ref: 'User', required: true, immutable: true },
    departmentId: { type: ObjectId, ref: 'Department', required: true, immutable: true },
    agentId: { type: ObjectId, ref: 'DepartmentAgent', required: true, immutable: true },
    title: {
      type: String,
      required: true,
      trim: true,
      minlength: 1,
      maxlength: AGENT_CHAT_SETTINGS.CONVERSATION_TITLE_MAX_LENGTH,
    },
    lastMessageAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

// "My conversations with this agent", newest first.
agentConversationSchema.index({ userId: 1, departmentId: 1, lastMessageAt: -1 });
agentConversationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model('AgentConversation', agentConversationSchema);
