/**
 * NskBotUsage: how many messages one person sent the NSK assistant on one UTC day, and the model
 * tokens they used, for its daily quota (NSK_DAILY_MESSAGE_LIMIT). The same fields as the
 * department agents' counters (dailyChatUsageSchema.js), in a collection of its own. Deleted
 * NSK_BOT_SETTINGS.USAGE_RETENTION_DAYS after the day (TTL).
 */

import mongoose from 'mongoose';
import { buildDailyChatUsageSchema } from './dailyChatUsageSchema.js';

export default mongoose.model('NskBotUsage', buildDailyChatUsageSchema());
