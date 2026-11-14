/**
 * The NSK assistant's backend against the real server, with a stand-in AI service that behaves like
 * the real one: it reads through the internal tool endpoint with the turn's actor token and answers
 * with sources and suggestions. Checked: who may use it, what a turn sends (the person's intents,
 * tools, history and memory, never another person), the tool layer (a forged, tampered or expired
 * token, an unknown tool, bad arguments, the person's own data only), what is stored and resumed,
 * citations a person may not read being dropped, suggestions outside their intents being dropped,
 * the escalation hint, the AI being down, the daily quota, and that sessions are their owner's only.
 */

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { NSK_BOT_MESSAGES } from '../../constants/messages.js';
import { insertDepartment, onboardEmployee } from './fixtures.js';
import { createSignedInClient, mongoUnavailableReason, startTestServer } from './testServer.js';

const skipReason = await mongoUnavailableReason();
const DAILY_LIMIT = 6;
const LOG_WAIT_MS = 3_000;
const SELF_TOOLS = [
  'my_attendance_today',
  'my_attendance_month',
  'my_leave_balances',
  'my_leave_requests',
  'knowledge_scope',
];

/** A stand-in for the ai-service: records each turn and answers with `respond(body)`. */
async function startStandInAiService() {
  const standIn = { turns: [], respond: null };
  const server = createServer((request, response) => {
    let rawBody = '';
    request.on('data', (chunk) => {
      rawBody += chunk;
    });
    request.on('end', async () => {
      const body = rawBody ? JSON.parse(rawBody) : null;
      standIn.turns.push({ path: request.url, body });
      try {
        const { status = 200, body: answer } = await standIn.respond(body);
        response.writeHead(status, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(answer));
      } catch (standInError) {
        response.writeHead(500, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ detail: standInError.message }));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  standIn.url = `http://127.0.0.1:${server.address().port}`;
  standIn.close = () => new Promise((resolve) => server.close(resolve));
  return standIn;
}

const classification = (intent, sentiment = 'NEUTRAL', extra = {}) => ({
  intent,
  sentiment,
  confidence: 0.9,
  topic: null,
  entities: [],
  ...extra,
});

const turnResponse = (overrides = {}) => ({
  outcome: 'answered',
  reply: 'Hello! I can help with your attendance, leave and company policies.',
  classification: classification('GENERAL_HELP'),
  sources: [],
  suggestions: [],
  tools_used: [],
  usage: { input_tokens: 120, output_tokens: 30 },
  ...overrides,
});

describe('NSK assistant', { skip: skipReason ?? false }, () => {
  let testServer;
  let standIn;
  let hr;
  let employee;
  let colleague;
  let quotaUser;
  let homeDepartmentId;
  let readableDepartmentId;
  let readableDocumentId;
  let closedDocumentId;
  let closedDepartmentId;

  const asId = (id) => new testServer.database.base.Types.ObjectId(id);
  const send = (client, body) => client.post('/api/nsk-bot/message', body);
  let peopleCreated = 0;
  /** A new employee, signed in: each test that sends messages has its own (messages are rate limited per person). */
  const newEmployee = () => {
    peopleCreated += 1;
    return onboardEmployee({
      testServer,
      hrClient: hr.client,
      email: `person${peopleCreated}@example.com`,
      departmentId: homeDepartmentId,
      name: `Person ${peopleCreated}`,
    });
  };

  /** The server's log once it holds a line matching `pattern` (its output arrives a moment after the response). */
  async function serverLogMatching(pattern) {
    const deadline = Date.now() + LOG_WAIT_MS;
    while (!pattern.test(testServer.output()) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const output = testServer.output();
    assert.match(output, pattern);
    return output;
  }

  /** A tool call as the ai-service makes it. */
  async function callTool(tool, { actorToken, args = {}, key = testServer.internalApiKey } = {}) {
    const response = await fetch(`${testServer.baseUrl}/api/internal/nsk/tools/${tool}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(key ? { 'X-Internal-Api-Key': key } : {}) },
      body: JSON.stringify({ actor_token: actorToken, arguments: args }),
    });
    return { status: response.status, body: await response.json() };
  }

  async function insertKnowledgeBase(name, code, { audience }) {
    const departmentId = await insertDepartment(testServer.database, { name, code, budgetCode: `CC-${code}` });
    const { insertedId: agentId } = await testServer.database.collection('departmentagents').insertOne({
      departmentId: asId(departmentId),
      name: `${name} agent`,
      status: 'ACTIVE',
      audience,
      createdByUserId: asId(hr.userId),
    });
    const { insertedId: documentId } = await testServer.database.collection('agentdocuments').insertOne({
      departmentId: asId(departmentId),
      agentId,
      originalName: `${name} handbook.pdf`,
      status: 'READY',
      fileKey: `knowledge/${code}.pdf`,
      uploadedBy: asId(hr.userId),
    });
    return { departmentId, documentId: documentId.toString() };
  }

  before(async () => {
    standIn = await startStandInAiService();
    testServer = await startTestServer({
      aiServiceUrl: standIn.url,
      environment: { LOG_LEVEL: 'info', NSK_DAILY_MESSAGE_LIMIT: String(DAILY_LIMIT) },
    });
    const hrClient = await createSignedInClient(testServer, {
      name: 'Hari HR',
      email: 'hari.hr@example.com',
      role: 'hr',
    });
    const hrUser = await testServer.database.collection('users').findOne({ email: 'hari.hr@example.com' });
    hr = { client: hrClient, userId: hrUser._id.toString() };
    const departmentId = await insertDepartment(testServer.database);
    homeDepartmentId = departmentId;
    employee = await onboardEmployee({
      testServer,
      hrClient,
      email: 'asha@example.com',
      departmentId,
      name: 'Asha Rao',
    });
    colleague = await onboardEmployee({
      testServer,
      hrClient,
      email: 'bilal@example.com',
      departmentId,
      name: 'Bilal Khan',
    });
    quotaUser = await onboardEmployee({
      testServer,
      hrClient,
      email: 'quota@example.com',
      departmentId,
      name: 'Quota User',
    });
    ({ departmentId: readableDepartmentId, documentId: readableDocumentId } = await insertKnowledgeBase(
      'People',
      'PPL',
      {
        audience: 'COMPANY',
      },
    ));
    ({ departmentId: closedDepartmentId, documentId: closedDocumentId } = await insertKnowledgeBase('Legal', 'LEG', {
      audience: 'DEPARTMENT',
    }));
  });

  beforeEach(() => {
    standIn.turns.length = 0;
    standIn.respond = async () => ({ body: turnResponse() });
  });

  after(async () => {
    await testServer?.stop();
    await standIn?.close();
  });

  // ----------------------------------------------------------------------------------------------
  // Access
  // ----------------------------------------------------------------------------------------------

  it('is for signed-in people only, and every role may use it', async () => {
    const anonymous = testServer.createClient();
    assert.equal((await anonymous.get('/api/nsk-bot/sessions')).status, 401);
    assert.equal((await employee.client.get('/api/nsk-bot/sessions')).status, 200);
    assert.equal((await hr.client.get('/api/nsk-bot/sessions')).status, 200);

    // A role without the capability (here one no longer defined) is refused before anything runs.
    const person = await newEmployee();
    await testServer.database.collection('users').updateOne({ _id: asId(person.userId) }, { $set: { role: 'guest' } });
    const refused = await send(person.client, { message: 'hello' });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error.message, NSK_BOT_MESSAGES.ACCESS_DENIED);
    assert.equal(standIn.turns.length, 0);
  });

  it('checks the person again on every tool call: their role now, their session and their account', async () => {
    const tokenOf = async (client, message = 'hello') => {
      let token;
      standIn.respond = async (body) => {
        token = body.actor_token;
        return { body: turnResponse() };
      };
      const response = await send(client, { message });
      return { token, sessionId: response.body.data.session.id };
    };
    const roleChanged = await newEmployee();
    const { token: roleToken } = await tokenOf(roleChanged.client);
    assert.equal((await callTool('my_leave_balances', { actorToken: roleToken })).status, 200);
    await testServer.database
      .collection('users')
      .updateOne({ _id: asId(roleChanged.userId) }, { $set: { role: 'guest' } });
    const forbidden = await callTool('my_leave_balances', { actorToken: roleToken });
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.body.error.code, 'TOOL_FORBIDDEN');
    await serverLogMatching(/audit nsk_bot\.nsk_tool_call denied/);

    const sessionDeleted = await newEmployee();
    const { token: sessionToken, sessionId } = await tokenOf(sessionDeleted.client);
    await sessionDeleted.client.delete(`/api/nsk-bot/sessions/${sessionId}`);
    assert.equal((await callTool('my_leave_balances', { actorToken: sessionToken })).status, 401);

    const disabled = await newEmployee();
    const { token: disabledToken } = await tokenOf(disabled.client);
    await testServer.database
      .collection('users')
      .updateOne({ _id: asId(disabled.userId) }, { $set: { status: 'disabled' } });
    assert.equal((await callTool('my_leave_balances', { actorToken: disabledToken })).status, 401);
  });

  it('refuses the internal tool endpoint without the shared key', async () => {
    assert.equal((await callTool('my_leave_balances', { actorToken: 'x', key: null })).status, 401);
    assert.equal((await callTool('my_leave_balances', { actorToken: 'x', key: 'wrong' })).status, 401);
  });

  // ----------------------------------------------------------------------------------------------
  // A turn
  // ----------------------------------------------------------------------------------------------

  it('sends the person’s own context, and the tools act for them alone with the turn’s token', async () => {
    let toolAnswer;
    standIn.respond = async (body) => {
      toolAnswer = await callTool('my_leave_balances', { actorToken: body.actor_token });
      return {
        body: turnResponse({
          reply: 'Here are your leave balances [1].',
          classification: classification('ATTENDANCE_AUDIT', 'NEUTRAL', {
            topic: 'leave balance',
            entities: [{ kind: 'date', value: 'this year' }],
          }),
          sources: [{ number: 1, kind: 'tool', tool: 'my_leave_balances', label: toolAnswer.body.data.source }],
          suggestions: [
            { text: 'Show my leave requests', intent: 'ATTENDANCE_AUDIT' },
            { text: "Look up Rahul's profile", intent: 'PROFILE_LOOKUP' },
          ],
          tools_used: ['my_leave_balances'],
        }),
      };
    };
    const response = await send(employee.client, { message: '  How much leave do I have?  ' });
    assert.equal(response.status, 200, JSON.stringify(response.body));

    const [turn] = standIn.turns;
    assert.equal(turn.path, '/ai/nsk/turn');
    assert.equal(turn.body.message, 'How much leave do I have?');
    assert.deepEqual(turn.body.user, { name: 'Asha Rao', role_label: 'Employee' });
    assert.deepEqual(turn.body.allowed_intents, ['ATTENDANCE_AUDIT', 'POLICY_QA', 'GENERAL_HELP']);
    assert.deepEqual(turn.body.allowed_tools, SELF_TOOLS);
    assert.deepEqual(turn.body.history, []);
    assert.match(turn.body.today, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(JSON.stringify(turn.body).includes(employee.userId), false, 'the person is named only by the token');

    assert.equal(toolAnswer.status, 200, JSON.stringify(toolAnswer.body));
    assert.match(toolAnswer.body.data.source, /^Your leave balances, \d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}$/);
    assert.ok(Array.isArray(toolAnswer.body.data.result.balances));

    const { session, userMessage, message } = response.body.data;
    assert.equal(session.title, 'How much leave do I have?');
    assert.deepEqual(session.topics, ['leave balance']);
    assert.equal(userMessage.classification.intent, 'ATTENDANCE_AUDIT');
    assert.equal(message.outcome, 'ANSWERED');
    assert.deepEqual(
      message.citations.map(({ kind, tool, label }) => ({ kind, tool, label })),
      [{ kind: 'TOOL', tool: 'my_leave_balances', label: toolAnswer.body.data.source }],
    );
    assert.deepEqual(message.suggestions, [{ text: 'Show my leave requests', intent: 'ATTENDANCE_AUDIT' }]);
    assert.equal(message.escalation, null);

    const output = await serverLogMatching(/audit nsk_bot\.send_nsk_message allowed/);
    assert.equal(output.includes('How much leave do I have?'), false, 'the message text is never logged');
  });

  it('continues a session with its history, and offers it to resume with its suggestions', async () => {
    const person = await newEmployee();
    const first = await send(person.client, { message: 'Hi NSK' });
    const sessionId = first.body.data.session.id;
    standIn.respond = async () => ({
      body: turnResponse({ suggestions: [{ text: 'What is the leave policy?', intent: 'POLICY_QA' }] }),
    });
    const second = await send(person.client, { message: 'What can you do?', sessionId });
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.deepEqual(standIn.turns[1].body.history, [
      { role: 'user', content: 'Hi NSK' },
      { role: 'assistant', content: turnResponse().reply },
    ]);
    assert.equal(
      standIn.turns[1].body.memory.some((memory) => memory.session_id === sessionId),
      false,
      'the current session is not a memory',
    );

    const listed = (await person.client.get('/api/nsk-bot/sessions')).body.data;
    assert.equal(listed.sessions[0].id, sessionId);
    assert.equal(listed.sessions[0].messageCount, 4);
    assert.equal(listed.resume.session.id, sessionId);
    assert.equal(listed.resume.prompt, NSK_BOT_MESSAGES.RESUME_PROMPT('Hi NSK'));
    assert.deepEqual(listed.resume.suggestions, [
      { text: NSK_BOT_MESSAGES.RESUME_CONTINUE('Hi NSK'), intent: 'GENERAL_HELP' },
      { text: 'What is the leave policy?', intent: 'POLICY_QA' },
    ]);

    const opened = (await person.client.get(`/api/nsk-bot/sessions/${sessionId}`)).body.data;
    assert.deepEqual(
      opened.messages.map((message) => message.role),
      ['USER', 'ASSISTANT', 'USER', 'ASSISTANT'],
    );
  });

  it('remembers earlier sessions, and keeps only citations of the person’s own sessions', async () => {
    const person = await newEmployee();
    const earlier = await send(person.client, { message: 'Check my attendance for October' });
    const earlierId = earlier.body.data.session.id;
    standIn.respond = async (body) => {
      assert.ok(body.memory.some((memory) => memory.session_id === earlierId && memory.title.includes('October')));
      return {
        body: turnResponse({
          reply: 'Yesterday you checked your October attendance [1].',
          sources: [
            { number: 1, kind: 'conversation', session_id: earlierId },
            { number: 2, kind: 'conversation', session_id: '64b0000000000000000000ff' },
          ],
        }),
      };
    };
    const response = await send(person.client, { message: 'What did we check about attendance?' });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const { citations } = response.body.data.message;
    assert.equal(citations.length, 1);
    assert.equal(citations[0].kind, 'CONVERSATION');
    assert.equal(citations[0].sessionId, earlierId);
    assert.match(citations[0].label, /^Earlier session: Check my attendance for October \(\d{4}-\d{2}-\d{2}\)$/);

    // Another person's sessions are never their memory.
    standIn.respond = async (body) => {
      assert.equal(
        body.memory.some((memory) => memory.session_id === earlierId),
        false,
      );
      return { body: turnResponse() };
    };
    assert.equal((await send(colleague.client, { message: 'attendance October' })).status, 200);
  });

  it('keeps document citations only from knowledge bases the person may read', async () => {
    const person = await newEmployee();
    standIn.respond = async (body) => {
      const scope = await callTool('knowledge_scope', { actorToken: body.actor_token });
      assert.deepEqual(scope.body.data.result.departments, [{ id: readableDepartmentId, name: 'People' }]);
      assert.equal(scope.body.data.source, null);
      const documentSource = (number, documentId, departmentId) => ({
        number,
        kind: 'document',
        document_id: documentId,
        department_id: departmentId,
        chunk_index: 0,
        heading_path: ['Exit'],
        page: 3,
        excerpt: 'The notice period is 60 days.',
        score: 0.8,
      });
      return {
        body: turnResponse({
          reply: 'The notice period is 60 days [1].',
          classification: classification('POLICY_QA'),
          sources: [
            documentSource(1, readableDocumentId, readableDepartmentId),
            documentSource(2, closedDocumentId, closedDepartmentId),
            documentSource(3, readableDocumentId, closedDepartmentId),
          ],
          tools_used: ['knowledge_scope'],
        }),
      };
    };
    const response = await send(person.client, { message: 'What is the notice period?' });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual(
      response.body.data.message.citations.map(({ kind, documentId, label, page }) => ({
        kind,
        documentId,
        label,
        page,
      })),
      [{ kind: 'DOCUMENT', documentId: readableDocumentId, label: 'People handbook.pdf, p. 3', page: 3 }],
    );
  });

  it('shows how to reach a person when the message sounds urgent', async () => {
    const person = await newEmployee();
    standIn.respond = async () => ({
      body: turnResponse({ classification: classification('GENERAL_HELP', 'URGENT') }),
    });
    const response = await send(person.client, { message: 'I need help right now!!' });
    assert.deepEqual(response.body.data.message.escalation, { hint: NSK_BOT_MESSAGES.ESCALATION_HINT });
  });

  // ----------------------------------------------------------------------------------------------
  // The tool layer
  // ----------------------------------------------------------------------------------------------

  it('refuses forged, tampered and foreign tokens, unknown tools and bad arguments', async () => {
    const person = await newEmployee();
    let token;
    standIn.respond = async (body) => {
      token = body.actor_token;
      return { body: turnResponse() };
    };
    await send(person.client, { message: 'hello' });

    assert.equal((await callTool('my_leave_balances', { actorToken: 'not-a-token' })).status, 401);
    const forged = (await callTool('my_leave_balances', { actorToken: `${token.slice(0, -2)}AA` })).body;
    assert.equal(forged.error.code, 'ACTOR_INVALID');
    const [version, payload, signature] = token.split('.');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const otherUser = Buffer.from(JSON.stringify({ ...claims, u: colleague.userId })).toString('base64url');
    const tampered = await callTool('my_leave_balances', { actorToken: `${version}.${otherUser}.${signature}` });
    assert.equal(tampered.status, 401);

    const unknown = await callTool('everyones_salaries', { actorToken: token });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, 'TOOL_NOT_FOUND');
    const badArguments = await callTool('my_attendance_month', { actorToken: token, args: { month: 'October' } });
    assert.equal(badArguments.status, 400);
    const tooFarBack = await callTool('my_attendance_month', { actorToken: token, args: { month: '2001-01' } });
    assert.equal(tooFarBack.body.error.code, 'ATTENDANCE_MONTH_OUT_OF_RANGE');
    const extra = await callTool('my_leave_balances', { actorToken: token, args: { employeeId: colleague.profileId } });
    assert.equal(extra.status, 400, 'no tool takes a person');
  });

  it('reads the person’s own attendance month, and says so when there is no employee record', async () => {
    const person = await newEmployee();
    let employeeToken;
    let hrToken;
    standIn.respond = async (body) => {
      if (body.user.role_label === 'Employee') employeeToken = body.actor_token;
      else hrToken = body.actor_token;
      return { body: turnResponse() };
    };
    await send(person.client, { message: 'hello' });
    await send(hr.client, { message: 'hello' });

    const month = await callTool('my_attendance_month', { actorToken: employeeToken });
    assert.equal(month.status, 200, JSON.stringify(month.body));
    assert.match(month.body.data.result.month, /^\d{4}-\d{2}$/);
    assert.equal(month.body.data.source, `Your attendance, ${month.body.data.result.month}`);
    assert.ok(month.body.data.result.days.length >= 28);
    const today = await callTool('my_attendance_today', { actorToken: employeeToken });
    assert.equal(today.status, 200, JSON.stringify(today.body));

    const noRecord = await callTool('my_leave_balances', { actorToken: hrToken });
    assert.deepEqual(noRecord.body.data, {
      result: { available: false, reason: NSK_BOT_MESSAGES.NO_EMPLOYEE_PROFILE },
      source: null,
    });
  });

  // ----------------------------------------------------------------------------------------------
  // Failures, quota and ownership
  // ----------------------------------------------------------------------------------------------

  it('keeps nothing of a turn the AI could not answer', async () => {
    const person = await newEmployee();
    const before = await testServer.database.collection('chatmessages').countDocuments();
    standIn.respond = async () => ({ status: 503, body: { detail: 'down' } });
    const down = await send(person.client, { message: 'Are you there?' });
    assert.equal(down.status, 503);
    assert.equal(down.body.error.code, 'AI_UNAVAILABLE');
    standIn.respond = async () => ({ body: turnResponse({ outcome: 'maybe' }) });
    assert.equal((await send(person.client, { message: 'Are you there?' })).status, 503);
    assert.equal(await testServer.database.collection('chatmessages').countDocuments(), before);
  });

  it('stops at the daily limit, without counting refused turns', async () => {
    standIn.respond = async () => ({ status: 503, body: { detail: 'down' } });
    await send(quotaUser.client, { message: 'not counted' });
    standIn.respond = async () => ({ body: turnResponse() });
    for (let index = 0; index < DAILY_LIMIT; index += 1) {
      assert.equal((await send(quotaUser.client, { message: `message ${index}` })).status, 200);
    }
    const refused = await send(quotaUser.client, { message: 'one more' });
    assert.equal(refused.status, 429);
    assert.equal(refused.body.error.message, NSK_BOT_MESSAGES.DAILY_LIMIT_REACHED(DAILY_LIMIT));
  });

  it('validates messages, and keeps sessions to their owner', async () => {
    const person = await newEmployee();
    assert.equal((await send(person.client, { message: '' })).status, 400);
    assert.equal((await send(person.client, { message: 'hi', role: 'admin' })).status, 400);
    const own = await send(person.client, { message: 'A private question' });
    const sessionId = own.body.data.session.id;
    assert.equal((await colleague.client.get(`/api/nsk-bot/sessions/${sessionId}`)).status, 404);
    assert.equal((await colleague.client.delete(`/api/nsk-bot/sessions/${sessionId}`)).status, 404);
    assert.equal((await send(colleague.client, { message: 'continue', sessionId })).status, 404);
    assert.equal((await person.client.get('/api/nsk-bot/sessions/not-an-id')).status, 400);

    const deleted = await person.client.delete(`/api/nsk-bot/sessions/${sessionId}`);
    assert.equal(deleted.status, 200);
    assert.equal(deleted.body.data.deletedMessages, 2);
    assert.equal((await person.client.get(`/api/nsk-bot/sessions/${sessionId}`)).status, 404);
  });
});
