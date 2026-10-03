/**
 * Conversation model: one support thread between a customer and the system.
 * Messages live in their own collection (see Message.js) and reference this
 * document through `conversationId`.
 *
 * Workflow state machine
 * ----------------------
 * `status` says who owns the conversation; `currentActiveWorker` says which component
 * produces the next reply. Allowed status transitions (enforced in `pre('validate')`):
 *
 *   from                 to
 *   unassigned          → processing-ai | escalated-to-human | assigned-agent
 *   processing-ai       → escalated-to-human
 *   escalated-to-human  → assigned-agent
 *   assigned-agent      → processing-ai | escalated-to-human
 *
 *   unassigned          New conversation, no reply has been produced yet.
 *                       Worker: supervisor (it will route the first message).
 *   processing-ai       The LangGraph supervisor or one of its workers is handling the thread.
 *                       Worker: supervisor | billing_agent | tech_agent | attendance_agent. Moving between AI workers
 *                       changes only `currentActiveWorker`; the status stays processing-ai.
 *   escalated-to-human  The AI decided it cannot resolve the issue and the thread is waiting in
 *                       the human queue. Worker: human. assignedAgentId is empty.
 *   assigned-agent      A human agent has claimed the thread. Worker: human.
 *                       assignedAgentId is required.
 *
 * Transitions out of assigned-agent:
 *   - back to processing-ai     when the agent hands the thread back to the AI;
 *                               assignedAgentId is cleared.
 *   - back to escalated-to-human when the agent releases it to the queue for another agent;
 *                               assignedAgentId is cleared.
 *
 * Every conversation must be created with status `unassigned`.
 *
 * Enforcement scope
 * -----------------
 * The transition and consistency rules run on `document.save()`. Query-style updates
 * (`updateOne`, `findOneAndUpdate`, …) skip document middleware, so they are blocked from
 * touching `status` at all; see the query hook at the bottom of this file. To change
 * workflow state, load the document, call `transitionTo`, then `save()`.
 *
 * Audit note: this schema keeps only the current state. `updatedAt` records when it last
 * changed; the sequence of states can be reconstructed from the Message collection
 * (ai_supervisor messages and their toolExecutionLogs record routing decisions).
 */

import mongoose from 'mongoose';

/** Allowed values for `status`. */
export const CONVERSATION_STATUS = Object.freeze({
  UNASSIGNED: 'unassigned',
  ASSIGNED_AGENT: 'assigned-agent',
  PROCESSING_AI: 'processing-ai',
  ESCALATED_TO_HUMAN: 'escalated-to-human',
});

/** Allowed values for `currentActiveWorker`. Names match the LangGraph node names in ai-service. */
export const ACTIVE_WORKER = Object.freeze({
  SUPERVISOR: 'supervisor',
  BILLING_AGENT: 'billing_agent',
  TECH_AGENT: 'tech_agent',
  // Attendance regularization sub-agent (ai-service app/nodes/attendance_worker.py).
  ATTENDANCE_AGENT: 'attendance_agent',
  HUMAN: 'human',
});

const S = CONVERSATION_STATUS;
const W = ACTIVE_WORKER;

/** Statuses in which a human owns the thread; the AI must not reply to new messages. */
export const HUMAN_OWNED_STATUSES = Object.freeze([S.ESCALATED_TO_HUMAN, S.ASSIGNED_AGENT]);

/** AI workers that the ai-service may hand a conversation to while it stays in processing-ai. */
export const AI_WORKERS = Object.freeze([W.SUPERVISOR, W.BILLING_AGENT, W.TECH_AGENT, W.ATTENDANCE_AGENT]);

/**
 * For each status, the statuses it may move to. A status that is absent from a list
 * cannot be reached from that state; staying in the same status is always allowed.
 */
