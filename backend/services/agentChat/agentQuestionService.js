/**
 * Each department's Questions Inbox: what its agent could not settle goes to the people who own the
 * department's knowledge (its head and its knowledge lead), who answer the asker directly.
 *
 *   escalateQuestion(...)            files the question (UNANSWERED or DOWNVOTED; one per agent
 *                                    answer) and alerts the department's head and lead in the app
 *                                    (administrators when the department has neither)
 *   listDepartmentQuestions(scope)   the inbox, by status, newest first
 *   answerQuestion(scope, ...)       closes it with the answer: the reply is added to the asker's
 *                                    conversation (while it exists), and they are alerted in the app
 *                                    and by email; optionally saved as an FAQ
 *   dismissQuestion(scope, ...)      closes it without an answer (a duplicate, say)
 *   saveQuestionAsFaq(scope, ...)    adds an answered question to the knowledge base as a Markdown
 *                                    document (source FAQ), processed and indexed like any upload, so
 *                                    the agent can answer it next time
 *
 * `scope` is middleware/departmentKnowledgeScope.js's: the caller may manage this department's
 * knowledge, and every question is looked up within that department.
 */

import { CAPABILITIES, ROLE_CAPABILITIES } from '../../constants/accessRoles.js';
import { HTTP_STATUS } from '../../constants/httpStatus.js';
import { AGENT_CHAT_MESSAGES, NOTIFICATION_MESSAGES } from '../../constants/messages.js';
import { AGENT_CHAT_SETTINGS } from '../../constants/validation.js';
import AgentConversation from '../../models/AgentConversation.js';
import AgentMessage, { AGENT_MESSAGE_ROLES } from '../../models/AgentMessage.js';
import AgentQuestion, { QUESTION_REASONS, QUESTION_STATUSES } from '../../models/AgentQuestion.js';
import EmployeeProfile from '../../models/EmployeeProfile.js';
import { NOTIFICATION_TYPES } from '../../models/Notification.js';
import User, { ACCOUNT_STATUSES } from '../../models/User.js';
import { logger } from '../../utils/logger.js';
import { isDuplicateKeyError } from '../../utils/mongoErrors.js';
import { DOCUMENT_SOURCES } from '../../models/AgentDocument.js';
import { uploadKnowledgeDocument } from '../knowledge/knowledgeBaseService.js';
import { sendMail } from '../mailService.js';
import { notifyUsers } from '../notifications.js';
import { ServiceError } from '../serviceError.js';
import { buildQuestionAnsweredEmail } from './questionAnsweredEmail.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Pages of the web app that notifications and emails link to. The frontend's routes must match
 * (frontend/src/constants/routes.js MY_KNOWLEDGE_DEPARTMENT, KNOWLEDGE_HUB_DEPARTMENT, ASK_AGENTS).
 */
export const AGENT_APP_PATHS = Object.freeze({
  inboxForLead: (departmentId, questionId) => `/knowledge/${departmentId}?tab=questions&question=${questionId}`,
  inboxForAdmin: (departmentId, questionId) => `/admin/knowledge/${departmentId}?tab=questions&question=${questionId}`,
  conversation: (departmentId, conversationId) => `/agents/${departmentId}?conversation=${conversationId}`,
});

const refusal = (httpStatus, code) => new ServiceError(httpStatus, code, AGENT_CHAT_MESSAGES[code]);
const closedExpiry = (closedAt) =>
  new Date(closedAt.getTime() + AGENT_CHAT_SETTINGS.CLOSED_QUESTION_RETENTION_DAYS * DAY_MS);

// Roles that manage every department's knowledge base: the fallback recipients.
const KNOWLEDGE_ADMIN_ROLES = Object.entries(ROLE_CAPABILITIES)
  .filter(([, capabilities]) => capabilities.includes(CAPABILITIES.MANAGE_KNOWLEDGE_BASES))
  .map(([role]) => role);

/** The department's head (their account) and knowledge lead; administrators when it has neither. */
async function inboxRecipients(department, agent) {
  const owners = [];
  if (department.departmentHeadId) {
    const head = await EmployeeProfile.findById(department.departmentHeadId).select('userId').lean();
    if (head?.userId) owners.push({ userId: head.userId.toString(), isAdmin: false });
  }
  if (agent.managedBy) owners.push({ userId: agent.managedBy.toString(), isAdmin: false });
  if (owners.length > 0) return owners;
  const admins = await User.find({ role: { $in: KNOWLEDGE_ADMIN_ROLES }, status: ACCOUNT_STATUSES.ACTIVE })
    .select('_id')
    .lean();
  return admins.map((admin) => ({ userId: admin._id.toString(), isAdmin: true }));
}

/**
 * Files a question in the department's inbox, once per agent answer, and links the answer to it.
 * @returns {Promise<{ question: object, isNew: boolean }>}
 */
