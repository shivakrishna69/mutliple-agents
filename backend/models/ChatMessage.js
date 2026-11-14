/**
 * ChatMessage: one message of a ChatSession with the NSK assistant.
 *
 *   role            USER       what the person wrote
 *                   ASSISTANT  NSK's reply
 *   outcome         ASSISTANT only (constants/nskBot.js NSK_OUTCOMES)
 *   classification  USER only: the intent, sentiment, confidence and entities the ai-service read in
 *                   the message
 *   citations       ASSISTANT only: what the reply's [n] marks point at, as they were when it was
 *                   written: a tool read (its name and what it read), a document passage (document,
 *                   headings, page, a quoted excerpt) or an earlier session. Never a whole document.
 *   suggestions     ASSISTANT only: the likely next questions, offered as cards
 *   escalation      ASSISTANT only: true when the message sounded urgent, frustrated or sensitive, so
 *                   the reply also shows how to reach a person
 *   toolsUsed       ASSISTANT only: the tools the turn called, by name
 *   usage           ASSISTANT only: the turn's model tokens
 *   expiresAt       createdAt + NSK_BOT_SETTINGS.RETENTION_DAYS (TTL)
 */

import mongoose from 'mongoose';
import { NSK_INTENTS, NSK_MESSAGE_ROLES, NSK_OUTCOMES, NSK_SENTIMENTS, NSK_SOURCE_KINDS } from '../constants/nskBot.js';
import { NSK_BOT_SETTINGS } from '../constants/validation.js';
import { entitySchema, suggestionSchema } from './ChatSession.js';

const { ObjectId } = mongoose.Schema.Types;

const citationSchema = new mongoose.Schema(
  {
    number: { type: Number, required: true, min: 1 },
    kind: { type: String, enum: Object.values(NSK_SOURCE_KINDS), required: true },
    label: { type: String, required: true, maxlength: NSK_BOT_SETTINGS.CITATION_LABEL_MAX_LENGTH },
    // TOOL
    tool: { type: String, default: null, maxlength: NSK_BOT_SETTINGS.TOOL_NAME_MAX_LENGTH },
    // DOCUMENT
    documentId: { type: ObjectId, ref: 'AgentDocument', default: null },
    documentName: { type: String, default: null },
    departmentId: { type: ObjectId, ref: 'Department', default: null },
    headingPath: { type: [String], default: [] },
    page: { type: Number, default: null },
    // CONVERSATION
    sessionId: { type: ObjectId, ref: 'ChatSession', default: null },
    excerpt: { type: String, default: null, maxlength: NSK_BOT_SETTINGS.CITATION_EXCERPT_MAX_LENGTH },
  },
  { _id: false },
);

const chatMessageSchema = new mongoose.Schema(
  {
    sessionId: { type: ObjectId, ref: 'ChatSession', required: true, immutable: true },
    userId: { type: ObjectId, ref: 'User', required: true, immutable: true },
    role: { type: String, enum: Object.values(NSK_MESSAGE_ROLES), required: true, immutable: true },
    content: { type: String, required: true, minlength: 1 },
    outcome: { type: String, enum: [...Object.values(NSK_OUTCOMES), null], default: null },
    classification: {
      type: new mongoose.Schema(
        {
          intent: { type: String, enum: Object.values(NSK_INTENTS), required: true },
          sentiment: { type: String, enum: Object.values(NSK_SENTIMENTS), required: true },
          confidence: { type: Number, min: 0, max: 1, required: true },
          entities: { type: [entitySchema], default: [] },
        },
        { _id: false },
      ),
      default: null,
    },
    citations: { type: [citationSchema], default: [] },
    suggestions: { type: [suggestionSchema], default: [] },
    escalation: { type: Boolean, default: false },
    toolsUsed: { type: [String], default: [] },
    usage: {
      inputTokens: { type: Number, default: null },
      outputTokens: { type: Number, default: null },
    },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

// A session's messages in order, and the history sent with a turn.
chatMessageSchema.index({ sessionId: 1, createdAt: 1 });
chatMessageSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model('ChatMessage', chatMessageSchema);
