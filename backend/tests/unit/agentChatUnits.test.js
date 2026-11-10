/**
 * The parts of department agent chat that need no database: who may ask (agentAudience.js), the
 * ai-service answer stream (knowledgeAnswerClient.js, against a local stand-in server), request
 * validation (validators/agentChatValidators.js) and the answer email's escaping.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { AGENT_CHAT_SETTINGS } from '../../constants/validation.js';
import { askRefusalReason, effectiveAudienceOf } from '../../services/agentChat/agentAudience.js';
import { parseFinalEvent, requestKnowledgeAnswer } from '../../services/agentChat/knowledgeAnswerClient.js';
import { buildQuestionAnsweredEmail } from '../../services/agentChat/questionAnsweredEmail.js';
import { AI_FAILURE_KIND, AiServiceError } from '../../services/aiServiceClient.js';
import {
  validateAgentFeedback,
  validateAgentQuestion,
  validateFaqRequest,
  validateNotificationQuery,
  validateQuestionAnswer,
  validateQuestionListQuery,
} from '../../validators/agentChatValidators.js';

const DEPARTMENT_ID = '65f1a2b3c4d5e6f708192aa1';
const OTHER_DEPARTMENT_ID = '65f1a2b3c4d5e6f708192bb1';
const DOCUMENT_ID = '65f1a2b3c4d5e6f708192a01';

describe('who may ask an agent', () => {
  const department = (isSharedService) => ({ _id: DEPARTMENT_ID, isSharedService });
  const agent = (audience) => ({ audience });
  const member = { profile: { _id: 'p1' }, departmentIds: new Set([DEPARTMENT_ID]) };
  const outsider = { profile: { _id: 'p2' }, departmentIds: new Set([OTHER_DEPARTMENT_ID]) };
  const noRecord = { profile: null, departmentIds: new Set() };

  it('follows the shared-service switch unless the agent overrides it', () => {
    assert.equal(effectiveAudienceOf(department(true), agent('FOLLOW_DEPARTMENT')), 'COMPANY');
    assert.equal(effectiveAudienceOf(department(false), agent('FOLLOW_DEPARTMENT')), 'DEPARTMENT');
    assert.equal(effectiveAudienceOf(department(true), agent('DEPARTMENT')), 'DEPARTMENT');
    assert.equal(effectiveAudienceOf(department(false), agent('COMPANY')), 'COMPANY');
  });

  it('lets members ask a department agent, everyone with a record ask a company one, and managers always', () => {
    const reason = (dept, agentAudience, membership, managesKnowledgeBase = false) =>
      askRefusalReason({ department: dept, agent: agent(agentAudience), membership, managesKnowledgeBase });
    assert.equal(reason(department(false), 'FOLLOW_DEPARTMENT', member), null);
    assert.equal(reason(department(false), 'FOLLOW_DEPARTMENT', outsider), 'ASK_DENIED');
    assert.equal(reason(department(true), 'FOLLOW_DEPARTMENT', outsider), null);
    assert.equal(reason(department(true), 'FOLLOW_DEPARTMENT', noRecord), 'NO_EMPLOYEE_PROFILE');
    assert.equal(reason(department(false), 'DEPARTMENT', noRecord, true), null, 'a manager without a record');
    assert.equal(reason(department(false), 'DEPARTMENT', outsider, true), null);
  });
});

describe('the ai-service answer stream', () => {
  let server;
  let baseUrl;
  /** What the stand-in does with the next request: (request, response) => void */
  let respond;
  const received = [];
  const config = () => ({ aiServiceUrl: baseUrl, aiServiceApiKey: 'k'.repeat(40), aiServiceTimeoutMs: 1_500 });
  const finalEvent = (overrides = {}) => ({
    type: 'final',
    outcome: 'answered',
    answer: 'You get 24 days [1].',
    citations: [
      {
        number: 1,
        document_id: DOCUMENT_ID,
        chunk_index: 2,
        heading_path: ['Leave'],
        page: 4,
        excerpt: 'Everyone gets 24 days.',
        score: 0.81,
      },
    ],
    passages_considered: 3,
    usage: { input_tokens: 120, output_tokens: 30 },
    ...overrides,
  });
  const ndjson = (...events) => events.map((event) => `${JSON.stringify(event)}\n`).join('');
  const ask = (onDelta) =>
    requestKnowledgeAnswer(
      {
        department_id: DEPARTMENT_ID,
        department_name: 'HR',
        agent_name: 'HR Agent',
        agent_instructions: null,
        question: 'Leave?',
        history: [],
      },
      { config: config(), requestId: 'req-1', onDelta },
    );
  const failureOf = async (promise) => {
    try {
      await promise;
    } catch (error) {
      assert.ok(error instanceof AiServiceError, `${error}`);
      return error.failureKind;
    }
    throw new Error('expected a failure');
  };

  before(async () => {
    server = createServer(async (request, response) => {
      const parts = [];
      for await (const part of request) parts.push(part);
      received.push({ headers: request.headers, body: JSON.parse(Buffer.concat(parts).toString('utf8')) });
      respond(request, response);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });

  it('passes each piece on as it arrives, even split across chunks, and returns the final answer', async () => {
    respond = (request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      const body = ndjson({ type: 'delta', text: 'You get ' }, { type: 'delta', text: '24 days [1].' }, finalEvent());
      response.write(body.slice(0, 17));
      setTimeout(() => response.end(body.slice(17)), 20);
    };
    const pieces = [];
    const result = await ask((text) => pieces.push(text));
    assert.deepEqual(pieces, ['You get ', '24 days [1].']);
    assert.equal(result.outcome, 'ANSWERED');
    assert.deepEqual(result.citations, [
      {
        number: 1,
        documentId: DOCUMENT_ID,
        chunkIndex: 2,
        headingPath: ['Leave'],
        page: 4,
        excerpt: 'Everyone gets 24 days.',
        score: 0.81,
      },
    ]);
    assert.deepEqual(result.usage, { inputTokens: 120, outputTokens: 30 });
    assert.equal(result.passagesConsidered, 3);
    const { headers, body } = received.at(-1);
    assert.equal(headers['x-internal-api-key'], 'k'.repeat(40));
    assert.equal(headers['x-request-id'], 'req-1');
    assert.equal(body.stream, true);
  });

  it('turns failures into AiServiceError kinds', async () => {
    respond = (request, response) => {
      response.writeHead(503, { 'Content-Type': 'application/json' });
      response.end('{}');
    };
    assert.equal(await failureOf(ask()), AI_FAILURE_KIND.ERROR_RESPONSE);

    respond = (request, response) => {
      response.writeHead(200);
      response.end(ndjson({ type: 'delta', text: 'Part' }, { type: 'error', code: 'timeout', message: 'slow' }));
    };
    assert.equal(await failureOf(ask()), AI_FAILURE_KIND.ERROR_RESPONSE);

    respond = (request, response) => {
      response.writeHead(200);
      response.end(ndjson({ type: 'delta', text: 'Only a part' }));
    };
    assert.equal(await failureOf(ask()), AI_FAILURE_KIND.INVALID_RESPONSE, 'no final event');

    respond = (request, response) => {
      response.writeHead(200);
      response.end('not json\n');
    };
    assert.equal(await failureOf(ask()), AI_FAILURE_KIND.INVALID_RESPONSE);

    respond = (request, response) => {
      response.writeHead(200);
      response.write(ndjson({ type: 'delta', text: 'Thinking' }));
    };
    assert.equal(await failureOf(ask()), AI_FAILURE_KIND.TIMEOUT, 'a stream that never finishes');

    const unreachable = requestKnowledgeAnswer(
      {
        department_id: DEPARTMENT_ID,
        department_name: 'HR',
        agent_name: 'A',
        agent_instructions: null,
        question: 'Q',
        history: [],
      },
      { config: { ...config(), aiServiceUrl: 'http://127.0.0.1:1' }, requestId: 'req-2' },
    );
    assert.equal(await failureOf(unreachable), AI_FAILURE_KIND.UNAVAILABLE);
  });

  it('checks the final event against the contract', () => {
    assert.equal(parseFinalEvent(finalEvent({ outcome: 'not_found', citations: [] })).outcome, 'NOT_FOUND');
    assert.equal(parseFinalEvent(finalEvent({ usage: null })).usage, null);
    for (const broken of [
      { outcome: 'maybe' },
      { answer: '   ' },
      { citations: 'none' },
      { citations: [] },
      { passages_considered: -1 },
      { usage: { input_tokens: 'many' } },
      { citations: [{ ...finalEvent().citations[0], document_id: 'abc' }] },
      { citations: [{ ...finalEvent().citations[0], number: 0 }] },
      { citations: [{ ...finalEvent().citations[0], excerpt: '' }] },
    ]) {
      assert.throws(() => parseFinalEvent(finalEvent(broken)), AiServiceError, JSON.stringify(broken));
    }
  });
});