export const ALLOWED_STATUS_TRANSITIONS = Object.freeze({
  [S.UNASSIGNED]: [S.PROCESSING_AI, S.ESCALATED_TO_HUMAN, S.ASSIGNED_AGENT],
  [S.PROCESSING_AI]: [S.ESCALATED_TO_HUMAN],
  [S.ESCALATED_TO_HUMAN]: [S.ASSIGNED_AGENT],
  [S.ASSIGNED_AGENT]: [S.PROCESSING_AI, S.ESCALATED_TO_HUMAN],
});

/** For each status, the workers that may be active while the conversation is in it. */
const WORKERS_ALLOWED_IN_STATUS = Object.freeze({
  [S.UNASSIGNED]: [W.SUPERVISOR],
  [S.PROCESSING_AI]: [W.SUPERVISOR, W.BILLING_AGENT, W.TECH_AGENT, W.ATTENDANCE_AGENT],
  [S.ESCALATED_TO_HUMAN]: [W.HUMAN],
  [S.ASSIGNED_AGENT]: [W.HUMAN],
});

const conversationSchema = new mongoose.Schema(
  {
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'customerId is required'],
      // A conversation never changes owner; reassigning it would break the customer's history.
      immutable: true,
    },
    status: {
      type: String,
      enum: { values: Object.values(S), message: 'Status "{VALUE}" is not valid' },
      default: S.UNASSIGNED,
      required: true,
    },
    assignedAgentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    currentActiveWorker: {
      type: String,
      enum: { values: Object.values(W), message: 'Worker "{VALUE}" is not valid' },
      default: W.SUPERVISOR,
      required: true,
    },
  },
  {
    // createdAt: when the customer opened the thread. updatedAt: last state change.
    timestamps: true,
    // Every save() checks that the document's version (__v) is unchanged since it was loaded
    // and increments it. If two writers (for example the webhook flow and a human agent) load
    // the same conversation and both save, the second gets a VersionError instead of silently
    // writing fields that no longer fit the state the first one left behind.
    optimisticConcurrency: true,
  },
);

// ---------------------------------------------------------------------------
// Indexes
// ---------------------------------------------------------------------------

// Customer's own conversation list, newest activity first.
conversationSchema.index({ customerId: 1, updatedAt: -1 });

// Human queue and dashboards: "all conversations in status X", oldest waiting first.
conversationSchema.index({ status: 1, updatedAt: 1 });

// An agent's workload: "conversations assigned to me in status X". Partial, so the many
// conversations that have never had an agent do not take up space in the index.
conversationSchema.index(
  { assignedAgentId: 1, status: 1 },
  { partialFilterExpression: { assignedAgentId: { $type: 'objectId' } } },
);

// ---------------------------------------------------------------------------
// State tracking and validation
// ---------------------------------------------------------------------------

// Remember the status as loaded from the database, so `pre('validate')` can compare
// the old and new values. `$locals` is not persisted.
conversationSchema.post('init', function rememberLoadedStatus() {
  this.$locals.persistedStatus = this.status;
});

// After a successful save, the newly written status becomes the baseline for the next change.
conversationSchema.post('save', function rememberSavedStatus() {
  this.$locals.persistedStatus = this.status;
});

/**
 * Rejects invalid workflow states before anything is written. Errors are reported with
 * `invalidate`, so the save fails with a Mongoose ValidationError, which the backend's
 * error handler returns as HTTP 400 with the field-level details.
 */
conversationSchema.pre('validate', async function enforceWorkflowRules() {
  const next = this.status;

  // 1. New conversations always start in the unassigned state.
  if (this.isNew && next !== S.UNASSIGNED) {
    this.invalidate('status', `New conversations must start as "${S.UNASSIGNED}", not "${next}"`, next);
  }

  // 2. A status change on an existing conversation must follow ALLOWED_STATUS_TRANSITIONS.
  const previous = this.$locals.persistedStatus;
  if (!this.isNew && this.isModified('status') && previous && previous !== next) {
    if (!ALLOWED_STATUS_TRANSITIONS[previous]?.includes(next)) {
      this.invalidate('status', `Transition "${previous}" → "${next}" is not allowed`, next);
    }
  }

  // 3. The active worker must be one that can run in the current status.
  if (!WORKERS_ALLOWED_IN_STATUS[next]?.includes(this.currentActiveWorker)) {
    this.invalidate(
      'currentActiveWorker',
      `Worker "${this.currentActiveWorker}" cannot be active while status is "${next}"`,
      this.currentActiveWorker,
    );
  }

  // 4. Only assigned-agent conversations have an assigned agent.
  if (next === S.ASSIGNED_AGENT && !this.assignedAgentId) {
    this.invalidate('assignedAgentId', `assignedAgentId is required when status is "${next}"`);
  }
  if (next !== S.ASSIGNED_AGENT && this.assignedAgentId) {
    this.invalidate('assignedAgentId', `assignedAgentId must be empty when status is "${next}"`);
  }
});

