/**
 * POST {AI_SERVICE_URL}/ai/knowledge/answer (ai-service app/nodes/knowledge_agent/), always streamed:
 * the body is newline-delimited JSON, one event per line:
 *
 *   { "type": "delta", "text": ... }      part of the answer as the model writes it
 *   { "type": "final", outcome, answer, citations, passages_considered, usage }
 *                                         the checked result; its answer replaces the deltas
 *   { "type": "error", code, message }    the turn failed after the response started
 *
 * requestKnowledgeAnswer(input, { config, requestId, onDelta }) passes each delta's text to onDelta
 * and resolves to the final result in camelCase. Failures throw AiServiceError
 * (services/aiServiceClient.js) with the same kinds as the other ai-service calls:
 *   timeout           no final event within AI_SERVICE_TIMEOUT_MS (the whole exchange)
 *   unavailable       the service could not be reached
 *   error_response    a non-2xx status, or an error event
 *   invalid_response  a final event that does not match the contract, or none at all
 */

import { AI_FAILURE_KIND, AiServiceError } from '../aiServiceClient.js';

export const AI_KNOWLEDGE_ANSWER_PATH = '/ai/knowledge/answer';

// ai-service AnswerOutcome values, mapped to this backend's (models/AgentMessage.js).
const OUTCOMES = Object.freeze({ answered: 'ANSWERED', not_found: 'NOT_FOUND', refused: 'REFUSED' });
const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/;
// Generous bound on one streamed answer: the model's output limit is far below it.
const MAX_STREAM_BYTES = 2 * 1024 * 1024;

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

function invalid(detail) {
  return new AiServiceError(AI_FAILURE_KIND.INVALID_RESPONSE, detail);
}

function parseCitation(raw, index) {
  const at = `citations[${index}]`;
  if (!isPlainObject(raw)) throw invalid(`${at} is not an object`);
  if (!Number.isInteger(raw.number) || raw.number < 1) throw invalid(`${at}.number`);
  if (typeof raw.document_id !== 'string' || !OBJECT_ID_PATTERN.test(raw.document_id)) {
    throw invalid(`${at}.document_id`);
  }
  if (!Number.isInteger(raw.chunk_index) || raw.chunk_index < 0) throw invalid(`${at}.chunk_index`);
  if (!Array.isArray(raw.heading_path) || raw.heading_path.some((heading) => typeof heading !== 'string')) {
    throw invalid(`${at}.heading_path`);
  }
  if (raw.page !== null && !Number.isInteger(raw.page)) throw invalid(`${at}.page`);
  if (typeof raw.excerpt !== 'string' || raw.excerpt.length === 0) throw invalid(`${at}.excerpt`);
  if (typeof raw.score !== 'number') throw invalid(`${at}.score`);
  return {
    number: raw.number,
    documentId: raw.document_id,
    chunkIndex: raw.chunk_index,
    headingPath: raw.heading_path,
    page: raw.page,
    excerpt: raw.excerpt,
    score: raw.score,
  };
}

/** The final event in this backend's shape; throws invalid_response naming the first bad field. */
export function parseFinalEvent(event) {
  const outcome = OUTCOMES[event.outcome];
  if (!outcome) throw invalid('outcome');
  if (typeof event.answer !== 'string' || event.answer.trim() === '') throw invalid('answer');
  if (!Array.isArray(event.citations)) throw invalid('citations');
  if (!Number.isInteger(event.passages_considered) || event.passages_considered < 0) {
    throw invalid('passages_considered');
  }
  const usage = event.usage;
  if (usage !== null && usage !== undefined) {
    if (!isPlainObject(usage) || !Number.isInteger(usage.input_tokens) || !Number.isInteger(usage.output_tokens)) {
      throw invalid('usage');
    }
  }
  const citations = event.citations.map(parseCitation);
  if (outcome === OUTCOMES.answered && citations.length === 0) throw invalid('an answer must cite a passage');
  return {
    outcome,
    answer: event.answer,
    citations,
    passagesConsidered: event.passages_considered,
    usage: usage ? { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens } : null,
  };
}

/**
 * @param {{ department_id: string, department_name: string, agent_name: string,
 *   agent_instructions: string|null, question: string, history: Array<{ role: string, content: string }> }} input
 * @param {{ config: object, requestId: string, onDelta?: (text: string) => void|Promise<void> }} context
 */
export async function requestKnowledgeAnswer(input, { config, requestId, onDelta = null }) {
  const startedAtMs = Date.now();
  const deadline = AbortSignal.timeout(config.aiServiceTimeoutMs);
  const timedOut = () =>
    new AiServiceError(AI_FAILURE_KIND.TIMEOUT, `no answer within ${config.aiServiceTimeoutMs} ms`, {
      durationMs: Date.now() - startedAtMs,
    });

  let response;
  try {
    response = await fetch(`${config.aiServiceUrl}${AI_KNOWLEDGE_ANSWER_PATH}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/x-ndjson',
        'X-Internal-Api-Key': config.aiServiceApiKey,
        'X-Request-Id': requestId,
      },
      body: JSON.stringify({ ...input, stream: true }),
      signal: deadline,
      // An internal service never needs to redirect; following one could leak the API key.
      redirect: 'error',
    });
  } catch (requestError) {
    if (deadline.aborted) throw timedOut();
    throw new AiServiceError(AI_FAILURE_KIND.UNAVAILABLE, requestError.cause?.code ?? requestError.message, {
      durationMs: Date.now() - startedAtMs,
    });
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new AiServiceError(AI_FAILURE_KIND.ERROR_RESPONSE, `HTTP ${response.status}`, {
      httpStatus: response.status,
      durationMs: Date.now() - startedAtMs,
    });
  }

  const decoder = new TextDecoder();
  let buffered = '';
  let receivedBytes = 0;
  let final = null;
  const handleLine = async (line) => {
    if (!line.trim()) return;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      throw invalid('a line is not JSON');
    }
    if (!isPlainObject(event)) throw invalid('an event is not an object');
    if (event.type === 'delta') {
      if (typeof event.text !== 'string') throw invalid('delta.text');
      if (onDelta && event.text) await onDelta(event.text);
    } else if (event.type === 'final') {
      final = parseFinalEvent(event);
    } else if (event.type === 'error') {
      throw new AiServiceError(AI_FAILURE_KIND.ERROR_RESPONSE, `stream error ${String(event.code)}`, {
        durationMs: Date.now() - startedAtMs,
      });
    } else {
      throw invalid(`unknown event type ${String(event.type)}`);
    }
  };

  try {
    for await (const chunk of response.body) {
      receivedBytes += chunk.byteLength;
      if (receivedBytes > MAX_STREAM_BYTES) throw invalid('the answer stream is too large');
      buffered += decoder.decode(chunk, { stream: true });
      let newlineAt;
      while ((newlineAt = buffered.indexOf('\n')) !== -1) {
        const line = buffered.slice(0, newlineAt);
        buffered = buffered.slice(newlineAt + 1);
        await handleLine(line);
        if (final) break;
      }
      if (final) break;
    }
    if (!final) await handleLine(buffered + decoder.decode());
  } catch (streamError) {
    if (streamError instanceof AiServiceError) throw streamError;
    if (deadline.aborted) throw timedOut();
    throw new AiServiceError(AI_FAILURE_KIND.UNAVAILABLE, streamError.message, {
      durationMs: Date.now() - startedAtMs,
    });
  }
  if (!final) throw invalid('the stream ended without a final event');
  return { ...final, durationMs: Date.now() - startedAtMs };
}
