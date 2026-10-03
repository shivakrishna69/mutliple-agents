/**
 * Serialisers that turn stored documents into real-time event payloads.
 *
 * Each event has two audiences with different needs:
 *   staff     (agents, admins) see the full operational picture, including the AI's
 *             toolExecutionLogs and routing fields, to audit and take over conversations.
 *   customer  sees only what belongs in their chat window. Internal fields (tool logs, the AI
 *             worker handling them, agent ids, webhook event ids) are left out because they
 *             expose system internals and, for fallbacks, internal error details.
 *
 * Fields are copied from an explicit allowlist, so a field added to a model later is not
 * broadcast until someone adds it here on purpose.
 */

function toIsoTimestamp(dateValue) {
  return dateValue instanceof Date ? dateValue.toISOString() : dateValue ?? null;
}

/** Longest tool output text sent to clients; the full value stays in the database. */
const MAX_TOOL_OUTPUT_CHARACTERS = 500;

/** A tool step's output as bounded display text (it may be a string or structured data). */
function summarizeToolOutput(toolOutput) {
  if (toolOutput === null || toolOutput === undefined) return null;
  let outputText;
  if (typeof toolOutput === 'string') {
    outputText = toolOutput;
  } else {
    try {
      outputText = JSON.stringify(toolOutput);
    } catch {
      outputText = String(toolOutput);
    }
  }
  return outputText.length > MAX_TOOL_OUTPUT_CHARACTERS ? `${outputText.slice(0, MAX_TOOL_OUTPUT_CHARACTERS)}…` : outputText;
}

/** Full message payload for staff rooms. Accepts a Message document or lean record. */
export function toStaffMessagePayload(messageRecord) {
  return {
    messageId: messageRecord._id.toString(),
    conversationId: messageRecord.conversationId.toString(),
    senderType: messageRecord.senderType,
    senderUserId: messageRecord.senderUserId ? messageRecord.senderUserId.toString() : null,
    text: messageRecord.text,
    toolExecutionLogs: (messageRecord.toolExecutionLogs ?? []).map((toolStep) => ({
      step: toolStep.step,
      node: toolStep.node,
      toolName: toolStep.toolName ?? null,
      output: summarizeToolOutput(toolStep.output),
      status: toolStep.status,
      error: toolStep.error ?? null,
      startedAt: toIsoTimestamp(toolStep.startedAt),
      durationMs: toolStep.durationMs ?? null,
    })),
    createdAt: toIsoTimestamp(messageRecord.createdAt),
  };
}

/** Customer-safe projection of a staff message payload. */
export function toCustomerMessagePayload(staffMessagePayload) {
  return {
    messageId: staffMessagePayload.messageId,
    conversationId: staffMessagePayload.conversationId,
    senderType: staffMessagePayload.senderType,
    text: staffMessagePayload.text,
    createdAt: staffMessagePayload.createdAt,
  };
}

/** Full conversation status payload for staff. Accepts a Conversation document or lean record. */
export function toStaffConversationStatusPayload(conversationRecord) {
  return {
    conversationId: conversationRecord._id.toString(),
    customerId: conversationRecord.customerId.toString(),
    status: conversationRecord.status,
    currentActiveWorker: conversationRecord.currentActiveWorker,
    assignedAgentId: conversationRecord.assignedAgentId ? conversationRecord.assignedAgentId.toString() : null,
    updatedAt: toIsoTimestamp(conversationRecord.updatedAt),
  };
}

/** Customer-safe projection: whether a person or the assistant is handling them, and when. */
export function toCustomerConversationStatusPayload(staffStatusPayload) {
  return {
    conversationId: staffStatusPayload.conversationId,
    status: staffStatusPayload.status,
    updatedAt: staffStatusPayload.updatedAt,
  };
}
