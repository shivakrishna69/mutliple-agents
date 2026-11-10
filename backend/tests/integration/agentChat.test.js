/**
 * Department agents answering employees, end to end on a real server, with a stand-in for the AI
 * service (scripted answers, streamed like the real one): the shared-service switch and each agent's
 * audience, which agents a person may ask, asking (JSON and streamed), conversations, the daily quota,
 * feedback, unanswered and downvoted questions reaching the department's Questions Inbox, the lead
 * answering (in the conversation, in the app, by email), FAQ entries, and notifications.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { io } from 'socket.io-client';

import { AGENT_CHAT_MESSAGES } from '../../constants/messages.js';
import { AGENT_CHAT_SETTINGS } from '../../constants/validation.js';
import { insertDepartment, onboardEmployee } from './fixtures.js';
import { startStandInKnowledgeIndex } from './standInKnowledgeIndex.js';
import { TEST_APP_ORIGIN, createSignedInClient, mongoUnavailableReason, startTestServer } from './testServer.js';

const mongoReason = await mongoUnavailableReason();
const API_KEY = randomBytes(32).toString('hex');
const POLL_INTERVAL_MS = 100;
const WAIT_LIMIT_MS = 30_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DAILY_LIMIT = 50;

const agentPath = (departmentId) => `/api/departments/${departmentId}/agent`;
const markdown = (title, text) => Buffer.from(`# ${title}\n\n${text}\n`, 'utf8');
const eventsOf = (text) =>
  text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));

describe('department agents answering employees', { skip: mongoReason ?? false }, () => {
  let index;
  let testServer;
  let admin;
  let hr;
  let customer;
  let engineering;
  let platform;
  let people;
  let finance;
  let legal;
  let engHead;
  let engLead;
  let engMember;
  let platformMember;
  let peopleHead;
  let financeMember;
  let leaver;
  let engDocumentId;
  let peopleDocumentId;

  const asId = (id) => new testServer.database.base.Types.ObjectId(id);
  const collection = (name) => testServer.database.collection(name);
  const ask = (client, departmentId, body) => client.post(`${agentPath(departmentId)}/chat`, body);
  const citationOf = (documentId, overrides = {}) => ({
    number: 1,
    document_id: documentId,
    chunk_index: 0,
    heading_path: ['Policy'],
    page: null,
    excerpt: 'Everyone gets 24 days of leave a year.',
    score: 0.88,
    ...overrides,
  });
  const answered = (documentId, answer = 'You get 24 days of leave a year [1].') => ({
    outcome: 'answered',
    answer,
    citations: [citationOf(documentId)],
    deltas: ['You get ', '24 days ', 'of leave a year [1].'],
  });
  const notificationsOf = async (client) => (await client.get('/api/notifications')).body.data;

  async function waitForReady(client, departmentId, documentId) {
    const deadline = Date.now() + WAIT_LIMIT_MS;
    for (;;) {
      const { documents } = (await client.get(`${agentPath(departmentId)}/documents`)).body.data;
      const document = documents.find((candidate) => candidate.id === documentId);
      if (document?.status === 'READY') return document;
      if (Date.now() > deadline) throw new Error(`document ${documentId} is ${document?.status}`);
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }

  async function uploadReady(client, departmentId, fileName, content) {
    const response = await client.upload(`${agentPath(departmentId)}/documents`, {
      fileName,
      content,
      contentType: 'text/markdown',
    });
    assert.equal(response.status, 202, JSON.stringify(response.body));
    await waitForReady(client, departmentId, response.body.data.document.id);
    return response.body.data.document.id;
  }

  before(async () => {
    index = await startStandInKnowledgeIndex({ apiKey: API_KEY });
    testServer = await startTestServer({
      aiServiceUrl: index.url,
      environment: { AI_SERVICE_API_KEY: API_KEY, LOG_LEVEL: 'warn', AGENT_DAILY_QUESTION_LIMIT: String(DAILY_LIMIT) },
    });
    admin = await createSignedInClient(testServer, {
      name: 'Ada Admin',
      email: 'ada.admin@example.com',
      role: 'admin',
    });
    hr = await createSignedInClient(testServer, { name: 'Hari HR', email: 'hari.hr@example.com', role: 'hr' });
    customer = await createSignedInClient(testServer, { name: 'Cleo NoRecord', email: 'cleo@example.com' });
    engineering = await insertDepartment(testServer.database, {
      name: 'Engineering',
      code: 'ENG',
      budgetCode: 'CC-100',
    });
    platform = await insertDepartment(testServer.database, { name: 'Platform', code: 'PLT', budgetCode: 'CC-110' });
    people = await insertDepartment(testServer.database, { name: 'People', code: 'PPL', budgetCode: 'CC-200' });
    finance = await insertDepartment(testServer.database, { name: 'Finance', code: 'FIN', budgetCode: 'CC-300' });
    legal = await insertDepartment(testServer.database, { name: 'Legal', code: 'LEG', budgetCode: 'CC-400' });
    await collection('departments').updateOne(
      { _id: asId(platform) },
      { $set: { parentDepartmentId: asId(engineering) } },
    );
    const onboard = (email, name, departmentId) =>
      onboardEmployee({ testServer, hrClient: hr, email, name, departmentId });
    engHead = await onboard('esha.head@example.com', 'Esha Head', engineering);
    engLead = await onboard('lalit.lead@example.com', 'Lalit Lead', engineering);
    engMember = await onboard('mira.member@example.com', 'Mira Member', engineering);
    platformMember = await onboard('paul.platform@example.com', 'Paul Platform', platform);
    peopleHead = await onboard('priya.people@example.com', 'Priya People', people);
    financeMember = await onboard('fred.finance@example.com', 'Fred Finance', finance);
    leaver = await onboard('lena.leaver@example.com', 'Lena Leaver', engineering);
    await collection('departments').updateOne(
      { _id: asId(engineering) },
      { $set: { departmentHeadId: asId(engHead.profileId) } },
    );
    await collection('departments').updateOne(
      { _id: asId(people) },
      { $set: { departmentHeadId: asId(peopleHead.profileId) } },
    );
    await collection('employeeprofiles').updateOne(
      { _id: asId(leaver.profileId) },
      { $set: { 'organizationData.employmentStatus': 'Terminated' } },
    );

    // Engineering's head opens its agent, names a lead and adds a document; People's head too.
    const engSettings = (await engHead.client.get(`${agentPath(engineering)}/settings`)).body.data.settings;
    const withLead = await engHead.client.patch(`${agentPath(engineering)}/settings`, {
      managedBy: engLead.userId,
      systemPrompt: 'Answer briefly.',
      version: engSettings.version ?? 0,
    });
    assert.equal(withLead.status, 200, JSON.stringify(withLead.body));
    engDocumentId = await uploadReady(
      engHead.client,
      engineering,
      'Leave.md',
      markdown('Leave', 'Everyone gets 24 days.'),
    );
    await peopleHead.client.get(`${agentPath(people)}/settings`);
    peopleDocumentId = await uploadReady(
      peopleHead.client,
      people,
      'Benefits.md',
      markdown('Benefits', 'Health cover.'),
    );
    // Finance's agent exists but has nothing to answer from.
    await admin.get(`${agentPath(finance)}/settings`);
  });

  after(async () => {
    await testServer?.stop();
    await index?.stop();
  });

  it('marks a department as a shared service, and each agent follows it unless its audience overrides it', async () => {
    const department = (await hr.get(`/api/departments/${people}`)).body.data.department;
    assert.equal(department.isSharedService, false);
    const shared = await hr.patch(`/api/departments/${people}`, { isSharedService: true, version: department.version });
    assert.equal(shared.status, 200, JSON.stringify(shared.body));
    assert.equal(shared.body.data.department.isSharedService, true);
    assert.equal((await hr.patch(`/api/departments/${people}`, { isSharedService: 'yes', version: 1 })).status, 400);

    const peopleSettings = (await peopleHead.client.get(`${agentPath(people)}/settings`)).body.data.settings;
    assert.equal(peopleSettings.audience, 'FOLLOW_DEPARTMENT');
    assert.equal(peopleSettings.effectiveAudience, 'COMPANY');
    let engSettings = (await engLead.client.get(`${agentPath(engineering)}/settings`)).body.data.settings;
    assert.equal(engSettings.effectiveAudience, 'DEPARTMENT');

    const toCompany = await engLead.client.patch(`${agentPath(engineering)}/settings`, {
      audience: 'COMPANY',
      version: engSettings.version,
    });
    assert.equal(toCompany.body.data.settings.effectiveAudience, 'COMPANY');
    engSettings = toCompany.body.data.settings;
    const back = await engLead.client.patch(`${agentPath(engineering)}/settings`, {
      audience: 'FOLLOW_DEPARTMENT',
      version: engSettings.version,
    });
    assert.equal(back.body.data.settings.effectiveAudience, 'DEPARTMENT');
    const invalid = await engLead.client.patch(`${agentPath(engineering)}/settings`, {
      audience: 'EVERYONE',
      version: 0,
    });
    assert.equal(invalid.status, 400);
  });

  it("lists the agents a person may ask: their department's (sub-units included) and shared services'", async () => {
    const namesFor = async (client) => {
      const response = await client.get('/api/departments/agents/available');
      assert.equal(response.status, 200, JSON.stringify(response.body));
      return response.body.data.agents.map((entry) => entry.department.name);
    };
    assert.deepEqual(await namesFor(engMember.client), ['Engineering', 'People']);
    assert.deepEqual(await namesFor(platformMember.client), ['Engineering', 'People']);
    assert.deepEqual(await namesFor(financeMember.client), ['People'], "Finance's agent has nothing ready");
    assert.deepEqual(await namesFor(leaver.client), []);
    assert.deepEqual(await namesFor(customer), [], 'no employee record');
    assert.deepEqual(await namesFor(admin), ['Engineering', 'People'], 'administrators manage every agent');
    const [entry] = (await engMember.client.get('/api/departments/agents/available')).body.data.agents;
    assert.equal(entry.audience, 'DEPARTMENT');
    assert.equal(entry.readyDocuments, 1);

    const settings = (await peopleHead.client.get(`${agentPath(people)}/settings`)).body.data.settings;
    const paused = await peopleHead.client.patch(`${agentPath(people)}/settings`, {
      status: 'PAUSED',
      version: settings.version,
    });
    assert.deepEqual(await namesFor(financeMember.client), [], 'a paused agent answers nobody');
    const askPaused = await ask(financeMember.client, people, { question: 'Is health cover included?' });
    assert.equal(askPaused.status, 409, 'nor can it be asked directly');
    assert.equal(askPaused.body.error.code, 'AGENT_UNAVAILABLE');
    await peopleHead.client.patch(`${agentPath(people)}/settings`, {
      status: 'ACTIVE',
      version: paused.body.data.settings.version,
    });
  });

  it('refuses questions from outside the audience, without a record, or to an agent that cannot answer', async () => {
    const codeOf = async (client, departmentId, body = { question: 'Hello?' }) => {
      const response = await ask(client, departmentId, body);
      return [response.status, response.body.error?.code ?? null];
    };
    assert.deepEqual(await codeOf(financeMember.client, engineering), [403, 'ASK_DENIED']);
    assert.deepEqual(await codeOf(customer, people), [403, 'NO_EMPLOYEE_PROFILE']);
    assert.deepEqual(await codeOf(leaver.client, engineering), [403, 'NO_EMPLOYEE_PROFILE']);
    // Spread over several people: questions are rate limited per person, refused ones included.
    assert.deepEqual(await codeOf(platformMember.client, legal), [409, 'AGENT_UNAVAILABLE']);
    assert.deepEqual(await codeOf(platformMember.client, finance), [403, 'ASK_DENIED']);
    assert.deepEqual(await codeOf(admin, finance), [409, 'AGENT_NOT_READY']);
    assert.equal((await ask(admin, 'not-an-id', { question: 'Hi' })).status, 400);
    assert.equal((await ask(admin, engineering, { question: '   ' })).status, 400);
    assert.equal((await ask(admin, engineering, { question: 'Hi', extra: 1 })).status, 400);
    assert.equal(
      (await ask(admin, engineering, { question: 'q'.repeat(AGENT_CHAT_SETTINGS.QUESTION_MAX_LENGTH + 1) })).status,
      400,
    );
    assert.equal(index.answerRequests().length, 0, 'the AI service was never asked');
  });

  let conversationId;

  it('answers from the knowledge base with its cited passages, and continues the conversation with its history', async () => {
    index.scriptAnswer(answered(engDocumentId));
    const first = await ask(engMember.client, engineering, { question: 'How much leave do I get?' });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const { conversation, userMessage, message, question } = first.body.data;
    conversationId = conversation.id;
    assert.equal(conversation.title, 'How much leave do I get?');
    assert.equal(userMessage.role, 'USER');
    assert.equal(message.role, 'ASSISTANT');
    assert.equal(message.outcome, 'ANSWERED');
    assert.equal(message.content, 'You get 24 days of leave a year [1].');
    assert.deepEqual(message.citations, [
      {
        number: 1,
        documentId: engDocumentId,
        documentName: 'Leave.md',
        headingPath: ['Policy'],
        page: null,
        excerpt: 'Everyone gets 24 days of leave a year.',
      },
    ]);
    assert.equal(question, null);
    const [sent] = index.answerRequests();
    assert.equal(sent.department_id, engineering);
    assert.equal(sent.department_name, 'Engineering');
    assert.equal(sent.agent_name, 'Engineering Department Agent');
    assert.equal(sent.agent_instructions, 'Answer briefly.');
    assert.equal(sent.question, 'How much leave do I get?');
    assert.deepEqual(sent.history, []);
    assert.equal(sent.stream, true);

    index.scriptAnswer(answered(engDocumentId, 'Yes, up to 30 days carry over [1].'));
    const second = await ask(engMember.client, engineering, { question: 'Does it carry over?', conversationId });
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.equal(second.body.data.conversation.id, conversationId);
    assert.deepEqual(index.answerRequests().at(-1).history, [
      { role: 'user', content: 'How much leave do I get?' },
      { role: 'assistant', content: 'You get 24 days of leave a year [1].' },
    ]);

    const stranger = await ask(platformMember.client, engineering, { question: 'Hi', conversationId });
    assert.equal(stranger.status, 404, "another person's conversation cannot be continued");
    assert.equal(stranger.body.error.code, 'CONVERSATION_NOT_FOUND');

    const stored = await collection('agentmessages').findOne({ _id: asId(message.id) });
    const retention = stored.expiresAt.getTime() - stored.createdAt.getTime();
    assert.ok(Math.abs(retention - AGENT_CHAT_SETTINGS.RETENTION_DAYS * DAY_MS) < 60_000, 'kept for 90 days');
    const usage = await collection('agentchatusages').findOne({ userId: asId(engMember.userId) });
    assert.equal(usage.questions, 2);
    assert.equal(usage.inputTokens, 200);
  });

  it('streams the answer as it is written, then the stored answer', async () => {
    index.scriptAnswer(answered(engDocumentId));
    const response = await engMember.client.postForText(`${agentPath(engineering)}/chat`, {
      question: 'Leave days?',
      stream: true,
    });
    assert.equal(response.status, 200, response.text);
    assert.match(response.contentType, /application\/x-ndjson/);
    const events = eventsOf(response.text);
    assert.equal(events[0].type, 'started');
    assert.equal(events[0].userMessage.content, 'Leave days?');
    const deltas = events.filter((event) => event.type === 'delta').map((event) => event.text);
    assert.equal(deltas.join(''), 'You get 24 days of leave a year [1].');
    const final = events.at(-1);
    assert.equal(final.type, 'final');
    assert.equal(final.message.content, 'You get 24 days of leave a year [1].');
    assert.equal(final.message.citations[0].documentName, 'Leave.md');
  });

  let unansweredQuestionId;

  it('sends an unanswered question to the department at once, and tells its head and lead', async () => {
    // The head has the app open: the notification arrives on their socket as it is stored.
    const headSocket = io(testServer.baseUrl, {
      path: '/socket.io',
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      extraHeaders: { Origin: TEST_APP_ORIGIN, Cookie: engHead.client.cookieHeader() },
    });
    await new Promise((resolve, reject) => {
      headSocket.once('connect', resolve);
      headSocket.once('connect_error', reject);
    });
    const pushed = new Promise((resolve) => headSocket.once('NOTIFICATION_CREATED', resolve));

    index.scriptAnswer({ outcome: 'not_found', answer: 'Not in the documents.', citations: [] });
    const response = await ask(engMember.client, engineering, { question: 'What is the adoption leave policy?' });
    const pushedNotification = await pushed;
    headSocket.disconnect();
    assert.equal(pushedNotification.type, 'AGENT_QUESTION_RECEIVED');
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const { message, question } = response.body.data;
    assert.equal(message.outcome, 'NOT_FOUND');
    assert.equal(message.content, AGENT_CHAT_MESSAGES.REPLY_NOT_FOUND('Engineering'));
    assert.deepEqual(message.citations, []);
    assert.equal(question.status, 'OPEN');
    assert.deepEqual(message.question, { id: question.id, status: 'OPEN' });
    unansweredQuestionId = question.id;

    for (const owner of [engHead, engLead]) {
      const { notifications, unreadCount } = await notificationsOf(owner.client);
      assert.ok(unreadCount >= 1);
      const [latest] = notifications;
      assert.equal(latest.type, 'AGENT_QUESTION_RECEIVED');
      assert.equal(latest.title, 'New question for Engineering');
      assert.match(latest.body, /Mira Member asked Engineering Department Agent/);
      assert.equal(latest.link, `/knowledge/${engineering}?tab=questions&question=${question.id}`);
    }
    assert.equal(
      (await notificationsOf(engMember.client)).unreadCount,
      0,
      'the asker is not notified of their own question',
    );
  });

  it('keeps nothing of a question the AI service could not answer, and gives the quota back', async () => {
    const before = await collection('agentmessages').countDocuments();
    const usageBefore = (await collection('agentchatusages').findOne({ userId: asId(engMember.userId) })).questions;
    index.scriptAnswer({ status: 503 });
    const refused = await ask(engMember.client, engineering, { question: 'Anything?' });
    assert.equal(refused.status, 503);
    assert.equal(refused.body.error.code, 'AI_UNAVAILABLE');

    index.scriptAnswer({ deltas: ['Partial '], errorCode: 'timeout' });
    const streamed = await engMember.client.postForText(`${agentPath(engineering)}/chat`, {
      question: 'Anything else?',
      stream: true,
    });
    const events = eventsOf(streamed.text);
    assert.deepEqual(
      events.map((event) => event.type),
      ['started', 'delta', 'error'],
    );
    assert.equal(events.at(-1).code, 'AI_UNAVAILABLE');
    assert.equal(events.at(-1).message, AGENT_CHAT_MESSAGES.AI_UNAVAILABLE);

    assert.equal(await collection('agentmessages').countDocuments(), before);
    const usageAfter = (await collection('agentchatusages').findOne({ userId: asId(engMember.userId) })).questions;
    assert.equal(usageAfter, usageBefore);
  });

  it('stops at the daily limit', async () => {
    const day = new Date().toISOString().slice(0, 10);
    await collection('agentchatusages').updateOne(
      { userId: asId(platformMember.userId), day },
      { $set: { questions: DAILY_LIMIT, expiresAt: new Date(Date.now() + 7 * DAY_MS) } },
      { upsert: true },
    );
    const response = await ask(platformMember.client, engineering, { question: 'One more?' });
    assert.equal(response.status, 429);
    assert.equal(response.body.error.code, 'DAILY_LIMIT_REACHED');
    assert.equal(response.body.error.message, AGENT_CHAT_MESSAGES.DAILY_LIMIT_REACHED(DAILY_LIMIT));
    await collection('agentchatusages').deleteOne({ userId: asId(platformMember.userId), day });
  });

  let downvotedQuestionId;

  it('takes feedback on answers, and sends a downvoted one to the department', async () => {
    const { messages } = (await engMember.client.get(`${agentPath(engineering)}/conversations/${conversationId}`)).body
      .data;
    const [firstAnswer, secondAnswer] = messages.filter((message) => message.role === 'ASSISTANT');

    const up = await engMember.client.post(`${agentPath(engineering)}/feedback`, {
      messageId: firstAnswer.id,
      rating: 'UP',
    });
    assert.equal(up.status, 200, JSON.stringify(up.body));
    assert.equal(up.body.data.escalated, false);
    assert.deepEqual(up.body.data.message.feedback, { rating: 'UP', comment: null });

    const down = await engMember.client.post(`${agentPath(engineering)}/feedback`, {
      messageId: secondAnswer.id,
      rating: 'DOWN',
      comment: 'Our contract says 15 days.',
    });
    assert.equal(down.status, 200, JSON.stringify(down.body));
    assert.equal(down.body.data.escalated, true);
    assert.equal(down.body.message, AGENT_CHAT_MESSAGES.FEEDBACK_ESCALATED);
    downvotedQuestionId = down.body.data.message.question.id;
    const stored = await collection('agentquestions').findOne({ _id: asId(downvotedQuestionId) });
    assert.equal(stored.reason, 'DOWNVOTED');
    assert.equal(stored.question, 'Does it carry over?');
    const [latest] = (await notificationsOf(engLead.client)).notifications;
    assert.match(latest.body, /found an answer from Engineering Department Agent unhelpful/);

    const again = await engMember.client.post(`${agentPath(engineering)}/feedback`, {
      messageId: secondAnswer.id,
      rating: 'DOWN',
    });
    assert.equal(again.body.data.escalated, false, 'one question per answer');
    assert.equal(await collection('agentquestions').countDocuments({ assistantMessageId: asId(secondAnswer.id) }), 1);

    const notMine = await platformMember.client.post(`${agentPath(engineering)}/feedback`, {
      messageId: firstAnswer.id,
      rating: 'DOWN',
    });
    assert.equal(notMine.status, 404);
    assert.equal(
      (await engMember.client.post(`${agentPath(engineering)}/feedback`, { messageId: firstAnswer.id, rating: 'MEH' }))
        .status,
      400,
    );
  });

  it("keeps the Questions Inbox to the department's head, lead and administrators", async () => {
    assert.equal((await engMember.client.get(`${agentPath(engineering)}/questions`)).status, 403);
    assert.equal((await peopleHead.client.get(`${agentPath(engineering)}/questions`)).status, 403);
    assert.equal((await hr.get(`${agentPath(engineering)}/questions`)).status, 403);
    const listed = await engHead.client.get(`${agentPath(engineering)}/questions?status=OPEN`);
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    const { questions, countsByStatus } = listed.body.data;
    assert.deepEqual(
      questions.map((question) => question.id),
      [downvotedQuestionId, unansweredQuestionId],
    );
    assert.deepEqual(countsByStatus, { OPEN: 2, ANSWERED: 0, DISMISSED: 0 });
    assert.equal(questions[1].askedBy.name, 'Mira Member');
    assert.equal(questions[1].reason, 'UNANSWERED');
    assert.equal((await admin.get(`${agentPath(engineering)}/questions`)).status, 200);
    assert.equal((await engHead.client.get(`${agentPath(engineering)}/questions?status=LATER`)).status, 400);
    assert.equal(
      (await peopleHead.client.post(`${agentPath(people)}/questions/${unansweredQuestionId}/dismiss`)).status,
      404,
      "another department's question",
    );
  });

  it('answers the asker in their conversation, in the app and by email, and saves the answer as an FAQ', async () => {
    const answer = 'Adoption leave is 12 weeks, paid in full.';
    const response = await engLead.client.post(`${agentPath(engineering)}/questions/${unansweredQuestionId}/answer`, {
      answer,
      saveAsFaq: true,
      faqQuestion: 'How long is adoption leave?',
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const { question, faqDocument } = response.body.data;
    assert.equal(question.status, 'ANSWERED');
    assert.equal(question.answer, answer);
    assert.equal(question.answeredBy.name, 'Lalit Lead');
    assert.equal(question.faqDocumentId, faqDocument.id);
    assert.equal(faqDocument.source, 'FAQ');
    assert.equal(
      faqDocument.originalName,
      'FAQ - How long is adoption leave.md',
      'characters unsafe in a file name dropped',
    );
    await waitForReady(engLead.client, engineering, faqDocument.id);
    const indexed = [...index.chunksOf(faqDocument.id).values()];
    assert.deepEqual(indexed[0].heading_path, ['How long is adoption leave?']);

    const stored = await collection('agentquestions').findOne({ _id: asId(unansweredQuestionId) });
    const kept = stored.expiresAt.getTime() - stored.closedAt.getTime();
    assert.ok(Math.abs(kept - AGENT_CHAT_SETTINGS.CLOSED_QUESTION_RETENTION_DAYS * DAY_MS) < 60_000);

    const { notifications } = await notificationsOf(engMember.client);
    const [reply] = notifications;
    assert.equal(reply.type, 'AGENT_QUESTION_ANSWERED');
    assert.equal(reply.title, 'Engineering answered your question');
    assert.match(reply.link, new RegExp(`^/agents/${engineering}\\?conversation=`));

    // Her first email was the invitation.
    const email = (await testServer.mailbox.waitForMessages('mira.member@example.com', 2)).at(-1);
    assert.equal(email.subject, 'Engineering answered your question');
    assert.ok(email.text.includes(answer));
    assert.ok(email.text.includes('What is the adoption leave policy?'));

    const conversations = (await engMember.client.get(`${agentPath(engineering)}/conversations`)).body.data
      .conversations;
    const withReply = conversations.find((conversation) => conversation.title.startsWith('What is the adoption'));
    const { messages } = (await engMember.client.get(`${agentPath(engineering)}/conversations/${withReply.id}`)).body
      .data;
    const lead = messages.at(-1);
    assert.equal(lead.role, 'LEAD');
    assert.equal(lead.content, answer);
    assert.equal(lead.author.name, 'Lalit Lead');
    const escalatedAnswer = messages.find((message) => message.role === 'ASSISTANT');
    assert.deepEqual(escalatedAnswer.question, { id: unansweredQuestionId, status: 'ANSWERED' });

    const twice = await engHead.client.post(`${agentPath(engineering)}/questions/${unansweredQuestionId}/answer`, {
      answer: 'Another answer',
    });
    assert.equal(twice.status, 409);
    assert.equal(twice.body.error.code, 'QUESTION_CLOSED');
    const faqAgain = await engHead.client.post(`${agentPath(engineering)}/questions/${unansweredQuestionId}/faq`, {});
    assert.equal(faqAgain.body.error.code, 'FAQ_ALREADY_SAVED');
  });

  it('closes a question without an answer, which cannot then become an FAQ', async () => {
    const dismissed = await engHead.client.post(`${agentPath(engineering)}/questions/${downvotedQuestionId}/dismiss`);
    assert.equal(dismissed.status, 200, JSON.stringify(dismissed.body));
    assert.equal(dismissed.body.data.question.status, 'DISMISSED');
    const faq = await engHead.client.post(`${agentPath(engineering)}/questions/${downvotedQuestionId}/faq`, {});
    assert.equal(faq.status, 409);
    assert.equal(faq.body.error.code, 'QUESTION_NOT_ANSWERED');
    const { countsByStatus } = (await engHead.client.get(`${agentPath(engineering)}/questions`)).body.data;
    assert.deepEqual(countsByStatus, { OPEN: 0, ANSWERED: 1, DISMISSED: 1 });
  });

  it("marks one's own notifications as read, never someone else's", async () => {
    const { notifications, unreadCount } = await notificationsOf(engMember.client);
    assert.ok(unreadCount >= 1);
    const read = await engMember.client.post(`/api/notifications/${notifications[0].id}/read`);
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.ok(read.body.data.notification.readAt);
    assert.equal((await engHead.client.post(`/api/notifications/${notifications[0].id}/read`)).status, 404);
    const unread = (await engHead.client.get('/api/notifications?unread=true')).body.data;
    assert.ok(unread.notifications.every((notification) => notification.readAt === null));
    const all = await engHead.client.post('/api/notifications/read-all');
    assert.ok(all.body.data.marked >= 1);
    assert.equal((await notificationsOf(engHead.client)).unreadCount, 0);
    assert.equal((await engHead.client.get('/api/notifications?unread=maybe')).status, 400);
  });

  it('lets people delete one conversation or all of theirs, and see only their own', async () => {
    assert.equal(
      (await platformMember.client.get(`${agentPath(engineering)}/conversations/${conversationId}`)).status,
      404,
    );
    assert.deepEqual(
      (await platformMember.client.get(`${agentPath(engineering)}/conversations`)).body.data.conversations,
      [],
    );
    assert.equal(
      (await platformMember.client.delete(`${agentPath(engineering)}/conversations/${conversationId}`)).status,
      404,
    );

    const deleted = await engMember.client.delete(`${agentPath(engineering)}/conversations/${conversationId}`);
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
    assert.equal(deleted.body.data.deletedMessages, 4);
    assert.equal((await engMember.client.get(`${agentPath(engineering)}/conversations/${conversationId}`)).status, 404);

    const cleared = await engMember.client.delete(`${agentPath(engineering)}/conversations`);
    assert.equal(cleared.status, 200);
    assert.ok(cleared.body.data.deletedConversations >= 1);
    assert.deepEqual(
      (await engMember.client.get(`${agentPath(engineering)}/conversations`)).body.data.conversations,
      [],
    );
    assert.equal(
      await collection('agentquestions').countDocuments({ departmentId: asId(engineering) }),
      2,
      'the inbox keeps its questions',
    );
  });

  it("lets a person in a shared service's audience ask it from another department", async () => {
    index.scriptAnswer(answered(peopleDocumentId, 'Health cover is included [1].'));
    const response = await ask(financeMember.client, people, { question: 'Is health cover included?' });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.data.message.citations[0].documentName, 'Benefits.md');
  });
});