describe('agent chat requests', () => {
  it('validates a question', () => {
    assert.deepEqual(validateAgentQuestion({ question: '  Leave?  ' }).sanitizedInput, {
      question: 'Leave?',
      conversationId: null,
      stream: false,
    });
    assert.equal(
      validateAgentQuestion({ question: 'Hi', conversationId: DOCUMENT_ID.toUpperCase(), stream: true }).sanitizedInput
        .conversationId,
      DOCUMENT_ID,
    );
    for (const body of [
      null,
      [],
      {},
      { question: '' },
      { question: 42 },
      { question: 'q'.repeat(AGENT_CHAT_SETTINGS.QUESTION_MAX_LENGTH + 1) },
      { question: 'Hi', conversationId: 'abc' },
      { question: 'Hi', stream: 'yes' },
      { question: 'Hi', $where: '1' },
    ]) {
      assert.equal(validateAgentQuestion(body).isValid, false, JSON.stringify(body));
    }
  });

  it('validates feedback, answers, FAQ requests and list filters', () => {
    assert.ok(validateAgentFeedback({ messageId: DOCUMENT_ID, rating: 'DOWN', comment: ' Wrong ' }).isValid);
    assert.equal(
      validateAgentFeedback({ messageId: DOCUMENT_ID, rating: 'DOWN', comment: ' Wrong ' }).sanitizedInput.comment,
      'Wrong',
    );
    assert.equal(validateAgentFeedback({ messageId: DOCUMENT_ID, rating: 'up' }).isValid, false);
    assert.equal(validateAgentFeedback({ messageId: { $ne: null }, rating: 'UP' }).isValid, false);
    assert.deepEqual(validateQuestionAnswer({ answer: ' Twelve weeks. ' }).sanitizedInput, {
      answer: 'Twelve weeks.',
      saveAsFaq: false,
      faqQuestion: null,
    });
    assert.equal(validateQuestionAnswer({ answer: '' }).isValid, false);
    assert.equal(validateQuestionAnswer({ answer: 'Yes', saveAsFaq: 'true' }).isValid, false);
    assert.equal(
      validateQuestionAnswer({ answer: 'a'.repeat(AGENT_CHAT_SETTINGS.LEAD_ANSWER_MAX_LENGTH + 1) }).isValid,
      false,
    );
    assert.ok(validateFaqRequest(undefined).isValid);
    assert.equal(
      validateFaqRequest({ faqQuestion: 'q'.repeat(AGENT_CHAT_SETTINGS.FAQ_QUESTION_MAX_LENGTH + 1) }).isValid,
      false,
    );
    assert.deepEqual(validateQuestionListQuery({}).sanitizedInput, { status: null });
    assert.equal(validateQuestionListQuery({ status: 'open' }).isValid, false);
    assert.deepEqual(validateNotificationQuery({ unread: 'true' }).sanitizedInput, { unreadOnly: true });
    assert.equal(validateNotificationQuery({ unread: '1' }).isValid, false);
  });
});

describe('the answer email', () => {
  it('escapes everything the people involved wrote', () => {
    const email = buildQuestionAnsweredEmail({
      employeeName: 'Mira <b>',
      departmentName: 'HR & People',
      leadName: 'Lalit',
      question: 'Is <script>alert(1)</script> allowed?',
      answer: 'No.',
      companyName: 'Acme',
      viewUrl: 'https://app.example.com/agents/x',
    });
    assert.equal(email.subject, 'HR & People answered your question');
    assert.ok(!email.html.includes('<script>'));
    assert.ok(email.html.includes('&lt;script&gt;'));
    assert.ok(email.html.includes('Mira &lt;b&gt;'));
    assert.ok(email.text.includes('Is <script>alert(1)</script> allowed?'), 'the plain text is not HTML');
  });
});
