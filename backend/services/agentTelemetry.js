/**
 * Live agent telemetry: the wire contract between the ai-service and admin telemetry consoles.
 *
 * ============================================================================
 * Pipeline
 * ============================================================================
 *
 *   ai-service  LangChain callback handler (ai-service/app/telemetry.py) records each graph node,
 *               model call, tool run and retriever query of a turn, and posts batches to
 *   backend     POST /api/internal/agent-telemetry/events  (controllers/agentTelemetryController.js)
 *               -> normalizeTelemetryEvent (this file) validates each event against an allowlist
 *               -> emitAgentTelemetryEvents (utils/socketManager.js) fans them out to the
 *                  `agent-telemetry` room, which only admin sockets can join
 *   console     receives AGENT_THINKING_EVENT / TOOL_EXECUTION_STARTED / TOOL_EXECUTION_COMPLETED
 *
 * Telemetry is a live view only. Events are not stored, a console that connects late sees only
 * what happens afterwards, and an event lost in transit is not resent. The authoritative record
 * of a turn stays in the conversation's stored messages and the services' logs.
 *
 * ============================================================================
 * What an event may carry (privacy)
 * ============================================================================
 *
 * Events describe how the agents worked, never what was said: no message text, tool arguments,
 * tool results, model reasoning or customer identifiers. Every field is either an identifier,
 * an enum, a count or a duration. The allowlist below is enforced here, on the receiving side,
 * so a bug or a compromised sender in the ai-service cannot push conversation content to
 * consoles. Unknown fields are dropped, and an event with an invalid field is rejected whole.
 *
 * Inbound (snake_case, from the ai-service)        Outbound (camelCase, to sockets)
 *   event_id        32 hex chars                     eventId
 *   event_type      one of AGENT_TELEMETRY_EVENTS    eventType (also the socket event name)
 *   occurred_at     ISO-8601 timestamp               occurredAt
 *   workflow        support | regularization         workflow
 *   turn_id         32 hex chars                     turnId    groups the events of one turn
 *   sequence        integer >= 0, per turn           sequence  orders events within a turn
 *   conversation_id ObjectId string or null          conversationId
 *   node            graph node name or null          node
 *   phase           THINKING_PHASES (thinking only)  phase
 *   run_id          32 hex chars or null             runId     pairs tool start/complete
 *   tool_name       tool name (tool events only)     toolName
 *   status          success | error or null          status
 *   error_type      exception class name or null     errorType
 *   metrics         METRIC_RULES keys only           metrics
 */

import { isValidObjectIdString } from '../validators/conversationValidators.js';

export const AGENT_TELEMETRY_EVENTS = Object.freeze({
  AGENT_THINKING_EVENT: 'AGENT_THINKING_EVENT',
  TOOL_EXECUTION_STARTED: 'TOOL_EXECUTION_STARTED',
  TOOL_EXECUTION_COMPLETED: 'TOOL_EXECUTION_COMPLETED',
});

/** What an AGENT_THINKING_EVENT reports. */
export const THINKING_PHASES = Object.freeze([
  'turn_started',
  'node_started',
  'node_completed',
  'model_call_completed',
  'model_call_failed',
  'retrieval_completed',
  'turn_completed',
  'turn_failed',
]);

export const TELEMETRY_WORKFLOWS = Object.freeze(['support', 'regularization']);
export const TELEMETRY_STATUSES = Object.freeze(['success', 'error']);

export const TELEMETRY_LIMITS = Object.freeze({
  MAX_EVENTS_PER_BATCH: 200,
  // Events older than this (or this far in the future) are rejected: a console shows live
  // activity, and a badly skewed clock would sort events misleadingly.
  MAX_CLOCK_SKEW_MS: 5 * 60_000,
  MAX_REJECTION_DETAILS: 20,
});

const HEX_ID_PATTERN = /^[0-9a-f]{32}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;
const MODEL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_./:-]{0,99}$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;

const MAX_DURATION_MS = 24 * 60 * 60 * 1000;
const MAX_COUNT = 10_000_000;