export async function escalateQuestion({
  department,
  agent,
  asker,
  conversationId,
  questionText,
  assistantMessage,
  reason,
}) {
  let question;
  let isNew = true;
  try {
    question = await AgentQuestion.create({
      departmentId: department._id,
      agentId: agent._id,
      askedBy: asker.id,
      conversationId,
      assistantMessageId: assistantMessage._id,
      reason,
      question: questionText,
      agentAnswer: assistantMessage.content,
    });
  } catch (createError) {
    if (!isDuplicateKeyError(createError)) throw createError;
    question = await AgentQuestion.findOne({ assistantMessageId: assistantMessage._id });
    isNew = false;
  }
  if (!assistantMessage.questionId) {
    await AgentMessage.updateOne({ _id: assistantMessage._id }, { $set: { questionId: question._id } });
  }
  if (isNew) {
    const recipients = (await inboxRecipients(department, agent)).filter(({ userId }) => userId !== asker.id);
    const body =
      reason === QUESTION_REASONS.DOWNVOTED
        ? NOTIFICATION_MESSAGES.QUESTION_DOWNVOTED_BODY(asker.name, agent.name)
        : NOTIFICATION_MESSAGES.QUESTION_RECEIVED_BODY(asker.name, agent.name);
    const adminIds = new Set(recipients.filter(({ isAdmin }) => isAdmin).map(({ userId }) => userId));
    const departmentId = department._id.toString();
    const questionId = question._id.toString();
    await notifyUsers(
      recipients.map(({ userId }) => userId),
      (userId) => ({
        type: NOTIFICATION_TYPES.AGENT_QUESTION_RECEIVED,
        title: NOTIFICATION_MESSAGES.QUESTION_RECEIVED_TITLE(department.name),
        body,
        link: adminIds.has(userId)
          ? AGENT_APP_PATHS.inboxForAdmin(departmentId, questionId)
          : AGENT_APP_PATHS.inboxForLead(departmentId, questionId),
        data: { departmentId, questionId, reason },
      }),
    );
  }
  return { question, isNew };
}

async function userSummaries(userIds) {
  const ids = [...new Set(userIds.filter(Boolean).map(String))];
  if (ids.length === 0) return new Map();
  const users = await User.find({ _id: { $in: ids } })
    .select('name email')
    .lean();
  return new Map(
    users.map((user) => [user._id.toString(), { id: user._id.toString(), name: user.name, email: user.email }]),
  );
}

function toQuestionSummary(question, users) {
  const person = (userId) =>
    userId ? (users.get(userId.toString()) ?? { id: userId.toString(), name: null, email: null }) : null;
  return {
    id: question._id.toString(),
    status: question.status,
    reason: question.reason,
    question: question.question,
    agentAnswer: question.agentAnswer,
    askedBy: person(question.askedBy),
    answer: question.answer ?? null,
    answeredBy: person(question.answeredBy),
    answeredAt: question.answeredAt ?? null,
    closedAt: question.closedAt ?? null,
    faqDocumentId: question.faqDocumentId?.toString() ?? null,
    createdAt: question.createdAt,
    version: question.__v,
  };
}

async function summarize(questions) {
  const users = await userSummaries(questions.flatMap((question) => [question.askedBy, question.answeredBy]));
  return questions.map((question) => toQuestionSummary(question, users));
}

/** @param {{ status: string|null }} filters */
export async function listDepartmentQuestions({ department }, { status }) {
  const questions = await AgentQuestion.find({ departmentId: department._id, ...(status ? { status } : {}) })
    .sort({ createdAt: -1 })
    .limit(AGENT_CHAT_SETTINGS.QUESTIONS_LISTED)
    .lean();
  const counts = await AgentQuestion.aggregate([
    { $match: { departmentId: department._id } },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);
  const countsByStatus = Object.fromEntries(Object.values(QUESTION_STATUSES).map((value) => [value, 0]));
  for (const { _id, count } of counts) countsByStatus[_id] = count;
  return { questions: await summarize(questions), countsByStatus };
}

async function findQuestion(department, questionId) {
  const question = await AgentQuestion.findOne({ _id: questionId, departmentId: department._id }).lean();
  if (!question) throw refusal(HTTP_STATUS.NOT_FOUND, 'QUESTION_NOT_FOUND');
  return question;
}

/** Closes an OPEN question atomically: two leads answering at once cannot both win. */
async function closeOpenQuestion(department, questionId, changes) {
  await findQuestion(department, questionId);
  const closedAt = new Date();
  const closed = await AgentQuestion.findOneAndUpdate(
    { _id: questionId, departmentId: department._id, status: QUESTION_STATUSES.OPEN },
    { $set: { ...changes, closedAt, expiresAt: closedExpiry(closedAt) }, $inc: { __v: 1 } },
    { new: true },
  ).lean();
  if (!closed) throw refusal(HTTP_STATUS.CONFLICT, 'QUESTION_CLOSED');
  return closed;
}

/** The lead's reply, in the asker's conversation while it still exists. */
async function addReplyToConversation(question, answer, actor) {
  const conversation = await AgentConversation.findById(question.conversationId).lean();
  if (!conversation) return;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + AGENT_CHAT_SETTINGS.RETENTION_DAYS * DAY_MS);
  await AgentMessage.create({
    conversationId: conversation._id,
    userId: conversation.userId,
    departmentId: conversation.departmentId,
    role: AGENT_MESSAGE_ROLES.LEAD,
    content: answer,
    authorId: actor.id,
    questionId: question._id,
    expiresAt,
  });
  await AgentConversation.updateOne({ _id: conversation._id }, { $set: { lastMessageAt: now, expiresAt } });
}

