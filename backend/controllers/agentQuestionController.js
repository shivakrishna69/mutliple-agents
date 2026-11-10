/**
 * A department's Questions Inbox (services/agentChat/agentQuestionService.js), for the people who
 * manage its knowledge: its head, its knowledge lead and administrators. Mounted under
 * /api/departments/:departmentId/agent, behind middleware/departmentKnowledgeScope.js.
 *
 *   GET  /questions?status=OPEN|ANSWERED|DISMISSED   the inbox, newest first, with counts by status
 *   POST /questions/:questionId/answer   { answer, saveAsFaq?, faqQuestion? }: answers the asker
 *                                        (in their conversation, in the app and by email)
 *   POST /questions/:questionId/dismiss  closes it without an answer
 *   POST /questions/:questionId/faq      { faqQuestion? }: saves an answered question as an FAQ entry
 *
 * Every change is audited (category "agent_questions") with ids, never the text.
 */

import { AGENT_CHAT_MESSAGES } from '../constants/messages.js';
import { HTTP_STATUS } from '../constants/httpStatus.js';
import { loadEmailContext } from '../services/companySettings.js';
import {
  answerQuestion,
  dismissQuestion,
  listDepartmentQuestions,
  saveQuestionAsFaq,
} from '../services/agentChat/agentQuestionService.js';
import {
  validateFaqRequest,
  validateQuestionAnswer,
  validateQuestionListQuery,
} from '../validators/agentChatValidators.js';
import { createWorkforceHandlerFactory, idParamErrors } from './workforceHandler.js';

const questionHandler = createWorkforceHandlerFactory({
  auditCategory: 'agent_questions',
  restrictedMessage: AGENT_CHAT_MESSAGES.ASK_DENIED,
  inputInvalidMessage: AGENT_CHAT_MESSAGES.INPUT_INVALID,
});
// Access is decided per department by the knowledge scope middleware, not by role.
const SCOPED_READ = Object.freeze({ isWrite: false });
const SCOPED_WRITE = Object.freeze({ isWrite: true });

const actorOf = (req) => ({ id: req.user.id, name: req.user.name });
const auditScope = (req) => ({
  departmentId: req.knowledgeScope.department._id.toString(),
  accessBasis: req.knowledgeScope.access.basis,
  questionId: req.params.questionId,
});

export const getDepartmentQuestions = questionHandler('list_agent_questions', SCOPED_READ, async (req) => {
  const validation = validateQuestionListQuery(req.query);
  if (!validation.isValid) return { validationErrors: validation.validationErrors };
  return {
    message: AGENT_CHAT_MESSAGES.QUESTIONS_RETRIEVED,
    data: await listDepartmentQuestions(req.knowledgeScope, validation.sanitizedInput),
  };
});

export const postQuestionAnswer = questionHandler('answer_agent_question', SCOPED_WRITE, async (req) => {
  const invalid = idParamErrors(req.params, 'questionId');
  if (invalid) return { validationErrors: invalid };
  const validation = validateQuestionAnswer(req.body);
  if (!validation.isValid) return { validationErrors: validation.validationErrors };
  const result = await answerQuestion(
    req.knowledgeScope,
    req.params.questionId,
    validation.sanitizedInput,
    actorOf(req),
    await loadEmailContext(req.app.locals.config),
  );
  return {
    message: AGENT_CHAT_MESSAGES.QUESTION_ANSWERED,
    data: result,
    auditDetails: { ...auditScope(req), savedAsFaq: Boolean(result.faqDocument) },
  };
});

export const postQuestionDismissal = questionHandler('dismiss_agent_question', SCOPED_WRITE, async (req) => {
  const invalid = idParamErrors(req.params, 'questionId');
  if (invalid) return { validationErrors: invalid };
  return {
    message: AGENT_CHAT_MESSAGES.QUESTION_DISMISSED,
    data: { question: await dismissQuestion(req.knowledgeScope, req.params.questionId, actorOf(req)) },
    auditDetails: auditScope(req),
  };
});

export const postQuestionFaq = questionHandler('save_agent_question_faq', SCOPED_WRITE, async (req) => {
  const invalid = idParamErrors(req.params, 'questionId');
  if (invalid) return { validationErrors: invalid };
  const validation = validateFaqRequest(req.body);
  if (!validation.isValid) return { validationErrors: validation.validationErrors };
  const document = await saveQuestionAsFaq(
    req.knowledgeScope,
    req.params.questionId,
    validation.sanitizedInput,
    actorOf(req),
  );
  return {
    httpStatus: HTTP_STATUS.ACCEPTED,
    message: AGENT_CHAT_MESSAGES.FAQ_SAVED,
    data: { document },
    auditDetails: { ...auditScope(req), documentId: document.id },
  };
});
