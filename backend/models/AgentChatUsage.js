/**
 * AgentChatUsage: how many questions one person asked department agents on one UTC day, and the
 * model tokens they used, for the daily quota (AGENT_DAILY_QUESTION_LIMIT). A counter of its own,
 * so deleting conversations does not reset it. Deleted AGENT_CHAT_SETTINGS.USAGE_RETENTION_DAYS
 * after the day (TTL).
 */

import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

const agentChatUsageSchema = new mongoose.Schema(
  {
    userId: { type: ObjectId, ref: 'User', required: true, immutable: true },
    // YYYY-MM-DD, in UTC.
    day: { type: String, required: true, immutable: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    questions: { type: Number, default: 0, min: 0 },
    inputTokens: { type: Number, default: 0, min: 0 },
    outputTokens: { type: Number, default: 0, min: 0 },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

agentChatUsageSchema.index({ userId: 1, day: 1 }, { unique: true });
agentChatUsageSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model('AgentChatUsage', agentChatUsageSchema);
