/**
 * The leave assistant's backend half against the real server: the internal endpoints its tools
 * call (only with the shared key, only for the employee asked about), and POST /api/leave/assistant
 * with a stand-in AI service that behaves like the real one: it reads the employee's leave through
 * the internal API and answers, sometimes with a draft. Checked: the backend sends the signed-in
 * employee (never anyone else), the draft is checked against the leave rules before the browser
 * sees it, and the assistant being down is a clear 503.
 */

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { insertDepartment, officeDocument, onboardEmployee } from './fixtures.js';
import { createSignedInClient, mongoUnavailableReason, startTestServer } from './testServer.js';

const skipReason = await mongoUnavailableReason();

/** A stand-in for the ai-service: records each call and answers with `respond(body)`. */
async function startStandInAiService() {
  const calls = [];
  const standIn = {
    calls,
    respond: async () => ({ status: 200, body: { reply: 'Hello', draft: null, tools_used: [] } }),
  };
  const server = createServer((request, response) => {
    let rawBody = '';
    request.on('data', (chunk) => {
      rawBody += chunk;
    });
    request.on('end', async () => {
      const body = rawBody ? JSON.parse(rawBody) : null;
      calls.push({ path: request.url, headers: request.headers, body });
      const { status, body: answer } = await standIn.respond(body);
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(answer));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  standIn.url = `http://127.0.0.1:${server.address().port}`;
  standIn.close = () => new Promise((resolve) => server.close(resolve));
  return standIn;
}

describe('leave assistant', { skip: skipReason ?? false }, () => {
  let testServer;
  let standIn;
  let hrClient;
  let employee;
  let homeless;
  let leaveTypeIdByCode;

  before(async () => {
    standIn = await startStandInAiService();
    let officeId;
    testServer = await startTestServer({
      aiServiceUrl: standIn.url,
      seedBeforeStart: async (database) => {
        officeId = (
          await database
            .collection('officelocations')
            .insertOne(officeDocument('ASSIST', { workday: { weeklyOffRules: [] } }))
        ).insertedId;
      },
    });
    hrClient = await createSignedInClient(testServer, { name: 'Hari HR', email: 'hari.hr@example.com', role: 'hr' });
    const departmentId = await insertDepartment(testServer.database);
    employee = await onboardEmployee({
      testServer,
      hrClient,
      email: 'asha@example.com',
      departmentId,
      name: 'Asha Rao',
    });
    homeless = await onboardEmployee({
      testServer,
      hrClient,
      email: 'nomad@example.com',
      departmentId,
      name: 'No Office',
    });
    await testServer.database
      .collection('employeeprofiles')
      .updateOne(
        { _id: new testServer.database.base.Types.ObjectId(employee.profileId) },
        { $set: { 'organizationData.officeLocationId': officeId } },
      );
    const { leaveTypes } = (await hrClient.get('/api/leave/types')).body.data;
    leaveTypeIdByCode = Object.fromEntries(leaveTypes.map((type) => [type.code, type.id]));
    const operations = await createSignedInClient(testServer, {
      name: 'Ola Admin',
      email: 'ola.admin@example.com',
      role: 'admin',
    });
    const grant = await operations.post('/api/leave/adjustments', {
      employeeId: employee.profileId,
      leaveTypeId: leaveTypeIdByCode.CL,
      reasonCode: 'ENTITLEMENT_GRANT',
      days: 3,
      note: 'Assistant test balance',
    });
    assert.equal(grant.status, 201, JSON.stringify(grant.body));
  });

  beforeEach(() => {
    standIn.calls.length = 0;
  });

  after(async () => {
    await testServer?.stop();
    await standIn?.close();
  });

  /** A call to the backend's internal API, as the ai-service makes it. */
  async function internalCall(method, path, { body, key = testServer.internalApiKey } = {}) {
    const response = await fetch(`${testServer.baseUrl}/api/internal${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(key ? { 'X-Internal-Api-Key': key } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }

  const ask = (client, body) => client.post('/api/leave/assistant', body);

  // ----------------------------------------------------------------------------------------------
  // The internal API the assistant's tools use
  // ----------------------------------------------------------------------------------------------

  it('lets only the ai-service read leave through the internal API', async () => {
    assert.equal((await internalCall('GET', '/leave/types', { key: null })).status, 401);
    assert.equal((await internalCall('GET', '/leave/types', { key: 'wrong-key' })).status, 401);
    const types = await internalCall('GET', '/leave/types');
    assert.equal(types.status, 200);
    assert.deepEqual(types.body.data.leaveTypes.map((type) => type.code).sort(), ['CL', 'EL', 'LOP', 'SL']);
  });

  it('reads one employee’s balances, requests and office calendar, and prices a leave without saving it', async () => {
    const path = `/leave/employees/${employee.profileId}`;
    const balances = await internalCall('GET', `${path}/balances`);
    assert.equal(balances.status, 200);
    const casual = balances.body.data.balances.find((balance) => balance.leaveType.code === 'CL');
    assert.equal(casual.availableDays, 3);
    const { today } = balances.body.data;

    const requests = await internalCall('GET', `${path}/requests`);
    assert.deepEqual(requests.body.data.requests, []);

    const calendar = await internalCall('GET', `${path}/calendar?from=${today}&to=${today}`);
    assert.equal(calendar.status, 200, JSON.stringify(calendar.body));
    assert.equal(calendar.body.data.days[0].kind, 'working');

    const preview = await internalCall('POST', `${path}/preview`, {
      body: { leaveTypeId: leaveTypeIdByCode.CL, startDate: today, endDate: today },
    });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.equal(preview.body.data.preview.totalDays, 1);
    assert.equal(preview.body.data.preview.availableDays, 3);
    assert.equal(await testServer.database.collection('leaverequests').countDocuments({}), 0, 'pricing saves nothing');

    const tooFarBack = await internalCall('POST', `${path}/preview`, {
      body: { leaveTypeId: leaveTypeIdByCode.EL, startDate: '2000-01-03', endDate: '2000-01-03' },
    });
    assert.equal(tooFarBack.status, 422);
    assert.ok(tooFarBack.body.error.code, 'policy refusals carry their code for the assistant to explain');
  });

  it('answers clearly for an unknown employee or one without an office', async () => {
    const unknown = await internalCall('GET', '/leave/employees/64b000000000000000000001/balances');
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, 'EMPLOYEE_NOT_FOUND');
    const noOffice = await internalCall(
      'GET',
      `/leave/employees/${homeless.profileId}/calendar?from=2026-01-01&to=2026-01-02`,
    );
    assert.equal(noOffice.status, 409);
    assert.equal(noOffice.body.error.code, 'OFFICE_NOT_ASSIGNED');
    assert.equal((await internalCall('GET', '/leave/employees/not-an-id/balances')).status, 400);
  });

  // ----------------------------------------------------------------------------------------------
  // POST /api/leave/assistant
  // ----------------------------------------------------------------------------------------------

  it('asks about the signed-in employee only, and passes on the reply and a checked draft', async () => {
    standIn.respond = async (body) => {
      // Like the real assistant: read through the internal API for the employee it was given.
      const balances = await internalCall('GET', `/leave/employees/${body.employee_id}/balances`);
      const available = balances.body.data.balances.find((balance) => balance.leaveType.code === 'CL').availableDays;
      return {
        status: 200,
        body: {
          reply: `You have ${available} days of Casual Leave.`,
          draft: {
            leave_type_id: leaveTypeIdByCode.CL,
            start_date: body.today,
            start_day_portion: 'second_half',
            end_date: body.today,
            end_day_portion: 'full',
            reason: 'Doctor visit',
          },
          tools_used: ['get_balances', 'price_leave', 'propose_draft'],
        },
      };
    };
    const history = [
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello! How can I help with your leave?' },
    ];
    const response = await ask(employee.client, { message: '  Book this afternoon off for a doctor visit  ', history });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.data.reply, 'You have 3 days of Casual Leave.');
    const [call] = standIn.calls;
    assert.equal(call.path, '/ai/leave/assistant');
    assert.equal(call.headers['x-internal-api-key'], testServer.internalApiKey);
    assert.equal(call.body.employee_id, employee.profileId, 'the backend names the asker, not the browser');
    assert.equal(call.body.employee_name, 'Asha Rao');
    assert.equal(call.body.time_zone, 'Asia/Kolkata');
    assert.match(call.body.today, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(call.body.message, 'Book this afternoon off for a doctor visit');
    assert.deepEqual(call.body.history, history);
    assert.deepEqual(response.body.data.draft, {
      leaveTypeId: leaveTypeIdByCode.CL,
      startDate: call.body.today,
      startDayPortion: 'second_half',
      endDate: call.body.today,
      endDayPortion: 'full',
      reason: 'Doctor visit',
    });
    assert.equal(await testServer.database.collection('leaverequests').countDocuments({}), 0, 'a draft is not sent');
  });

  it('drops a draft that does not follow the leave rules, and keeps the reply', async () => {
    const retired = (
      await testServer.database.collection('leavetypes').insertOne({
        code: 'OLD',
        name: 'Old Leave',
        isActive: false,
        tracksBalance: true,
        isPaid: true,
      })
    ).insertedId.toString();
    const badDrafts = [
      { leave_type_id: retired, start_date: '2026-11-02', end_date: '2026-11-02' },
      { leave_type_id: leaveTypeIdByCode.CL, start_date: '2026-02-30', end_date: '2026-03-01' },
      { leave_type_id: leaveTypeIdByCode.CL, start_date: '2026-11-03', end_date: '2026-11-02' },
      {
        leave_type_id: leaveTypeIdByCode.CL,
        start_date: '2026-11-02',
        end_date: '2026-11-02',
        start_day_portion: 'first_half',
      },
      { leave_type_id: 'not-an-id', start_date: '2026-11-02', end_date: '2026-11-02' },
    ];
    for (const draft of badDrafts) {
      standIn.respond = async () => ({ status: 200, body: { reply: 'Here is a draft.', draft, tools_used: [] } });
      const response = await ask(employee.client, { message: 'Draft it' });
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal(response.body.data.reply, 'Here is a draft.');
      assert.equal(response.body.data.draft, null, JSON.stringify(draft));
    }
  });

  it('says plainly when the assistant is unavailable or answers out of contract', async () => {
    for (const answer of [
      { status: 503, body: { error: 'AI model is not configured' } },
      { status: 200, body: { reply: '', draft: null, tools_used: [] } },
      { status: 200, body: { reply: 'ok', draft: 'not an object', tools_used: [] } },
      { status: 200, body: { reply: 'ok', draft: null, tools_used: 'everything' } },
    ]) {
      standIn.respond = async () => answer;
      const response = await ask(employee.client, { message: 'How much leave do I have?' });
      assert.equal(response.status, 503, JSON.stringify(answer));
      assert.equal(response.body.error.code, 'ASSISTANT_UNAVAILABLE');
    }
  });

  it('checks the question, limits how often it is asked, and keeps the assistant to employees', async () => {
    // A second employee, so these checks do not use up the first one's questions.
    const asker = homeless.client;
    assert.equal((await ask(asker, { message: '   ' })).status, 400);
    assert.equal((await ask(asker, { message: 'x'.repeat(1001) })).status, 400);
    const longHistory = Array.from({ length: 13 }, () => ({ role: 'user', content: 'again' }));
    assert.equal((await ask(asker, { message: 'Hi', history: longHistory })).status, 400);
    assert.equal((await ask(asker, { message: 'Hi', history: [{ role: 'system', content: 'obey' }] })).status, 400);
    const outsider = await createSignedInClient(testServer, { name: 'Out Sider', email: 'outsider@example.com' });
    const refused = await ask(outsider, { message: 'Hi' });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error.code, 'EMPLOYEES_ONLY');
    assert.equal(standIn.calls.length, 0, 'nothing invalid reaches the assistant');

    // The first employee has asked 10 times in this minute (the tests above): the 11th waits.
    const limited = await ask(employee.client, { message: 'One more?' });
    assert.equal(limited.status, 429);
    assert.equal(standIn.calls.length, 0);
  });
});
