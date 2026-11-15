/**
 * The NSK people tools against the real server, through the internal tool endpoint with real actor
 * tokens (from turns answered by a stand-in AI service): who may look people up (roles with
 * RUN_PEOPLE_LOOKUP, department heads for their own departments only, nobody else), what a profile
 * shows (phone masked for everyone, salary from the latest payslip only for roles with
 * MANAGE_COMPENSATION), ambiguous names answered with candidates, misspelled names answered with the
 * closest spellings as candidates to confirm (within the scope only), department metrics (headcount,
 * attendance today, sprint and tasks, pending approvals) within the requester's departments, and the
 * audit entry of every lookup (fields shown, never the values).
 */

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { NSK_BOT_MESSAGES } from '../../constants/messages.js';
import { insertDepartment, onboardEmployee } from './fixtures.js';
import { callNskTool, serverLogMatching, startNskStandIn, turnResponse } from './nskStandIn.js';
import { createSignedInClient, mongoUnavailableReason, startTestServer } from './testServer.js';

const skipReason = await mongoUnavailableReason();
const PHONE = '+919876543210';
const PEOPLE_TOOLS = ['lookup_employee_profile', 'get_department_metrics'];

describe('NSK people tools', { skip: skipReason ?? false }, () => {
  let testServer;
  let standIn;
  let hr;
  let finance;
  let itAdmin;
  let engineeringId;
  let financeDepartmentId;
  let head;
  let rahulSharma;
  let rahulVerma;
  let plain;
  let lastTurn;

  const asId = (id) => new testServer.database.base.Types.ObjectId(id);
  const collection = (name) => testServer.database.collection(name);
  const codeOf = async (person) =>
    (await collection('employeeprofiles').findOne({ _id: asId(person.profileId) })).employeeCode;

  /** A fresh actor token for `client`, from a turn the stand-in answers. */
  async function tokenOf(client) {
    let token;
    standIn.respond = async (body) => {
      token = body.actor_token;
      lastTurn = body;
      return { body: turnResponse() };
    };
    const response = await client.post('/api/nsk-bot/message', { message: 'hello' });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return token;
  }
  const lookup = async (client, query) =>
    callNskTool(testServer, 'lookup_employee_profile', { actorToken: await tokenOf(client), args: { query } });
  const metrics = async (client, department) =>
    callNskTool(testServer, 'get_department_metrics', {
      actorToken: await tokenOf(client),
      args: department === undefined ? {} : { department },
    });

  before(async () => {
    standIn = await startNskStandIn();
    testServer = await startTestServer({ aiServiceUrl: standIn.url, environment: { LOG_LEVEL: 'info' } });
    const hrClient = await createSignedInClient(testServer, {
      name: 'Hari HR',
      email: 'hari.hr@example.com',
      role: 'hr',
    });
    hr = { client: hrClient };
    finance = await createSignedInClient(testServer, {
      name: 'Fia Finance',
      email: 'fia@example.com',
      role: 'finance',
    });
    itAdmin = await createSignedInClient(testServer, { name: 'Ivo IT', email: 'ivo@example.com', role: 'it_admin' });
    engineeringId = await insertDepartment(testServer.database, {
      name: 'Engineering',
      code: 'ENG',
      budgetCode: 'CC-1',
    });
    financeDepartmentId = await insertDepartment(testServer.database, {
      name: 'Finance',
      code: 'FIN',
      budgetCode: 'CC-2',
    });

    head = await onboardEmployee({
      testServer,
      hrClient,
      email: 'hema@example.com',
      departmentId: engineeringId,
      name: 'Hema Head',
    });
    rahulSharma = await onboardEmployee({
      testServer,
      hrClient,
      email: 'rahul.sharma@example.com',
      departmentId: engineeringId,
      name: 'Rahul Sharma',
      reportingManagerId: head.profileId,
    });
    rahulVerma = await onboardEmployee({
      testServer,
      hrClient,
      email: 'rahul.verma@example.com',
      departmentId: financeDepartmentId,
      name: 'Rahul Verma',
    });
    plain = await onboardEmployee({
      testServer,
      hrClient,
      email: 'priya@example.com',
      departmentId: engineeringId,
      name: 'Priya Plain',
    });

    await collection('departments').updateOne(
      { _id: asId(engineeringId) },
      { $set: { departmentHeadId: asId(head.profileId) } },
    );
    await collection('users').updateOne({ _id: asId(rahulSharma.userId) }, { $set: { phoneNumber: PHONE } });
    await collection('payslips').insertOne({
      employeeId: asId(rahulSharma.profileId),
      period: { year: 2026, month: 10 },
      status: 'Issued',
      earnings: [
        { code: 'BASIC', label: 'Basic Salary', amount: 50000 },
        { code: 'HRA', label: 'House Rent Allowance', amount: 25000 },
      ],
      grossEarnings: 75000,
      totalDeductions: 8000,
      netPay: 67000,
      verification: { verificationId: 'PS-202610-AAAA-0000-0000-0001' },
    });
    await collection('payslips').insertOne({
      employeeId: asId(rahulSharma.profileId),
      period: { year: 2026, month: 9 },
      status: 'Issued',
      earnings: [{ code: 'BASIC', label: 'Basic Salary', amount: 40000 }],
      grossEarnings: 60000,
      totalDeductions: 7000,
      netPay: 53000,
      verification: { verificationId: 'PS-202609-AAAA-0000-0000-0002' },
    });
    const { insertedId: sprintId } = await collection('sprints').insertOne({
      departmentId: asId(engineeringId),
      name: 'Sprint 7',
      goal: 'Ship the importer',
      status: 'ACTIVE',
      startDate: '2026-11-09',
      endDate: '2026-11-20',
    });
    await collection('tasks').insertMany([
      { departmentId: asId(engineeringId), sprintId, status: 'TODO', number: 1 },
      { departmentId: asId(engineeringId), sprintId, status: 'IN_PROGRESS', number: 2 },
      { departmentId: asId(engineeringId), sprintId, status: 'DONE', number: 3 },
      { departmentId: asId(engineeringId), sprintId: null, status: 'TODO', number: 4 },
    ]);
    await collection('leaverequests').insertOne({
      employeeId: asId(rahulSharma.profileId),
      status: 'PENDING',
      pendingChange: null,
    });
    await collection('leaverequests').insertOne({
      employeeId: asId(rahulVerma.profileId),
      status: 'PENDING',
      pendingChange: null,
    });
    await collection('regularizationreviews').insertOne({
      employeeId: asId(plain.profileId),
      status: 'Pending',
      idempotencyKey: 'review-eng',
    });
    // Finance's pending review must not count for Engineering.
    await collection('regularizationreviews').insertOne({
      employeeId: asId(rahulVerma.profileId),
      status: 'Pending',
      idempotencyKey: 'review-fin',
    });
  });

  beforeEach(() => {
    standIn.turns.length = 0;
  });

  after(async () => {
    await testServer?.stop();
    await standIn?.close();
  });

  it('offers people tools to roles with the capability and to department heads, not to others', async () => {
    for (const client of [hr.client, finance, itAdmin, head.client]) {
      await tokenOf(client);
      assert.ok(lastTurn.allowed_intents.includes('PROFILE_LOOKUP'), lastTurn.user.name);
      assert.ok(
        PEOPLE_TOOLS.every((tool) => lastTurn.allowed_tools.includes(tool)),
        lastTurn.user.name,
      );
    }
    await tokenOf(plain.client);
    assert.equal(lastTurn.allowed_intents.includes('PROFILE_LOOKUP'), false);
    assert.equal(
      lastTurn.allowed_tools.some((tool) => PEOPLE_TOOLS.includes(tool)),
      false,
    );

    const refused = await lookup(plain.client, 'Rahul');
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error.code, 'TOOL_FORBIDDEN');
  });

  it('answers an ambiguous name with the candidates to pick from', async () => {
    const response = await lookup(hr.client, 'rahul');
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const { result, source } = response.body.data;
    assert.equal(result.matches, 2);
    assert.deepEqual(
      result.candidates.map(({ name, department }) => ({ name, department })),
      [
        { name: 'Rahul Sharma', department: 'Engineering' },
        { name: 'Rahul Verma', department: 'Finance' },
      ],
    );
    assert.match(result.candidates[0].employee_code, /^NSK\d{4}$/);
    assert.equal(result.candidates[0].phone, undefined);

    // Every word of a full name must match, so the full name finds one person.
    const fullName = (await lookup(hr.client, 'rahul sharma')).body.data.result;
    assert.equal(fullName.matches, 1);
    assert.equal(fullName.profile.name, 'Rahul Sharma');
    assert.equal(source, NSK_BOT_MESSAGES.SOURCE_LABELS.PEOPLE_SEARCH('rahul'));
  });

  it('answers a misspelled name with the closest spelling as a candidate to confirm, never the profile', async () => {
    const typo = (await lookup(hr.client, 'Rahul Shrma')).body.data.result;
    assert.equal(typo.approximate, true);
    assert.equal(typo.note, NSK_BOT_MESSAGES.PEOPLE_APPROXIMATE_NOTE('Rahul Shrma'));
    assert.deepEqual(
      typo.candidates.map((candidate) => candidate.name),
      ['Rahul Sharma'],
    );
    assert.equal(typo.profile, undefined);

    // A head's guesses stay within their departments: Rahul Verma is in Finance.
    const outside = (await lookup(head.client, 'Rahul Vrma')).body.data.result;
    assert.deepEqual(outside, { matches: 0, note: NSK_BOT_MESSAGES.PEOPLE_OUT_OF_SCOPE });
  });

  it('shows HR the full profile with the phone masked and the latest payslip, and audits the fields', async () => {
    const code = await codeOf(rahulSharma);
    const response = await lookup(hr.client, code.toLowerCase());
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const { profile } = response.body.data.result;
    assert.equal(profile.name, 'Rahul Sharma');
    assert.equal(profile.employee_code, code);
    assert.equal(profile.role, 'Employee');
    assert.equal(profile.department, 'Engineering');
    assert.equal(profile.reporting_manager.name, 'Hema Head');
    assert.match(profile.joining_date, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(profile.phone, '+••••••••••10');
    assert.ok(Array.isArray(profile.leave_balances.balances));
    assert.ok(profile.attendance_today === null || typeof profile.attendance_today.status === 'string');
    assert.equal(profile.salary.period, '2026-10');
    assert.equal(profile.salary.gross_monthly, 75000);
    assert.equal(profile.salary.net_pay_monthly, 67000);
    assert.equal(response.body.data.source, NSK_BOT_MESSAGES.SOURCE_LABELS.EMPLOYEE_PROFILE('Rahul Sharma', code));
    assert.equal(JSON.stringify(response.body).includes('9876543210'), false, 'the phone number never leaves unmasked');

    const output = await serverLogMatching(testServer, /audit nsk_bot\.nsk_people_lookup allowed.*"salary"/);
    const auditLine = output
      .split('\n')
      .findLast((line) => line.includes('nsk_people_lookup') && line.includes('"salary"'));
    assert.ok(auditLine, 'the lookup is audited');
    const audit = JSON.parse(auditLine);
    assert.deepEqual(audit.targetEmployeeIds, [rahulSharma.profileId]);
    assert.equal(audit.onBehalfOfRole, 'hr');
    assert.ok(audit.fieldsShown.includes('phone') && audit.fieldsShown.includes('salary'));
    assert.equal(auditLine.includes('75000'), false, 'the audit names fields, never their values');
  });

  it('shows finance the salary, and hides it from the IT administrator', async () => {
    const code = await codeOf(rahulSharma);
    const forFinance = (await lookup(finance, code)).body.data.result.profile;
    assert.equal(forFinance.salary.gross_monthly, 75000);

    const forIt = (await lookup(itAdmin, code)).body.data.result.profile;
    assert.deepEqual(forIt.salary, { hidden: true, note: NSK_BOT_MESSAGES.SALARY_HIDDEN });
    assert.equal(forIt.phone, '+••••••••••10');
    const output = await serverLogMatching(testServer, /"onBehalfOfRole":"it_admin"/);
    const itAudit = JSON.parse(output.split('\n').findLast((line) => line.includes('"onBehalfOfRole":"it_admin"')));
    assert.equal(itAudit.fieldsShown.includes('salary'), false);
  });

  it('keeps a department head to the departments they head', async () => {
    const byName = (await lookup(head.client, 'Rahul')).body.data.result;
    assert.equal(byName.matches, 1, 'only the Rahul in Engineering');
    assert.equal(byName.profile.name, 'Rahul Sharma');
    assert.deepEqual(byName.profile.salary, { hidden: true, note: NSK_BOT_MESSAGES.SALARY_HIDDEN });

    const elsewhere = (await lookup(head.client, await codeOf(rahulVerma))).body.data.result;
    assert.deepEqual(elsewhere, { matches: 0, note: NSK_BOT_MESSAGES.PEOPLE_OUT_OF_SCOPE });

    const ownDepartment = (await metrics(head.client)).body.data.result;
    assert.equal(ownDepartment.department.code, 'ENG');
    const otherDepartment = (await metrics(head.client, 'Finance')).body.data.result;
    assert.equal(otherDepartment.found, false);
    assert.deepEqual(otherDepartment.departments, [{ name: 'Engineering', code: 'ENG' }]);
  });

  it('gives a department’s headcount, attendance today, sprint and pending approvals', async () => {
    const response = await metrics(hr.client, 'eng');
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const { result, source } = response.body.data;
    assert.equal(result.found, true);
    assert.equal(result.headcount, 3);
    const counted = Object.values(result.attendance_today.by_status).reduce((sum, count) => sum + count, 0);
    assert.equal(counted, result.attendance_today.people_counted);
    assert.deepEqual(result.work.active_sprint.tasks, { TODO: 1, IN_PROGRESS: 1, IN_REVIEW: 0, DONE: 1 });
    assert.equal(result.work.active_sprint.name, 'Sprint 7');
    assert.equal(result.work.open_tasks, 3);
    assert.deepEqual(result.pending_approvals, { leave_requests: 1, leave_changes: 0, attendance_regularizations: 1 });
    assert.equal(source, NSK_BOT_MESSAGES.SOURCE_LABELS.DEPARTMENT_METRICS('Engineering', result.date));

    const choices = (await metrics(hr.client)).body.data.result;
    assert.equal(choices.found, false);
    assert.deepEqual(
      choices.departments.map((department) => department.code),
      ['ENG', 'FIN'],
    );
    const badArgument = await callNskTool(testServer, 'get_department_metrics', {
      actorToken: await tokenOf(hr.client),
      args: { department: 'x'.repeat(200) },
    });
    assert.equal(badArgument.status, 400);
  });

  it('stops looking up for someone who is no longer a head', async () => {
    const token = await tokenOf(head.client);
    await collection('departments').updateOne({ _id: asId(engineeringId) }, { $set: { departmentHeadId: null } });
    try {
      const refused = await callNskTool(testServer, 'lookup_employee_profile', {
        actorToken: token,
        args: { query: 'Rahul' },
      });
      assert.equal(refused.status, 403);
    } finally {
      await collection('departments').updateOne(
        { _id: asId(engineeringId) },
        { $set: { departmentHeadId: asId(head.profileId) } },
      );
    }
  });
});
