/**
 * Questions to department agents, and the conversations they make.
 *
 *   listAvailableAgents(user)          the agents this person may ask: active, with at least one
 *                                      document ready, in an active department, and open to them
 *                                      (agentAudience.js)
 *   loadAskScope(user, departmentId)   the same rule for one department, before a question:
 *                                      404 department / 403 (role, no employee record, not in the
 *                                      audience) / 409 (agent paused or with nothing to answer from)
 *   askAgent(scope, ...)               one question: the daily quota (AGENT_DAILY_QUESTION_LIMIT,
 *                                      a UTC day), the conversation (new or continued), the recent
 *                                      history, the ai-service's streamed answer, the stored answer
 *                                      with its cited passages; an unanswered question goes to the
 *                                      department's Questions Inbox at once. When the ai-service
 *                                      fails, nothing of the question is kept and the quota is
 *                                      given back.
 *   listConversations / getConversation / deleteConversation / clearConversations
 *                                      the person's own only; their conversations with an agent
 *   rateAnswer(user, ...)              thumbs up or down on an agent answer; down sends the question
 *                                      to the department
 *
 * Conversations and messages expire AGENT_CHAT_SETTINGS.RETENTION_DAYS after their last message.
 */

import { CAPABILITIES, hasCapability } from '../../constants/accessRoles.js';
import { HTTP_STATUS } from '../../constants/httpStatus.js';
import { AGENT_CHAT_MESSAGES } from '../../constants/messages.js';
import { AGENT_CHAT_SETTINGS } from '../../constants/validation.js';
import AgentChatUsage from '../../models/AgentChatUsage.js';
import AgentConversation from '../../models/AgentConversation.js';
import AgentDocument, { DOCUMENT_STATUSES } from '../../models/AgentDocument.js';
import AgentMessage, {
  AGENT_ANSWER_OUTCOMES,
  AGENT_MESSAGE_ROLES,
  FEEDBACK_RATINGS,
} from '../../models/AgentMessage.js';
import AgentQuestion, { QUESTION_REASONS } from '../../models/AgentQuestion.js';
import Department from '../../models/Department.js';
import DepartmentAgent, { AGENT_STATUSES } from '../../models/DepartmentAgent.js';
import User from '../../models/User.js';
import { isDuplicateKeyError } from '../../utils/mongoErrors.js';
import { managesKnowledgeBase } from '../knowledge/knowledgeBaseService.js';
import { ServiceError } from '../serviceError.js';
import { askRefusalReason, effectiveAudienceOf, loadAskerMembership } from './agentAudience.js';
import { escalateQuestion } from './agentQuestionService.js';
import { requestKnowledgeAnswer } from './knowledgeAnswerClient.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const refusal = (httpStatus, code) => new ServiceError(httpStatus, code, AGENT_CHAT_MESSAGES[code]);
const retentionFrom = (date) => new Date(date.getTime() + AGENT_CHAT_SETTINGS.RETENTION_DAYS * DAY_MS);
const API_ROLES = Object.freeze({
  [AGENT_MESSAGE_ROLES.USER]: 'user',
  [AGENT_MESSAGE_ROLES.ASSISTANT]: 'assistant',
  // The department's reply reads, to the agent, as an earlier answer.
  [AGENT_MESSAGE_ROLES.LEAD]: 'assistant',
});

const isManager = (user, department, agent, membership) =>
  managesKnowledgeBase(user, { department, agent, ownProfileId: membership.profile?._id ?? null });

async function readyDocumentCounts(departmentIds) {
  const counts = await AgentDocument.aggregate([
    { $match: { departmentId: { $in: departmentIds }, status: DOCUMENT_STATUSES.READY } },
    { $group: { _id: '$departmentId', count: { $sum: 1 } } },
  ]);
  return new Map(counts.map(({ _id, count }) => [_id.toString(), count]));
}

