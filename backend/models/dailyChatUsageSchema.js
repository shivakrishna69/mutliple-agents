/**
 * The schema of a daily chat usage counter: how many questions one person sent an assistant on one
 * UTC day, and the model tokens they used, for that assistant's daily quota
 * (services/dailyUsageQuota.js). Each assistant keeps its counters in its own collection
 * (AgentChatUsage for department agents, NskBotUsage for the NSK assistant), so one quota never
 * spends the other. A counter of its own, so deleting conversations does not reset it; deleted at
 * expiresAt (TTL).
 */

import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

export function buildDailyChatUsageSchema() {
  const schema = new mongoose.Schema(
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
  schema.index({ userId: 1, day: 1 }, { unique: true });
  schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  return schema;
}