// ---------------------------------------------------------------------------
// Workflow methods
// ---------------------------------------------------------------------------

/**
 * Moves the conversation to `nextStatus` and sets the fields that status requires,
 * so callers do not have to know the consistency rules. Does not save; the caller
 * calls `save()`, which runs the validation above.
 *
 *   conversation.transitionTo('processing-ai', { worker: 'billing_agent' });
 *   conversation.transitionTo('assigned-agent', { agentId: req.user._id });
 *   await conversation.save();
 *
 * @param {string} nextStatus  One of CONVERSATION_STATUS.
 * @param {object} [options]
 * @param {string} [options.worker]   AI worker to activate; only used for processing-ai
 *                                    (defaults to supervisor).
 * @param {import('mongoose').Types.ObjectId|string} [options.agentId]
 *                                    Human agent claiming the thread; required for assigned-agent.
 * @returns {this}
 */
conversationSchema.methods.transitionTo = function transitionTo(nextStatus, { worker, agentId } = {}) {
  this.status = nextStatus;

  switch (nextStatus) {
    case S.PROCESSING_AI:
      this.currentActiveWorker = worker ?? W.SUPERVISOR;
      this.assignedAgentId = null;
      break;
    case S.ESCALATED_TO_HUMAN:
      this.currentActiveWorker = W.HUMAN;
      this.assignedAgentId = null;
      break;
    case S.ASSIGNED_AGENT:
      this.currentActiveWorker = W.HUMAN;
      this.assignedAgentId = agentId ?? null;
      break;
    case S.UNASSIGNED:
      this.currentActiveWorker = W.SUPERVISOR;
      this.assignedAgentId = null;
      break;
    default:
      // Leave the fields alone; the enum validator rejects the unknown status on save.
      break;
  }
  return this;
};

/**
 * Switches the active AI worker while the conversation stays in processing-ai, e.g. when
 * the supervisor routes from billing_agent to tech_agent. Does not save.
 */
conversationSchema.methods.routeToWorker = function routeToWorker(worker) {
  this.currentActiveWorker = worker;
  return this;
};

// ---------------------------------------------------------------------------
// Query-update guard
// ---------------------------------------------------------------------------

/**
 * Query-style updates skip `pre('validate')`, so they could write a status that breaks
 * the state machine. This hook rejects any query update that touches `status`,
 * `assignedAgentId`, or `currentActiveWorker`; those must go through `transitionTo` + `save()`.
 * The error is a programming mistake, not a client error, so it surfaces as HTTP 500.
 */
const WORKFLOW_FIELDS = ['status', 'assignedAgentId', 'currentActiveWorker'];

conversationSchema.pre(
  ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace'],
  function blockWorkflowFieldUpdates() {
    const update = this.getUpdate() ?? {};
    const touched = WORKFLOW_FIELDS.filter(
      (field) =>
        field in update ||
        Object.values(update).some((op) => op && typeof op === 'object' && field in op),
    );
    if (touched.length > 0) {
      throw new Error(
        `Conversation workflow fields (${touched.join(', ')}) must be changed with transitionTo() and save(), not a query update`,
      );
    }
  },
);

const Conversation = mongoose.model('Conversation', conversationSchema);

export default Conversation;
