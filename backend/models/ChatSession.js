/**
 * ChatSession: one conversation with the NSK assistant. Only its owner can read it; its messages are
 * in ChatMessage. A session also remembers what it was about, so a later session can pick it up
 * ("what did we check yesterday?", "continue Rahul's relieving"):
 *
 *   userId          the person (immutable)
 *   title           the start of the first message, for the session list
 *   topics          short phrases the classifier gave the turns ("leave balance", "attendance in
 *                   October"), newest last, at most NSK_BOT_SETTINGS.TOPICS_KEPT
 *   entities        people, dates, departments and tickers named in the session (kind + value),
 *                   newest last, at most NSK_BOT_SETTINGS.ENTITIES_KEPT
 *   lastIntent      the intent of the latest turn
 *   lastSuggestions the suggestions of the latest answer: offered again when the session is resumed
 *   messageCount    messages so far
 *   lastMessageAt   when the last message was added
 *   expiresAt       lastMessageAt + NSK_BOT_SETTINGS.RETENTION_DAYS: MongoDB's TTL monitor deletes the
 *                   session then (its messages expire on their own the same way)
 *
 * The text index over the title, topics and entity values finds the person's earlier sessions that
 * match a new message's words.
 */

import mongoose from 'mongoose';
import { NSK_ENTITY_KINDS, NSK_INTENTS } from '../constants/nskBot.js';
import { NSK_BOT_SETTINGS } from '../constants/validation.js';

const { ObjectId } = mongoose.Schema.Types;

export const entitySchema = new mongoose.Schema(
  {
    kind: { type: String, enum: Object.values(NSK_ENTITY_KINDS), required: true },
    value: { type: String, required: true, trim: true, maxlength: NSK_BOT_SETTINGS.ENTITY_VALUE_MAX_LENGTH },
  },
  { _id: false },
);

export const suggestionSchema = new mongoose.Schema(
  {
    text: { type: String, required: true, trim: true, maxlength: NSK_BOT_SETTINGS.SUGGESTION_MAX_LENGTH },
    intent: { type: String, enum: Object.values(NSK_INTENTS), required: true },
  },
  { _id: false },
);

const chatSessionSchema = new mongoose.Schema(
  {
    userId: { type: ObjectId, ref: 'User', required: true, immutable: true },
    title: { type: String, required: true, trim: true, minlength: 1, maxlength: NSK_BOT_SETTINGS.TITLE_MAX_LENGTH },
    topics: {
      type: [{ type: String, trim: true, maxlength: NSK_BOT_SETTINGS.TOPIC_MAX_LENGTH }],
      default: [],
      validate: {
        validator: (topics) => topics.length <= NSK_BOT_SETTINGS.TOPICS_KEPT,
        message: `A session keeps at most ${NSK_BOT_SETTINGS.TOPICS_KEPT} topics`,
      },
    },
    entities: {
      type: [entitySchema],
      default: [],
      validate: {
        validator: (entities) => entities.length <= NSK_BOT_SETTINGS.ENTITIES_KEPT,
        message: `A session keeps at most ${NSK_BOT_SETTINGS.ENTITIES_KEPT} names`,
      },
    },
    lastIntent: { type: String, enum: [...Object.values(NSK_INTENTS), null], default: null },
    lastSuggestions: { type: [suggestionSchema], default: [] },
    messageCount: { type: Number, default: 0, min: 0 },
    lastMessageAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

// "My sessions", newest first, and the latest one to resume.
chatSessionSchema.index({ userId: 1, lastMessageAt: -1 });
chatSessionSchema.index({ userId: 1, updatedAt: -1 });
// Earlier sessions matching a message's words (always filtered by userId as well).
chatSessionSchema.index(
  { title: 'text', topics: 'text', 'entities.value': 'text' },
  { name: 'chat_session_memory_text', weights: { title: 2, topics: 3, 'entities.value': 5 } },
);
chatSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model('ChatSession', chatSessionSchema);
