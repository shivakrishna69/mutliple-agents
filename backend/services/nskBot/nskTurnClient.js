/**
 * POST {AI_SERVICE_URL}/ai/nsk/turn (ai-service app/nodes/nsk_assistant/): one NSK assistant turn.
 *
 * Request
 *   {
 *     "actor_token":     string,   // services/nskBot/actorToken.js; every tool call sends it back
 *     "user":            { "name": string, "role_label": string },
 *     "today":           "YYYY-MM-DD", "time_zone": IANA zone   // the person's own day
 *     "message":         string,
 *     "history":         [ { "role": "user"|"assistant", "content": string } ]   // oldest first
 *     "memory":          [ { "session_id", "title", "date", "topics": [string],
 *                            "entities": [ { "kind", "value" } ] } ]           // earlier sessions
 *     "allowed_intents": [ intent ], "allowed_tools": [ tool name ]
 *   }
 *
 * Response
 *   {
 *     "outcome":        "answered"|"clarify"|"not_found"|"not_allowed"|"refused",
 *     "reply":          string,
 *     "classification": { "intent", "sentiment", "confidence": 0..1, "topic": string|null,
 *                         "entities": [ { "kind", "value" } ] },
 *     "sources":        [ the sources the reply cites, by number:
 *                         { "number", "kind": "tool", "tool", "label" }
 *                         { "number", "kind": "document", "document_id", "department_id",
 *                           "chunk_index", "heading_path", "page", "excerpt", "score" }
 *                         { "number", "kind": "conversation", "session_id" } ],
 *     "suggestions":    [ { "text", "intent" } ],
 *     "tools_used":     [ tool name ],
 *     "usage":          { "input_tokens", "output_tokens" } | null
 *   }
 *
 * requestNskTurn checks the response against this contract and returns it in camelCase with the
 * backend's enum values; any deviation is an AiServiceError(invalid_response). What a source may
 * point at (the person's own documents and sessions) is checked by the caller.
 */

import {
  NSK_ENTITY_KINDS,
  NSK_INTENTS,
  NSK_OUTCOMES,
  NSK_SENTIMENTS,
  NSK_SOURCE_KINDS,
} from '../../constants/nskBot.js';
import { NSK_BOT_SETTINGS } from '../../constants/validation.js';
import { AI_FAILURE_KIND, AiServiceError, postToAiService } from '../aiServiceClient.js';

export const AI_NSK_TURN_PATH = '/ai/nsk/turn';

const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/;
const OUTCOMES = Object.freeze(
  Object.fromEntries(Object.values(NSK_OUTCOMES).map((outcome) => [outcome.toLowerCase(), outcome])),
);
const SOURCE_KINDS = Object.freeze(
  Object.fromEntries(Object.values(NSK_SOURCE_KINDS).map((kind) => [kind.toLowerCase(), kind])),
);
const ENTITY_KINDS = Object.values(NSK_ENTITY_KINDS);
const INTENTS = Object.values(NSK_INTENTS);
const SENTIMENTS = Object.values(NSK_SENTIMENTS);

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isShortText = (value, maxLength) => typeof value === 'string' && value.trim() !== '' && value.length <= maxLength;

function invalid(detail) {
  return new AiServiceError(AI_FAILURE_KIND.INVALID_RESPONSE, detail);
}

function parseEntity(raw, at) {
  if (!isPlainObject(raw) || !ENTITY_KINDS.includes(raw.kind)) throw invalid(`${at}.kind`);
  if (!isShortText(raw.value, NSK_BOT_SETTINGS.ENTITY_VALUE_MAX_LENGTH)) throw invalid(`${at}.value`);
  return { kind: raw.kind, value: raw.value.trim() };
}

function parseClassification(raw) {
  if (!isPlainObject(raw)) throw invalid('classification');
  if (!INTENTS.includes(raw.intent)) throw invalid('classification.intent');
  if (!SENTIMENTS.includes(raw.sentiment)) throw invalid('classification.sentiment');
  if (typeof raw.confidence !== 'number' || raw.confidence < 0 || raw.confidence > 1) {
    throw invalid('classification.confidence');
  }
  if (raw.topic !== null && !isShortText(raw.topic, NSK_BOT_SETTINGS.TOPIC_MAX_LENGTH)) {
    throw invalid('classification.topic');
  }
  if (!Array.isArray(raw.entities) || raw.entities.length > NSK_BOT_SETTINGS.ENTITIES_KEPT) {
    throw invalid('classification.entities');
  }
  return {
    intent: raw.intent,
    sentiment: raw.sentiment,
    confidence: raw.confidence,
    topic: raw.topic === null ? null : raw.topic.trim(),
    entities: raw.entities.map((entity, index) => parseEntity(entity, `classification.entities[${index}]`)),
  };
}