function requireAskCapability(user) {
  if (!hasCapability(user.role, CAPABILITIES.ASK_DEPARTMENT_AGENTS)) {
    throw refusal(HTTP_STATUS.FORBIDDEN, 'ASK_NOT_ALLOWED');
  }
}

export async function listAvailableAgents(user) {
  requireAskCapability(user);
  const agents = await DepartmentAgent.find({ status: AGENT_STATUSES.ACTIVE }).lean();
  if (agents.length === 0) return [];
  const departments = await Department.find({
    _id: { $in: agents.map((agent) => agent.departmentId) },
    isActive: { $ne: false },
  }).lean();
  const departmentById = new Map(departments.map((department) => [department._id.toString(), department]));
  const readyCounts = await readyDocumentCounts(departments.map((department) => department._id));
  const membership = await loadAskerMembership(user.id);
  return agents
    .map((agent) => ({ agent, department: departmentById.get(agent.departmentId.toString()) }))
    .filter(
      ({ agent, department }) =>
        department &&
        (readyCounts.get(department._id.toString()) ?? 0) > 0 &&
        askRefusalReason({
          department,
          agent,
          membership,
          managesKnowledgeBase: isManager(user, department, agent, membership),
        }) === null,
    )
    .map(({ agent, department }) => ({
      department: { id: department._id.toString(), name: department.name, code: department.code },
      agent: { id: agent._id.toString(), name: agent.name },
      audience: effectiveAudienceOf(department, agent),
      readyDocuments: readyCounts.get(department._id.toString()),
    }))
    .sort((first, second) => first.department.name.localeCompare(second.department.name));
}

/** @returns {Promise<{ department: object, agent: object, membership: object }>} */
export async function loadAskScope(user, departmentId) {
  requireAskCapability(user);
  const department = await Department.findById(departmentId).lean();
  if (!department || department.isActive === false) throw refusal(HTTP_STATUS.NOT_FOUND, 'DEPARTMENT_NOT_FOUND');
  const agent = await DepartmentAgent.findOne({ departmentId: department._id }).lean();
  if (!agent || agent.status !== AGENT_STATUSES.ACTIVE) throw refusal(HTTP_STATUS.CONFLICT, 'AGENT_UNAVAILABLE');
  const membership = await loadAskerMembership(user.id);
  const reason = askRefusalReason({
    department,
    agent,
    membership,
    managesKnowledgeBase: isManager(user, department, agent, membership),
  });
  if (reason) throw refusal(HTTP_STATUS.FORBIDDEN, reason);
  const ready = await AgentDocument.exists({ departmentId: department._id, status: DOCUMENT_STATUSES.READY });
  if (!ready) throw refusal(HTTP_STATUS.CONFLICT, 'AGENT_NOT_READY');
  return { department, agent, membership };
}

// =================================================================================================
// The daily quota
// =================================================================================================

const utcDay = (date = new Date()) => date.toISOString().slice(0, 10);

/** Counts one question for today; refuses (429) past the limit. Returns how to give it back. */
async function reserveDailyQuestion(userId, limit) {
  const day = utcDay();
  const increment = () =>
    AgentChatUsage.findOneAndUpdate(
      { userId, day },
      {
        $inc: { questions: 1 },
        $setOnInsert: { expiresAt: new Date(Date.now() + (AGENT_CHAT_SETTINGS.USAGE_RETENTION_DAYS + 1) * DAY_MS) },
      },
      { upsert: true, new: true },
    ).lean();
  let usage;
  try {
    usage = await increment();
  } catch (incrementError) {
    // Two first questions of the day at once: the second upsert finds the first one's counter.
    if (!isDuplicateKeyError(incrementError)) throw incrementError;
    usage = await increment();
  }
  const giveBack = () => AgentChatUsage.updateOne({ userId, day }, { $inc: { questions: -1 } });
  if (usage.questions > limit) {
    await giveBack();
    throw new ServiceError(
      HTTP_STATUS.TOO_MANY_REQUESTS,
      'DAILY_LIMIT_REACHED',
      AGENT_CHAT_MESSAGES.DAILY_LIMIT_REACHED(limit),
    );
  }
  return {
    giveBack,
    recordTokens: (usageReport) =>
      usageReport
        ? AgentChatUsage.updateOne(
            { userId, day },
            { $inc: { inputTokens: usageReport.inputTokens, outputTokens: usageReport.outputTokens } },
          )
        : null,
  };
}

