/**
 * "Rahul is leaving" against the real server: the find_offboarding_employee tool through the
 * internal endpoint with real actor tokens (HR and administrators only; ambiguous names answered
 * with candidates; one match answered with the action cards), what each turn offers the ai-service
 * (the offboarding intent and tool for HR only), and the action cards the backend keeps from a reply:
 * only kinds the person may use, for people who exist and are still employed, Start offboarding only
 * while it has not started, with the backend's own labels.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { NSK_BOT_MESSAGES } from '../../constants/messages.js';
import { insertDepartment, onboardEmployee } from './fixtures.js';
import { callNskTool, classification, serverLogMatching, startNskStandIn, turnResponse } from './nskStandIn.js';
import { createSignedInClient, mongoUnavailableReason, startTestServer } from './testServer.js';

const skipReason = await mongoUnavailableReason();
const MISSING_ID = '0123456789abcdef01234567';

describe('NSK offboarding cards', { skip: skipReason ?? false }, () => {
  let testServer;
  let standIn;
  let hr;
  let finance;
  let employee;
  let rahulSharma;
  let rahulVerma;
  let leaving;
  let lastTurn;

  const asId = (id) => new testServer.database.base.Types.ObjectId(id);
  const collection = (name) => testServer.database.collection(name);
  const codeOf = async (person) =>
    (await collection('employeeprofiles').findOne({ _id: asId(person.profileId) })).employeeCode;

  /** A turn the stand-in answers with `answer` (built from the request); returns the response. */
  async function turn(client, message, answer = () => turnResponse()) {
    standIn.respond = async (body) => {
      lastTurn = body;
      return { body: await answer(body) };
    };
    return client.post('/api/nsk-bot/message', { message });
  }
  async function tokenOf(client) {
    let token;
    await turn(client, 'hello', (body) => {
      token = body.actor_token;
      return turnResponse();
    });
    return token;
  }
  const find = async (client, query) =>
    callNskTool(testServer, 'find_offboarding_employee', { actorToken: await tokenOf(client), args: { query } });

  before(async () => {
    standIn = await startNskStandIn();
    testServer = await startTestServer({ aiServiceUrl: standIn.url, environment: { LOG_LEVEL: 'info' } });
    hr = await createSignedInClient(testServer, { name: 'Hari HR', email: 'hari.hr@example.com', role: 'hr' });
    finance = await createSignedInClient(testServer, {
      name: 'Fia Finance',
      email: 'fia@example.com',
      role: 'finance',
    });
    employee = await createSignedInClient(testServer, { name: 'Eli Employee', email: 'eli@example.com' });
    const departmentId = await insertDepartment(testServer.database, {
      name: 'Engineering',
      code: 'ENG',
      budgetCode: 'CC-1',
    });
    rahulSharma = await onboardEmployee({
      testServer,
      hrClient: hr,
      email: 'rahul.sharma@example.com',
      departmentId,
      name: 'Rahul Sharma',
    });
    rahulVerma = await onboardEmployee({
      testServer,
      hrClient: hr,
      email: 'rahul.verma@example.com',
      departmentId,
      name: 'Rahul Verma',
    });
    leaving = await onboardEmployee({
      testServer,
      hrClient: hr,
      email: 'lena@example.com',
      departmentId,
      name: 'Lena Leaving',
    });
    // Lena's offboarding has started.
    await collection('offboardingcases').insertOne({
      employeeId: asId(leaving.profileId),
      employeeUserId: asId(leaving.userId),
      isActive: true,
      status: 'COMPLETED',
      separation: { kind: 'RESIGNATION', noticeDate: '2026-10-01', lastWorkingDay: '2026-11-30' },
    });
  });

  after(async () => {
    await testServer?.stop();
    await standIn?.close();
  });

  it('offers the offboarding intent and tool to HR, not to finance or employees', async () => {
    await turn(hr, 'hello');
    assert.ok(lastTurn.allowed_intents.includes('OFFBOARDING_WORKFLOW'));
    assert.ok(lastTurn.allowed_tools.includes('find_offboarding_employee'));
    for (const client of [finance, employee]) {
      await turn(client, 'hello');
      assert.ok(!lastTurn.allowed_intents.includes('OFFBOARDING_WORKFLOW'));
      assert.ok(!lastTurn.allowed_tools.includes('find_offboarding_employee'));
    }
  });

  it('finds the person: candidates for an ambiguous name, the cards for one match, refused for finance', async () => {
    const ambiguous = await find(hr, 'Rahul');
    assert.equal(ambiguous.status, 200, JSON.stringify(ambiguous.body));
    assert.equal(ambiguous.body.data.result.matches, 2);
    assert.deepEqual(
      ambiguous.body.data.result.candidates.map((candidate) => candidate.name),
      ['Rahul Sharma', 'Rahul Verma'],
    );
    assert.equal(ambiguous.body.data.result.actions, undefined);

    const one = await find(hr, 'Rahul Sharma');
    assert.equal(one.status, 200);
    const { employee: found, actions } = one.body.data.result;
    assert.equal(found.employee_id, rahulSharma.profileId);
    assert.equal(found.employee_code, await codeOf(rahulSharma));
    assert.equal(found.offboarding, null);
    assert.deepEqual(actions, [
      { kind: 'START_OFFBOARDING', employee_id: rahulSharma.profileId },
      { kind: 'VIEW_PROFILE', employee_id: rahulSharma.profileId },
    ]);
    assert.doesNotMatch(JSON.stringify(one.body), /salary|phone/i);

    const started = await find(hr, 'Lena Leaving');
    assert.equal(started.body.data.result.employee.offboarding.case_status, 'COMPLETED');
    assert.equal(started.body.data.result.note, NSK_BOT_MESSAGES.OFFBOARDING_ALREADY_STARTED_NOTE);
    assert.deepEqual(
      started.body.data.result.actions.map((action) => action.kind),
      ['VIEW_PROFILE'],
    );

    const refused = await find(finance, 'Rahul Sharma');
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error.code, 'TOOL_FORBIDDEN');

    const log = await serverLogMatching(testServer, /"tool":"find_offboarding_employee"/);
    assert.match(log, /"action":"nsk_people_lookup".*"tool":"find_offboarding_employee"/);
  });

  it('keeps only the cards that apply, with the backend’s labels', async () => {
    const rahulCode = await codeOf(rahulSharma);
    const proposed = [
      { kind: 'START_OFFBOARDING', employee_id: rahulSharma.profileId },
      { kind: 'VIEW_PROFILE', employee_id: rahulSharma.profileId },
      { kind: 'START_OFFBOARDING', employee_id: leaving.profileId },
      { kind: 'START_OFFBOARDING', employee_id: MISSING_ID },
    ];
    const answer = () =>
      turnResponse({
        reply: 'That is Rahul Sharma, Analyst. Use the cards below.',
        classification: classification('OFFBOARDING_WORKFLOW', 'NEUTRAL', {
          entities: [{ kind: 'employeeName', value: 'Rahul' }],
        }),
        actions: proposed,
        tools_used: ['find_offboarding_employee'],
      });
    const byHr = await turn(hr, 'Rahul Sharma is leaving', answer);
    assert.equal(byHr.status, 200, JSON.stringify(byHr.body));
    assert.deepEqual(byHr.body.data.message.actions, [
      {
        kind: 'START_OFFBOARDING',
        label: NSK_BOT_MESSAGES.ACTION_LABELS.START_OFFBOARDING('Rahul Sharma', rahulCode),
        employeeId: rahulSharma.profileId,
        employeeCode: rahulCode,
        employeeName: 'Rahul Sharma',
      },
      {
        kind: 'VIEW_PROFILE',
        label: NSK_BOT_MESSAGES.ACTION_LABELS.VIEW_PROFILE('Rahul Sharma', rahulCode),
        employeeId: rahulSharma.profileId,
        employeeCode: rahulCode,
        employeeName: 'Rahul Sharma',
      },
    ]);
    // Stored with the message, so the session shows them again.
    const session = await hr.get(`/api/nsk-bot/sessions/${byHr.body.data.session.id}`);
    assert.equal(session.body.data.messages.at(-1).actions.length, 2);

    // Finance may look people up, not offboard them: only the profile card is kept.
    const byFinance = await turn(finance, 'Rahul Sharma is leaving', answer);
    assert.deepEqual(
      byFinance.body.data.message.actions.map((action) => action.kind),
      ['VIEW_PROFILE'],
    );
    const byEmployee = await turn(employee, 'Rahul Sharma is leaving', answer);
    assert.deepEqual(byEmployee.body.data.message.actions, []);
  });

  it('drops a card for someone no longer employed, and refuses a malformed one', async () => {
    await collection('employeeprofiles').updateOne(
      { _id: asId(rahulVerma.profileId) },
      { $set: { 'organizationData.employmentStatus': 'Terminated' } },
    );
    const gone = await turn(hr, 'Rahul Verma is leaving', () =>
      turnResponse({ actions: [{ kind: 'VIEW_PROFILE', employee_id: rahulVerma.profileId }] }),
    );
    assert.deepEqual(gone.body.data.message.actions, []);
    const malformed = await turn(hr, 'Rahul Sharma is leaving', () =>
      turnResponse({ actions: [{ kind: 'DELETE_EVERYTHING', employee_id: rahulSharma.profileId }] }),
    );
    assert.equal(malformed.status, 503);
  });
});