const isNonNegativeNumber = (maximum) => (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= maximum;
const isCount = (value) => Number.isInteger(value) && value >= 0 && value <= MAX_COUNT;
const isUnitInterval = isNonNegativeNumber(1);

/**
 * Allowed metric keys: inbound name -> [outbound name, validator]. Every metric is optional.
 * Relevance scores are normalised to 0..1 by the sender; anything else is rejected rather than
 * shown on a scale the console cannot interpret.
 */
const METRIC_RULES = Object.freeze({
  duration_ms: ['durationMs', isNonNegativeNumber(MAX_DURATION_MS)],
  model_name: ['modelName', (value) => typeof value === 'string' && MODEL_NAME_PATTERN.test(value)],
  input_tokens: ['inputTokens', isCount],
  output_tokens: ['outputTokens', isCount],
  tokens_per_second: ['tokensPerSecond', isNonNegativeNumber(1_000_000)],
  result_chars: ['resultChars', isCount],
  transcript_messages: ['transcriptMessages', isCount],
  model_calls: ['modelCalls', isCount],
  tool_calls: ['toolCalls', isCount],
  documents_returned: ['documentsReturned', isCount],
  top_relevance_score: ['topRelevanceScore', isUnitInterval],
  mean_relevance_score: ['meanRelevanceScore', isUnitInterval],
  route_decision: ['routeDecision', (value) => typeof value === 'string' && IDENTIFIER_PATTERN.test(value)],
});

class TelemetryFieldError extends Error {
  constructor(field, message) {
    super(message);
    this.field = field;
  }
}

function requireField(condition, field, message) {
  if (!condition) throw new TelemetryFieldError(field, message);
}

function optionalMatching(value, pattern, field, message) {
  if (value === undefined || value === null) return null;
  requireField(typeof value === 'string' && pattern.test(value), field, message);
  return value;
}

function normalizeMetrics(rawMetrics) {
  if (rawMetrics === undefined || rawMetrics === null) return {};
  requireField(typeof rawMetrics === 'object' && !Array.isArray(rawMetrics), 'metrics', 'must be an object');
  const metrics = {};
  for (const [metricName, metricValue] of Object.entries(rawMetrics)) {
    const rule = METRIC_RULES[metricName];
    if (!rule || metricValue === null) continue; // unknown metrics are dropped, not forwarded
    const [outboundName, isValid] = rule;
    requireField(isValid(metricValue), `metrics.${metricName}`, 'has an invalid value');
    metrics[outboundName] = typeof metricValue === 'number' ? Math.round(metricValue * 1000) / 1000 : metricValue;
  }
  return metrics;
}

/**
 * Validates one inbound event and returns the outbound payload.
 * @param {unknown} rawEvent
 * @param {number} receivedAtMs
 * @returns {{ ok: true, event: object } | { ok: false, field: string, message: string }}
 */
export function normalizeTelemetryEvent(rawEvent, receivedAtMs = Date.now()) {
  try {
    requireField(typeof rawEvent === 'object' && rawEvent !== null && !Array.isArray(rawEvent), 'event', 'must be an object');
    const eventType = rawEvent.event_type;
    requireField(typeof eventType === 'string' && Object.hasOwn(AGENT_TELEMETRY_EVENTS, eventType),'event_type', 'is not a telemetry event type');
    requireField(typeof rawEvent.event_id === 'string' && HEX_ID_PATTERN.test(rawEvent.event_id), 'event_id', 'must be 32 hex characters');
    requireField(typeof rawEvent.turn_id === 'string' && HEX_ID_PATTERN.test(rawEvent.turn_id), 'turn_id', 'must be 32 hex characters');
    requireField(TELEMETRY_WORKFLOWS.includes(rawEvent.workflow), 'workflow', `must be one of ${TELEMETRY_WORKFLOWS.join(', ')}`);
    requireField(Number.isInteger(rawEvent.sequence) && rawEvent.sequence >= 0 && rawEvent.sequence <= MAX_COUNT, 'sequence', 'must be a non-negative integer');

    const occurredAt = rawEvent.occurred_at;
    const occurredAtMs = typeof occurredAt === 'string' && ISO_TIMESTAMP_PATTERN.test(occurredAt) ? Date.parse(occurredAt) : Number.NaN;
    requireField(Number.isFinite(occurredAtMs), 'occurred_at', 'must be an ISO-8601 timestamp with a time zone');
    requireField(Math.abs(receivedAtMs - occurredAtMs) <= TELEMETRY_LIMITS.MAX_CLOCK_SKEW_MS, 'occurred_at', 'is too far from the current time');

    const conversationId = rawEvent.conversation_id ?? null;
    requireField(conversationId === null || isValidObjectIdString(conversationId), 'conversation_id', 'must be a conversation id or null');

    const isThinkingEvent = eventType === AGENT_TELEMETRY_EVENTS.AGENT_THINKING_EVENT;
    const phase = rawEvent.phase ?? null;
    if (isThinkingEvent) requireField(THINKING_PHASES.includes(phase), 'phase', `must be one of ${THINKING_PHASES.join(', ')}`);
    else requireField(phase === null, 'phase', 'is only allowed on AGENT_THINKING_EVENT');

    const toolName = optionalMatching(rawEvent.tool_name, IDENTIFIER_PATTERN, 'tool_name', 'must be a tool name');
    if (!isThinkingEvent) requireField(toolName !== null, 'tool_name', 'is required on tool events');

    const runId = optionalMatching(rawEvent.run_id, HEX_ID_PATTERN, 'run_id', 'must be 32 hex characters');
    if (!isThinkingEvent) requireField(runId !== null, 'run_id', 'is required on tool events');

    const status = rawEvent.status ?? null;
    requireField(status === null || TELEMETRY_STATUSES.includes(status), 'status', `must be one of ${TELEMETRY_STATUSES.join(', ')}`);
    if (eventType === AGENT_TELEMETRY_EVENTS.TOOL_EXECUTION_COMPLETED) requireField(status !== null, 'status', 'is required on TOOL_EXECUTION_COMPLETED');

    return {
      ok: true,
      event: {
        eventId: rawEvent.event_id,
        eventType,
        occurredAt: new Date(occurredAtMs).toISOString(),
        receivedAt: new Date(receivedAtMs).toISOString(),
        workflow: rawEvent.workflow,
        turnId: rawEvent.turn_id,
        sequence: rawEvent.sequence,
        conversationId: conversationId === null ? null : conversationId.toLowerCase(),
        node: optionalMatching(rawEvent.node, IDENTIFIER_PATTERN, 'node', 'must be a node name'),
        phase,
        runId,
        toolName,
        status,
        errorType: optionalMatching(rawEvent.error_type, IDENTIFIER_PATTERN, 'error_type', 'must be an exception class name'),
        metrics: normalizeMetrics(rawEvent.metrics),
      },
    };
  } catch (validationError) {
    if (validationError instanceof TelemetryFieldError) {
      return { ok: false, field: validationError.field, message: validationError.message };
    }
    throw validationError;
  }
}
