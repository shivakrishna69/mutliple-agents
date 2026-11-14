/**
 * AgentChatUsage: how many questions one person asked department agents on one UTC day, and the
 * model tokens they used, for the daily quota (AGENT_DAILY_QUESTION_LIMIT). The fields are shared
 * with the NSK assistant's counters (dailyChatUsageSchema.js). Deleted
 * AGENT_CHAT_SETTINGS.USAGE_RETENTION_DAYS after the day (TTL).
 */

import mongoose from 'mongoose';
import { buildDailyChatUsageSchema } from './dailyChatUsageSchema.js';

export default mongoose.model('AgentChatUsage', buildDailyChatUsageSchema());