function parseSource(raw, index) {
  const at = `sources[${index}]`;
  if (!isPlainObject(raw)) throw invalid(`${at} is not an object`);
  if (!Number.isInteger(raw.number) || raw.number < 1) throw invalid(`${at}.number`);
  const kind = SOURCE_KINDS[raw.kind];
  if (!kind) throw invalid(`${at}.kind`);
  if (kind === NSK_SOURCE_KINDS.TOOL) {
    if (!isShortText(raw.tool, NSK_BOT_SETTINGS.TOOL_NAME_MAX_LENGTH)) throw invalid(`${at}.tool`);
    if (!isShortText(raw.label, NSK_BOT_SETTINGS.CITATION_LABEL_MAX_LENGTH)) throw invalid(`${at}.label`);
    return { number: raw.number, kind, tool: raw.tool, label: raw.label };
  }
  if (kind === NSK_SOURCE_KINDS.CONVERSATION) {
    if (typeof raw.session_id !== 'string' || !OBJECT_ID_PATTERN.test(raw.session_id)) {
      throw invalid(`${at}.session_id`);
    }
    return { number: raw.number, kind, sessionId: raw.session_id };
  }
  for (const field of ['document_id', 'department_id']) {
    if (typeof raw[field] !== 'string' || !OBJECT_ID_PATTERN.test(raw[field])) throw invalid(`${at}.${field}`);
  }
  if (!Number.isInteger(raw.chunk_index) || raw.chunk_index < 0) throw invalid(`${at}.chunk_index`);
  if (!Array.isArray(raw.heading_path) || raw.heading_path.some((heading) => typeof heading !== 'string')) {
    throw invalid(`${at}.heading_path`);
  }
  if (raw.page !== null && !Number.isInteger(raw.page)) throw invalid(`${at}.page`);
  if (typeof raw.excerpt !== 'string' || raw.excerpt.length === 0) throw invalid(`${at}.excerpt`);
  return {
    number: raw.number,
    kind,
    documentId: raw.document_id,
    departmentId: raw.department_id,
    headingPath: raw.heading_path,
    page: raw.page,
    excerpt: raw.excerpt.slice(0, NSK_BOT_SETTINGS.CITATION_EXCERPT_MAX_LENGTH),
  };
}

function parseSuggestion(raw, index) {
  const at = `suggestions[${index}]`;
  if (!isPlainObject(raw)) throw invalid(at);
  if (!isShortText(raw.text, NSK_BOT_SETTINGS.SUGGESTION_MAX_LENGTH)) throw invalid(`${at}.text`);
  if (!INTENTS.includes(raw.intent)) throw invalid(`${at}.intent`);
  return { text: raw.text.trim(), intent: raw.intent };
}

/** The response in this backend's shape; throws invalid_response naming the first bad field. */
export function parseNskTurnResponse(body) {
  if (!isPlainObject(body)) throw invalid('body is not a JSON object');
  const outcome = OUTCOMES[body.outcome];
  if (!outcome) throw invalid('outcome');
  if (!isShortText(body.reply, NSK_BOT_SETTINGS.REPLY_MAX_LENGTH)) throw invalid('reply');
  if (!Array.isArray(body.sources) || body.sources.length > NSK_BOT_SETTINGS.CITATIONS_MAX) throw invalid('sources');
  if (!Array.isArray(body.suggestions) || body.suggestions.length > NSK_BOT_SETTINGS.SUGGESTIONS_MAX) {
    throw invalid('suggestions');
  }
  const isToolList =
    Array.isArray(body.tools_used) &&
    body.tools_used.length <= NSK_BOT_SETTINGS.TOOLS_USED_MAX &&
    body.tools_used.every((name) => isShortText(name, NSK_BOT_SETTINGS.TOOL_NAME_MAX_LENGTH));
  if (!isToolList) throw invalid('tools_used');
  const { usage } = body;
  if (usage !== null && usage !== undefined) {
    if (!isPlainObject(usage) || !Number.isInteger(usage.input_tokens) || !Number.isInteger(usage.output_tokens)) {
      throw invalid('usage');
    }
  }
  const sources = body.sources.map(parseSource);
  if (new Set(sources.map((source) => source.number)).size !== sources.length) throw invalid('sources repeat a number');
  return {
    outcome,
    reply: body.reply.trim(),
    classification: parseClassification(body.classification),
    sources,
    suggestions: body.suggestions.map(parseSuggestion),
    toolsUsed: body.tools_used,
    usage: usage ? { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens } : null,
  };
}

/**
 * @param {object} turnRequest  the request above
 * @param {{ config: object, requestId: string }} callContext
 * @returns {Promise<ReturnType<typeof parseNskTurnResponse> & { durationMs: number }>}
 * @throws {AiServiceError}
 */
export function requestNskTurn(turnRequest, callContext) {
  return postToAiService(AI_NSK_TURN_PATH, turnRequest, callContext, parseNskTurnResponse);
}
