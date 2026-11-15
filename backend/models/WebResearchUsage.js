/**
 * Each person's daily use of NSK's live web research, one counter collection per kind so one limit
 * never spends another (services/dailyUsageQuota.js; `questions` counts the calls). Limits:
 * WEB_FETCH_DAILY_LIMIT, WEB_SEARCH_DAILY_LIMIT, STOCK_QUOTE_DAILY_LIMIT. Deleted
 * WEB_RESEARCH_SETTINGS.USAGE_RETENTION_DAYS after the day (TTL).
 */

import mongoose from 'mongoose';
import { buildDailyChatUsageSchema } from './dailyChatUsageSchema.js';

export const WebFetchUsage = mongoose.model('WebFetchUsage', buildDailyChatUsageSchema());
export const WebSearchUsage = mongoose.model('WebSearchUsage', buildDailyChatUsageSchema());
export const StockQuoteUsage = mongoose.model('StockQuoteUsage', buildDailyChatUsageSchema());