// =================================================================================================
// Summaries
// =================================================================================================

export function toConversationSummary(conversation) {
  return {
    id: conversation._id.toString(),
    departmentId: conversation.departmentId.toString(),
    title: conversation.title,
    lastMessageAt: conversation.lastMessageAt,
    createdAt: conversation.createdAt,
  };
}

function toMessageSummary(message, { questionStatuses = new Map(), authors = new Map() } = {}) {
  const questionId = message.questionId?.toString() ?? null;
  return {
    id: message._id.toString(),
    role: message.role,
    content: message.content,
    outcome: message.outcome ?? null,
    citations: (message.citations ?? []).map((citation) => ({
      number: citation.number,
      documentId: citation.documentId.toString(),
      documentName: citation.documentName ?? null,
      headingPath: citation.headingPath ?? [],
      page: citation.page ?? null,
      excerpt: citation.excerpt,
    })),
    feedback: message.feedback?.rating ? { rating: message.feedback.rating, comment: message.feedback.comment } : null,
    question: questionId ? { id: questionId, status: questionStatuses.get(questionId) ?? null } : null,
    author: message.authorId ? (authors.get(message.authorId.toString()) ?? null) : null,
    createdAt: message.createdAt,
  };
}

async function summarizeMessages(messages) {
  const questionIds = messages.map((message) => message.questionId).filter(Boolean);
  const authorIds = messages.map((message) => message.authorId).filter(Boolean);
  const [questions, authors] = await Promise.all([
    questionIds.length
      ? AgentQuestion.find({ _id: { $in: questionIds } })
          .select('status')
          .lean()
      : [],
    authorIds.length
      ? User.find({ _id: { $in: authorIds } })
          .select('name')
          .lean()
      : [],
  ]);
  const context = {
    questionStatuses: new Map(questions.map((question) => [question._id.toString(), question.status])),
    authors: new Map(
      authors.map((author) => [author._id.toString(), { id: author._id.toString(), name: author.name }]),
    ),
  };
  return messages.map((message) => toMessageSummary(message, context));
}

// =================================================================================================
// Asking
// =================================================================================================

async function findOwnConversation(user, departmentId, conversationId) {
  const conversation = await AgentConversation.findOne({ _id: conversationId, userId: user.id, departmentId }).lean();
  if (!conversation) throw refusal(HTTP_STATUS.NOT_FOUND, 'CONVERSATION_NOT_FOUND');
  return conversation;
}

const titleOf = (question) => {
  const flat = question.replace(/\s+/g, ' ').trim();
  const max = AGENT_CHAT_SETTINGS.CONVERSATION_TITLE_MAX_LENGTH;
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
};

async function recentHistory(conversationId) {
  const messages = await AgentMessage.find({ conversationId })
    .sort({ createdAt: -1, _id: -1 })
    .limit(AGENT_CHAT_SETTINGS.HISTORY_MESSAGES)
    .select('role content')
    .lean();
  return messages.reverse().map((message) => ({ role: API_ROLES[message.role], content: message.content }));
}

async function withDocumentNames(citations) {
  if (citations.length === 0) return [];
  const documents = await AgentDocument.find({ _id: { $in: citations.map((citation) => citation.documentId) } })
    .select('originalName')
    .lean();
  const names = new Map(documents.map((document) => [document._id.toString(), document.originalName]));
  return citations.map((citation) => ({ ...citation, documentName: names.get(citation.documentId) ?? null }));
}

