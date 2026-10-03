/**
 * Message model: one entry in a conversation's transcript.
 *
 * Who writes which senderType:
 *   - customer      : the backend, when the customer sends a message.
 *   - ai_supervisor : the ai-service, when the LangGraph supervisor replies or records a routing
 *                     decision (e.g. "routing to billing_agent", "escalating to human").
 *   - ai_worker     : the ai-service, when billing_agent or tech_agent replies.
 *   - human_agent   : the backend, when the assigned human agent replies.
 *
 * Audit trail:
 *   - Messages are append-only. `conversationId`, `senderType`, `text`, and `toolExecutionLogs`
 *     are `immutable`, so Mongoose ignores later changes to them on save and update.
 *   - `toolExecutionLogs` records each step the AI took to produce the message: which graph
 *     node ran, which tool it called, with what input, what came back, and how long it took.
 *     Together with the supervisor's routing messages, this reconstructs why a conversation
 *     moved between states (see the state machine in Conversation.js).
 */

import mongoose from 'mongoose';
import { MESSAGE_FIELD_LIMITS } from '../constants/validation.js';

/** Allowed values for `senderType`. */
export const SENDER_TYPE = Object.freeze({
  CUSTOMER: 'customer',
  AI_SUPERVISOR: 'ai_supervisor',
  AI_WORKER: 'ai_worker',
  HUMAN_AGENT: 'human_agent',
});

/** Outcome of a single tool execution step. */
export const TOOL_STEP_STATUS = Object.freeze({
  SUCCESS: 'success',
  ERROR: 'error',
});

/**
 * One step in the AI's execution for a message. Stored inline in the message (not in its
 * own collection) because steps are always read together with the message they produced.
 * `_id: false` because steps are identified by their position (`step`), not by id.
 */
const toolExecutionLogSchema = new mongoose.Schema(
  {
    // 1-based order of this step within the message's execution.
    step: { type: Number, required: true, min: 1 },
    // LangGraph node that ran the step: supervisor, billing_agent, or tech_agent.
    node: { type: String, required: true, trim: true },
    // Tool the node called, e.g. "lookup_invoice". Empty for a pure LLM reasoning step.
    toolName: { type: String, trim: true, default: null },
    // Arguments passed to the tool, as sent. Mixed because each tool has its own shape.
    input: { type: mongoose.Schema.Types.Mixed, default: null },
    // Value the tool returned. Mixed for the same reason as `input`.
    output: { type: mongoose.Schema.Types.Mixed, default: null },
    status: {
      type: String,
      enum: Object.values(TOOL_STEP_STATUS),
      required: true,
    },
    // Error message when status is "error"; null otherwise.
    error: { type: String, default: null },
    // Wall-clock time the step started and how long it ran.
    startedAt: { type: Date, required: true },
    durationMs: { type: Number, min: 0, default: null },
  },
  { _id: false },
);

const messageSchema = new mongoose.Schema(
  {
    conversationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Conversation',
      required: [true, 'conversationId is required'],
      immutable: true,
    },
    senderType: {
      type: String,
      enum: { values: Object.values(SENDER_TYPE), message: 'Sender type "{VALUE}" is not valid' },
      required: [true, 'senderType is required'],
      immutable: true,
    },
    text: {
      type: String,
      trim: true,
      default: '',
      maxlength: [MESSAGE_FIELD_LIMITS.TEXT_MAX_LENGTH, 'Message text is too long'],
      immutable: true,
    },
    // The staff member who wrote a human_agent message; required for that sender type and absent
    // for all others, so every human reply in the audit trail names its author.
    senderUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      immutable: true,
      default: undefined,
    },
    // The sending system's id for an inbound message (webhook `eventId`). Unique, so a webhook
    // delivered twice is stored once; absent for messages created inside this system.
    externalMessageId: {
      type: String,
      immutable: true,
      default: undefined,
    },
    toolExecutionLogs: {
      type: [toolExecutionLogSchema],
      default: [],
      immutable: true,
    },
  },
  {
    // createdAt orders the transcript. updatedAt stays equal to createdAt because messages are immutable.
    timestamps: true,
  },
);

// ---------------------------------------------------------------------------
// Indexes
// ---------------------------------------------------------------------------

// Loading a transcript: all messages for one conversation in chronological order.
// The conversationId prefix also serves queries that filter on conversationId alone.
messageSchema.index({ conversationId: 1, createdAt: 1 });

// Filtering a transcript by sender, e.g. "the latest human_agent reply in this conversation".
messageSchema.index({ conversationId: 1, senderType: 1, createdAt: -1 });

// Webhook de-duplication. Partial rather than sparse-on-null so internally created messages
// (no externalMessageId) never collide with each other.
messageSchema.index(
  { externalMessageId: 1 },
  { unique: true, partialFilterExpression: { externalMessageId: { $type: 'string' } } },
);

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * A message must carry something: visible text, or at least one execution step
 * (a supervisor routing decision may have no customer-facing text).
 * Customers and human agents always write text, so tool logs are only accepted from AI senders.
 */
messageSchema.pre('validate', async function requireContent() {
  const hasText = this.text.length > 0;
  const hasSteps = this.toolExecutionLogs.length > 0;
  const isAi = this.senderType === SENDER_TYPE.AI_SUPERVISOR || this.senderType === SENDER_TYPE.AI_WORKER;

  if (!hasText && !hasSteps) {
    this.invalidate('text', 'A message needs text or at least one toolExecutionLogs entry');
  }
  if (!isAi && !hasText) {
    this.invalidate('text', `Messages from "${this.senderType}" must have text`);
  }
  if (!isAi && hasSteps) {
    this.invalidate('toolExecutionLogs', `Messages from "${this.senderType}" cannot have toolExecutionLogs`);
  }
  const isHumanAgent = this.senderType === SENDER_TYPE.HUMAN_AGENT;
  if (isHumanAgent && !this.senderUserId) {
    this.invalidate('senderUserId', 'Human agent messages must record the agent who sent them');
  }
  if (!isHumanAgent && this.senderUserId) {
    this.invalidate('senderUserId', `Messages from "${this.senderType}" cannot have a senderUserId`);
  }
});

const Message = mongoose.model('Message', messageSchema);

export default Message;
