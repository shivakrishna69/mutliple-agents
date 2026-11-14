/**
 * Request validation for questions to department agents, their conversations, feedback, the
 * department's Questions Inbox and notifications. Text is trimmed; ids must be ids; unknown fields
 * are refused, so a typo fails loudly instead of being ignored.
 */

import { AGENT_CHAT_SETTINGS } from '../constants/validation.js';
import { FEEDBACK_RATINGS } from '../models/AgentMessage.js';
import { QUESTION_STATUSES } from '../models/AgentQuestion.js';
import { isValidObjectIdString } from './conversationValidators.js';
import { bodyNotObjectResult, isPlainObject, validationResult } from './requestShape.js';

export function refuseUnknownFields(requestBody, allowedFields, validationErrors) {
  for (const field of Object.keys(requestBody)) {
    if (!allowedFields.includes(field)) validationErrors.push({ field, message: 'is not expected' });
  }
}

/** Trimmed text of 1..maxLength characters, or an error; `optional` allows it to be absent or null. */
export function readText(value, field, maxLength, validationErrors, { optional = false } = {}) {
  if (optional && (value === undefined || value === null)) return null;
  if (typeof value !== 'string' || value.trim().length === 0) {
    validationErrors.push({ field, message: 'is required' });
    return null;
  }
  const text = value.trim();
  if (text.length > maxLength) validationErrors.push({ field, message: `must be at most ${maxLength} characters` });
  return text;
}

export function readOptionalId(value, field, validationErrors) {
  if (value === undefined || value === null) return null;
  if (!isValidObjectIdString(value)) {
    validationErrors.push({ field, message: 'must be an id' });
    return null;
  }
  return value.toLowerCase();
}

/** POST /chat: { question, conversationId?, stream? } */
export function validateAgentQuestion(requestBody) {
  if (!isPlainObject(requestBody)) return bodyNotObjectResult();
  const validationErrors = [];
  refuseUnknownFields(requestBody, ['question', 'conversationId', 'stream'], validationErrors);
  const question = readText(
    requestBody.question,
    'question',
    AGENT_CHAT_SETTINGS.QUESTION_MAX_LENGTH,
    validationErrors,
  );
  const conversationId = readOptionalId(requestBody.conversationId, 'conversationId', validationErrors);
  if (requestBody.stream !== undefined && typeof requestBody.stream !== 'boolean') {
    validationErrors.push({ field: 'stream', message: 'must be true or false' });
  }
  return validationResult(validationErrors, { question, conversationId, stream: requestBody.stream === true });
}

/** POST /feedback: { messageId, rating: UP|DOWN, comment? } */
export function validateAgentFeedback(requestBody) {
  if (!isPlainObject(requestBody)) return bodyNotObjectResult();
  const validationErrors = [];
  refuseUnknownFields(requestBody, ['messageId', 'rating', 'comment'], validationErrors);
  const messageId = isValidObjectIdString(requestBody.messageId) ? requestBody.messageId.toLowerCase() : null;
  if (!messageId) validationErrors.push({ field: 'messageId', message: 'must be an id' });
  if (!Object.values(FEEDBACK_RATINGS).includes(requestBody.rating)) {
    validationErrors.push({ field: 'rating', message: `must be ${Object.values(FEEDBACK_RATINGS).join(' or ')}` });
  }
  const comment = readText(
    requestBody.comment,
    'comment',
    AGENT_CHAT_SETTINGS.FEEDBACK_COMMENT_MAX_LENGTH,
    validationErrors,
    { optional: true },
  );
  return validationResult(validationErrors, { messageId, rating: requestBody.rating, comment });
}

/** GET /questions?status= */
export function validateQuestionListQuery(query) {
  const { status } = query;
  if (status === undefined || status === '') return validationResult([], { status: null });
  if (!Object.values(QUESTION_STATUSES).includes(status)) {
    return validationResult([
      { field: 'status', message: `must be one of ${Object.values(QUESTION_STATUSES).join(', ')}` },
    ]);
  }
  return validationResult([], { status });
}

/** POST /questions/:questionId/answer: { answer, saveAsFaq?, faqQuestion? } */
export function validateQuestionAnswer(requestBody) {
  if (!isPlainObject(requestBody)) return bodyNotObjectResult();
  const validationErrors = [];
  refuseUnknownFields(requestBody, ['answer', 'saveAsFaq', 'faqQuestion'], validationErrors);
  const answer = readText(requestBody.answer, 'answer', AGENT_CHAT_SETTINGS.LEAD_ANSWER_MAX_LENGTH, validationErrors);
  if (requestBody.saveAsFaq !== undefined && typeof requestBody.saveAsFaq !== 'boolean') {
    validationErrors.push({ field: 'saveAsFaq', message: 'must be true or false' });
  }
  const faqQuestion = readText(
    requestBody.faqQuestion,
    'faqQuestion',
    AGENT_CHAT_SETTINGS.FAQ_QUESTION_MAX_LENGTH,
    validationErrors,
    { optional: true },
  );
  return validationResult(validationErrors, { answer, saveAsFaq: requestBody.saveAsFaq === true, faqQuestion });
}

/** POST /questions/:questionId/faq: { faqQuestion? } */
export function validateFaqRequest(requestBody) {
  const body = requestBody ?? {};
  if (!isPlainObject(body)) return bodyNotObjectResult();
  const validationErrors = [];
  refuseUnknownFields(body, ['faqQuestion'], validationErrors);
  const faqQuestion = readText(
    body.faqQuestion,
    'faqQuestion',
    AGENT_CHAT_SETTINGS.FAQ_QUESTION_MAX_LENGTH,
    validationErrors,
    {
      optional: true,
    },
  );
  return validationResult(validationErrors, { faqQuestion });
}

/** GET /api/notifications?unread=true */
export function validateNotificationQuery(query) {
  const { unread } = query;
  if (unread === undefined || unread === 'false') return validationResult([], { unreadOnly: false });
  if (unread === 'true') return validationResult([], { unreadOnly: true });
  return validationResult([{ field: 'unread', message: 'must be true or false' }]);
}