const replyFor = (outcome, departmentName) =>
  outcome === AGENT_ANSWER_OUTCOMES.NOT_FOUND
    ? AGENT_CHAT_MESSAGES.REPLY_NOT_FOUND(departmentName)
    : AGENT_CHAT_MESSAGES.REPLY_REFUSED(departmentName);

/**
 * @param {{ department: object, agent: object }} scope  from loadAskScope
 * @param {{ id: string, name: string }} user
 * @param {{ question: string, conversationId: string|null }} input
 * @param {{ config: object, requestId: string, onStarted?: Function, onDelta?: Function }} context
 *   onStarted({ conversation, userMessage }) runs once the question is stored; onDelta(text) per piece
 * @returns {Promise<{ conversation, userMessage, message, question, outcome, durationMs }>}
 */
export async function askAgent({ department, agent }, user, { question, conversationId }, context) {
  const { config, requestId, onStarted = null, onDelta = null } = context;
  const existing = conversationId ? await findOwnConversation(user, department._id, conversationId) : null;
  const quota = await reserveDailyQuestion(user.id, config.agentDailyQuestionLimit);

  const askedAt = new Date();
  const history = existing ? await recentHistory(existing._id) : [];
  const conversation =
    existing ??
    (
      await AgentConversation.create({
        userId: user.id,
        departmentId: department._id,
        agentId: agent._id,
        title: titleOf(question),
        lastMessageAt: askedAt,
        expiresAt: retentionFrom(askedAt),
      })
    ).toObject();
  const userMessage = (
    await AgentMessage.create({
      conversationId: conversation._id,
      userId: user.id,
      departmentId: department._id,
      role: AGENT_MESSAGE_ROLES.USER,
      content: question,
      expiresAt: retentionFrom(askedAt),
    })
  ).toObject();
  if (onStarted)
    await onStarted({ conversation: toConversationSummary(conversation), userMessage: toMessageSummary(userMessage) });

  let result;
  try {
    result = await requestKnowledgeAnswer(
      {
        department_id: department._id.toString(),
        department_name: department.name,
        agent_name: agent.name,
        agent_instructions: agent.systemPrompt?.trim() ? agent.systemPrompt : null,
        question,
        history,
      },
      { config, requestId, onDelta },
    );
  } catch (answerError) {
    // Nothing of an unanswered question is kept: the person can simply ask again.
    await AgentMessage.deleteOne({ _id: userMessage._id });
    if (!existing) await AgentConversation.deleteOne({ _id: conversation._id });
    await quota.giveBack();
    throw answerError;
  }

  const answeredAt = new Date();
  const isAnswered = result.outcome === AGENT_ANSWER_OUTCOMES.ANSWERED;
  const assistantMessage = (
    await AgentMessage.create({
      conversationId: conversation._id,
      userId: user.id,
      departmentId: department._id,
      role: AGENT_MESSAGE_ROLES.ASSISTANT,
      content: isAnswered ? result.answer : replyFor(result.outcome, department.name),
      outcome: result.outcome,
      citations: isAnswered ? await withDocumentNames(result.citations) : [],
      usage: result.usage ?? { inputTokens: null, outputTokens: null },
      expiresAt: retentionFrom(answeredAt),
    })
  ).toObject();
  await AgentConversation.updateOne(
    { _id: conversation._id },
    { $set: { lastMessageAt: answeredAt, expiresAt: retentionFrom(answeredAt) } },
  );
  await quota.recordTokens(result.usage);

  let escalated = null;
  if (!isAnswered) {
    ({ question: escalated } = await escalateQuestion({
      department,
      agent,
      asker: user,
      conversationId: conversation._id,
      questionText: question,
      assistantMessage,
      reason: QUESTION_REASONS.UNANSWERED,
    }));
    assistantMessage.questionId = escalated._id;
  }
  const [message] = await summarizeMessages([assistantMessage]);
  return {
    conversation: toConversationSummary({ ...conversation, lastMessageAt: answeredAt }),
    userMessage: toMessageSummary(userMessage),
    message,
    question: escalated ? { id: escalated._id.toString(), status: escalated.status } : null,
    outcome: result.outcome,
    durationMs: result.durationMs,
  };
}

