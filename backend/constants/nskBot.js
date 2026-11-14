/**
 * The NSK assistant's vocabulary: one source for the models (ChatSession, ChatMessage), the
 * validators, the ai-service contract (services/nskBot/nskTurnClient.js) and the API the browser
 * reads. Values are stored, so they never change once written; labels can.
 *
 *   intents      what a turn is about, classified by the ai-service on every user message
 *   sentiments   the tone of that message; URGENT and FRUSTRATED make the reply short and lead with
 *                actions, SENSITIVE_HR makes it careful and points to HR
 *   outcomes     how a turn ended (see NSK_OUTCOMES)
 *   sources      what an answer's citations point at
 *
 * Which intents a person may use follows their capabilities (NSK_INTENT_CAPABILITIES): an intent
 * without a capability is open to everyone who may use the assistant. The backend sends the
 * allowed intents with every turn, refuses suggestions outside them, and every tool checks its own
 * capability again when it runs (services/nskBot/nskTools.js).
 */

import { CAPABILITIES, hasCapability } from './accessRoles.js';

export const NSK_INTENTS = Object.freeze({
  PROFILE_LOOKUP: 'PROFILE_LOOKUP',
  OFFBOARDING_WORKFLOW: 'OFFBOARDING_WORKFLOW',
  ATTENDANCE_AUDIT: 'ATTENDANCE_AUDIT',
  POLICY_QA: 'POLICY_QA',
  WEB_MARKET_RESEARCH: 'WEB_MARKET_RESEARCH',
  GENERAL_HELP: 'GENERAL_HELP',
});

export const NSK_SENTIMENTS = Object.freeze({
  POSITIVE: 'POSITIVE',
  NEUTRAL: 'NEUTRAL',
  URGENT: 'URGENT',
  FRUSTRATED: 'FRUSTRATED',
  SENSITIVE_HR: 'SENSITIVE_HR',
});

/** Sentiments that put action and a way to reach a person first. */
export const NSK_ESCALATING_SENTIMENTS = Object.freeze([
  NSK_SENTIMENTS.URGENT,
  NSK_SENTIMENTS.FRUSTRATED,
  NSK_SENTIMENTS.SENSITIVE_HR,
]);

/**
 *   ANSWERED     an answer traced to tools, documents or earlier conversations
 *   CLARIFY      the assistant needs one more detail (a date, which person); suggestions offer it
 *   NOT_FOUND    the tools and documents had nothing on it; the reply says what is missing
 *   NOT_ALLOWED  the request needs a capability this person does not have
 *   REFUSED      an answer was written but could not be verified against its sources, so it was
 *                not sent
 */
export const NSK_OUTCOMES = Object.freeze({
  ANSWERED: 'ANSWERED',
  CLARIFY: 'CLARIFY',
  NOT_FOUND: 'NOT_FOUND',
  NOT_ALLOWED: 'NOT_ALLOWED',
  REFUSED: 'REFUSED',
});

/**
 *   TOOL          a live read of the portal's data (the tool's name and what it read)
 *   DOCUMENT      a passage of a department knowledge base document
 *   CONVERSATION  one of the person's earlier NSK sessions
 */
export const NSK_SOURCE_KINDS = Object.freeze({
  TOOL: 'TOOL',
  DOCUMENT: 'DOCUMENT',
  CONVERSATION: 'CONVERSATION',
});

export const NSK_MESSAGE_ROLES = Object.freeze({ USER: 'USER', ASSISTANT: 'ASSISTANT' });

/** Entities the classifier extracts from a message, by kind. */
export const NSK_ENTITY_KINDS = Object.freeze({
  EMPLOYEE_NAME: 'employeeName',
  DATE: 'date',
  STOCK_TICKER: 'stockTicker',
  DEPARTMENT: 'department',
});

/**
 * The capability each usable intent needs. An intent that is not listed has no tools yet, so it is
 * closed to everyone (the assistant says what it can help with instead). ATTENDANCE_AUDIT is the
 * person's own attendance here; looking at other people's comes with the people tools.
 */
export const NSK_INTENT_CAPABILITIES = Object.freeze({
  [NSK_INTENTS.ATTENDANCE_AUDIT]: CAPABILITIES.USE_NSK_ASSISTANT,
  [NSK_INTENTS.POLICY_QA]: CAPABILITIES.USE_NSK_ASSISTANT,
  [NSK_INTENTS.GENERAL_HELP]: CAPABILITIES.USE_NSK_ASSISTANT,
});

/** The intents `role` may use, in NSK_INTENTS order. */
export function allowedIntentsFor(role) {
  return Object.values(NSK_INTENTS).filter((intent) => {
    const capability = NSK_INTENT_CAPABILITIES[intent];
    return capability !== undefined && hasCapability(role, capability);
  });
}