async function tellTheAsker({ department, question, answer, actor, appContext }) {
  const departmentId = department._id.toString();
  const link = AGENT_APP_PATHS.conversation(departmentId, question.conversationId.toString());
  await notifyUsers([question.askedBy], () => ({
    type: NOTIFICATION_TYPES.AGENT_QUESTION_ANSWERED,
    title: NOTIFICATION_MESSAGES.QUESTION_ANSWERED_TITLE(department.name),
    body: NOTIFICATION_MESSAGES.QUESTION_ANSWERED_BODY(actor.name),
    link,
    data: { departmentId, questionId: question._id.toString(), conversationId: question.conversationId.toString() },
  }));
  const asker = await User.findById(question.askedBy).select('name email status').lean();
  if (!asker || asker.status !== ACCOUNT_STATUSES.ACTIVE) return;
  try {
    const email = buildQuestionAnsweredEmail({
      employeeName: asker.name,
      departmentName: department.name,
      leadName: actor.name,
      question: question.question,
      answer,
      companyName: appContext.companyName,
      viewUrl: `${appContext.appPublicUrl}${link}`,
    });
    await sendMail({ to: asker.email, ...email });
  } catch (mailError) {
    logger.warn('Question answer email not sent', { questionId: question._id.toString(), error: mailError.message });
  }
}

/**
 * @param {object} scope
 * @param {string} questionId
 * @param {{ answer: string, saveAsFaq: boolean, faqQuestion: string|null }} input
 * @param {{ id: string, name: string }} actor
 * @param {{ companyName: string, appPublicUrl: string }} appContext
 */
export async function answerQuestion(scope, questionId, { answer, saveAsFaq, faqQuestion }, actor, appContext) {
  const { department } = scope;
  const answered = await closeOpenQuestion(department, questionId, {
    status: QUESTION_STATUSES.ANSWERED,
    answer,
    answeredBy: actor.id,
    answeredAt: new Date(),
    closedBy: actor.id,
  });
  await addReplyToConversation(answered, answer, actor);
  await tellTheAsker({ department, question: answered, answer, actor, appContext });
  let faqDocument = null;
  if (saveAsFaq) faqDocument = await saveQuestionAsFaq(scope, questionId, { faqQuestion }, actor);
  const [summary] = await summarize([await AgentQuestion.findById(answered._id).lean()]);
  return { question: summary, faqDocument };
}

export async function dismissQuestion({ department }, questionId, actor) {
  const dismissed = await closeOpenQuestion(department, questionId, {
    status: QUESTION_STATUSES.DISMISSED,
    closedBy: actor.id,
  });
  const [summary] = await summarize([dismissed]);
  return summary;
}

/** "# <question>\n\n<answer>": the question becomes the heading every chunk of the entry carries. */
function faqMarkdown(questionText, answer) {
  const heading = questionText.replace(/\s+/g, ' ').trim();
  return `# ${heading}\n\n${answer.trim()}\n`;
}

/** @param {{ faqQuestion: string|null }} input  the question as it should read in the FAQ (default: as asked) */
export async function saveQuestionAsFaq(scope, questionId, { faqQuestion }, actor) {
  const question = await findQuestion(scope.department, questionId);
  if (question.status !== QUESTION_STATUSES.ANSWERED) throw refusal(HTTP_STATUS.CONFLICT, 'QUESTION_NOT_ANSWERED');
  if (question.faqDocumentId) throw refusal(HTTP_STATUS.CONFLICT, 'FAQ_ALREADY_SAVED');
  const title = (faqQuestion ?? question.question).slice(0, AGENT_CHAT_SETTINGS.FAQ_QUESTION_MAX_LENGTH);
  const document = await uploadKnowledgeDocument(
    scope,
    { buffer: Buffer.from(faqMarkdown(title, question.answer), 'utf8'), originalname: `FAQ - ${title}.md` },
    actor.id,
    { source: DOCUMENT_SOURCES.FAQ, sourceQuestionId: question._id },
  );
  await AgentQuestion.updateOne({ _id: question._id }, { $set: { faqDocumentId: document.id }, $inc: { __v: 1 } });
  return document;
}