// =================================================================================================
// Conversations and feedback
// =================================================================================================

export async function listConversations(user, departmentId) {
  const conversations = await AgentConversation.find({ userId: user.id, departmentId })
    .sort({ lastMessageAt: -1 })
    .limit(AGENT_CHAT_SETTINGS.CONVERSATIONS_LISTED)
    .lean();
  return conversations.map(toConversationSummary);
}

export async function getConversation(user, departmentId, conversationId) {
  const conversation = await findOwnConversation(user, departmentId, conversationId);
  const messages = await AgentMessage.find({ conversationId: conversation._id })
    .sort({ createdAt: 1, _id: 1 })
    .limit(AGENT_CHAT_SETTINGS.MESSAGES_PER_CONVERSATION_LISTED)
    .lean();
  return { conversation: toConversationSummary(conversation), messages: await summarizeMessages(messages) };
}

/** Deletes the conversation and its messages. Questions already sent to the department stay there. */
export async function deleteConversation(user, departmentId, conversationId) {
  const conversation = await findOwnConversation(user, departmentId, conversationId);
  const { deletedCount } = await AgentMessage.deleteMany({ conversationId: conversation._id });
  await AgentConversation.deleteOne({ _id: conversation._id });
  return { deletedMessages: deletedCount };
}

export async function clearConversations(user, departmentId) {
  const conversations = await AgentConversation.find({ userId: user.id, departmentId }).select('_id').lean();
  const conversationIds = conversations.map((conversation) => conversation._id);
  const { deletedCount } = await AgentMessage.deleteMany({ conversationId: { $in: conversationIds } });
  await AgentConversation.deleteMany({ _id: { $in: conversationIds } });
  return { deletedConversations: conversationIds.length, deletedMessages: deletedCount };
}

/**
 * Rates one of the agent's answers to this person. DOWN sends the question to the department's
 * Questions Inbox (once per answer); the rating can be changed, an escalation is not taken back.
 * @param {{ messageId: string, rating: string, comment: string|null }} input
 */
export async function rateAnswer(user, departmentId, { messageId, rating, comment }) {
  const message = await AgentMessage.findOne({
    _id: messageId,
    userId: user.id,
    departmentId,
    role: AGENT_MESSAGE_ROLES.ASSISTANT,
  }).lean();
  if (!message) throw refusal(HTTP_STATUS.NOT_FOUND, 'MESSAGE_NOT_FOUND');
  await AgentMessage.updateOne({ _id: message._id }, { $set: { feedback: { rating, comment, ratedAt: new Date() } } });

  let escalated = null;
  if (rating === FEEDBACK_RATINGS.DOWN && !message.questionId) {
    const department = await Department.findById(departmentId).lean();
    const agent = await DepartmentAgent.findOne({ departmentId }).lean();
    const question = await AgentMessage.findOne({
      conversationId: message.conversationId,
      role: AGENT_MESSAGE_ROLES.USER,
      createdAt: { $lte: message.createdAt },
    })
      .sort({ createdAt: -1, _id: -1 })
      .lean();
    if (department && agent && question) {
      ({ question: escalated } = await escalateQuestion({
        department,
        agent,
        asker: user,
        conversationId: message.conversationId,
        questionText: question.content,
        assistantMessage: message,
        reason: QUESTION_REASONS.DOWNVOTED,
      }));
    }
  }
  const updated = await AgentMessage.findById(message._id).lean();
  const [summary] = await summarizeMessages([updated]);
  return { message: summary, escalated: Boolean(escalated) };
}
