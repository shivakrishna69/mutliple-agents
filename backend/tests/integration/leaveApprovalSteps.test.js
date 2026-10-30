/**
 * Multi-level approvals against the real server: leave longer than the type's
 * usage.hrApprovalAfterDays needs the manager's approval and then HR's; the days stay held until
 * the last step and are charged only then; a rejection at either step frees them; the same person
 * never approves both steps; employees without a manager go to HR alone; the setting off (or short
 * leave) keeps one step; simultaneous decisions at one step advance it once; requests from before
 * steps existed are decided in one step.
 *
 * The office has no weekly offs, so every day costs one day, and the leave year is set so today
 * sits in its middle (as in leaveRequests.test.js).
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { EMPLOYMENT_STATUSES } from '../../models/EmployeeProfile.js';
import { addDaysToCalendarDate } from '../../utils/calendarDates.js';
import { insertDepartment, officeDocument, onboardEmployee } from './fixtures.js';
import { createSignedInClient, mongoUnavailableReason, startTestServer } from './testServer.js';

const skipReason = await mongoUnavailableReason();

const OFFICE_TIME_ZONE_OFFSET_MS = 5.5 * 60 * 60 * 1000; // Asia/Kolkata
/** Leave longer than this needs HR after the manager. */
const HR_AFTER_DAYS = 2;

describe('multi-level leave approvals', { skip: skipReason ?? false }, () => {
  let testServer;
  let hrClient;
  let secondHrClient;
  let operationsClient;
  let departmentId;
  let officeId;
  let longLeave;
  let today;
  let employeeCount = 0;
  let weeksUsed = 0;

  before(async () => {
    testServer = await startTestServer();
    hrClient = await createSignedInClient(testServer, { name: 'Hema HR', email: 'hema.hr@example.com', role: 'hr' });
    secondHrClient = await createSignedInClient(testServer, {
      name: 'Hari HR',
      email: 'hari.hr@example.com',
      role: 'hr',
    });
    operationsClient = await createSignedInClient(testServer, {
      name: 'Omar Admin',
      email: 'omar.admin@example.com',
      role: 'admin',
    });
    today = new Date(Date.now() + OFFICE_TIME_ZONE_OFFSET_MS).toISOString().slice(0, 10);
    const settings = (await expectStatus(hrClient.get('/api/leave/settings'), 200)).data.settings;
    const startMonth = ((Number(today.slice(5, 7)) - 1 + 6) % 12) + 1;
    await expectStatus(
      hrClient.patch('/api/leave/settings', { leaveYearStartMonth: startMonth, version: settings.version }),
      200,
    );
    departmentId = await insertDepartment(testServer.database);
    officeId = (
      await testServer.database
        .collection('officelocations')
        .insertOne(officeDocument('MLA', { workday: { weeklyOffRules: [] } }))
    ).insertedId;
    longLeave = (
      await expectStatus(
        hrClient.post('/api/leave/types', {
          code: 'LONG',
          name: 'Long Leave',
          isPaid: true,
          usage: { hrApprovalAfterDays: HR_AFTER_DAYS, maxBackdatedDays: 0 },
        }),
        201,
      )
    ).data.leaveType;
  });

  after(async () => {
    await testServer?.stop();
  });

  // ----------------------------------------------------------------------------------------------
  // Helpers
  // ----------------------------------------------------------------------------------------------

  const objectId = (id) => new testServer.database.base.Types.ObjectId(id);

  async function expectStatus(responsePromise, expectedStatus, expectedCode) {
    const response = await responsePromise;
    assert.equal(response.status, expectedStatus, JSON.stringify(response.body));
    if (expectedCode) assert.equal(response.body.error.code, expectedCode);
    return response.body;
  }

  /** An employee at the office, reporting to `reportsTo` (a profile id) if given, with `days` of leave. */
  async function newEmployee({ reportsTo = null, days = 10, role = null } = {}) {
    employeeCount += 1;
    const onboarded = await onboardEmployee({
      testServer,
      hrClient: operationsClient,
      email: `person${employeeCount}@example.com`,
      name: `Person ${employeeCount}`,
      departmentId,
    });
    await testServer.database.collection('employeeprofiles').updateOne(
      { _id: objectId(onboarded.profileId) },
      {
        $set: {
          'organizationData.employmentStatus': EMPLOYMENT_STATUSES.ACTIVE,
          'organizationData.officeLocationId': officeId,
          'organizationData.reportingManagerId': reportsTo ? objectId(reportsTo) : null,
        },
      },
    );
    if (days > 0) {
      await expectStatus(
        operationsClient.post('/api/leave/adjustments', {
          employeeId: onboarded.profileId,
          leaveTypeId: longLeave.id,
          reasonCode: 'ENTITLEMENT_GRANT',
          days,
          note: 'Test entitlement',
        }),
        201,
      );
    }
    if (role) {
      // An employee who is also HR (the same change scripts/setUserRole.js makes), signed in again.
      await testServer.database.collection('users').updateOne({ _id: objectId(onboarded.userId) }, { $set: { role } });
      await onboarded.client.login(`person${employeeCount}@example.com`);
    }
    return onboarded;
  }

  /** A leave of `days` days in a week no other test uses. */
  async function submitLeave(employee, days) {
    weeksUsed += 1;
    const startDate = addDaysToCalendarDate(today, 7 * weeksUsed);
    const body = await expectStatus(
      employee.client.post('/api/leave/requests', {
        leaveTypeId: longLeave.id,
        startDate,
        endDate: addDaysToCalendarDate(startDate, days - 1),
        reason: 'Family trip',
      }),
      201,
    );
    return body.data.request;
  }

  /** An approval, for the step the request was waiting on when the approver saw it (as the screen sends). */
  const approve = (client, request, step = undefined) =>
    client.post(`/api/leave/requests/${request.id}/approve`, step ? { step } : {});
  const reject = (client, request) =>
    client.post(`/api/leave/requests/${request.id}/reject`, { note: 'Team is short that week' });
  const stepsOf = (request) => request.approvalSteps.map((step) => `${step.level}:${step.status}`);

  async function balanceOf(employee) {
    const body = await expectStatus(hrClient.get(`/api/leave/employees/${employee.profileId}/balances`), 200);
    const { balanceDays, heldDays } = body.data.balances.find((balance) => balance.leaveType.code === 'LONG');
    return { balanceDays, heldDays };
  }

  async function queueIds(client) {
    return (await expectStatus(client.get('/api/leave/approvals'), 200)).data.requests.map((request) => request.id);
  }

  // ----------------------------------------------------------------------------------------------
  // Steps
  // ----------------------------------------------------------------------------------------------

  it('decides short leave in one step, as before', async () => {
    const manager = await newEmployee();
    const employee = await newEmployee({ reportsTo: manager.profileId });
    const request = await submitLeave(employee, HR_AFTER_DAYS);
    assert.deepEqual(stepsOf(request), ['MANAGER:PENDING']);
    const approved = (await expectStatus(approve(manager.client, request), 200)).data.request;
    assert.equal(approved.status, 'APPROVED');
    assert.deepEqual(stepsOf(approved), ['MANAGER:APPROVED']);
  });

  it('holds longer leave through the manager’s approval and charges it at HR’s', async () => {
    const manager = await newEmployee();
    const employee = await newEmployee({ reportsTo: manager.profileId });
    const request = await submitLeave(employee, HR_AFTER_DAYS + 1);
    assert.deepEqual(stepsOf(request), ['MANAGER:PENDING', 'HR:PENDING']);
    assert.equal(request.awaitingLevel, 'MANAGER');
    assert.ok((await queueIds(manager.client)).includes(request.id));

    const afterManager = await expectStatus(approve(manager.client, request), 200);
    assert.equal(afterManager.message, 'Approved. The request now needs HR’s approval');
    assert.equal(afterManager.data.request.status, 'PENDING');
    assert.equal(afterManager.data.request.awaitingLevel, 'HR');
    assert.deepEqual(stepsOf(afterManager.data.request), ['MANAGER:APPROVED', 'HR:PENDING']);
    assert.deepEqual(await balanceOf(employee), { balanceDays: 10, heldDays: 3 }, 'still held, not charged');
    assert.ok(!(await queueIds(manager.client)).includes(request.id), 'it has left the manager’s queue');
    assert.ok((await queueIds(hrClient)).includes(request.id));
    await expectStatus(approve(manager.client, request), 403, 'HR_APPROVAL_NEEDED');

    const approved = (await expectStatus(approve(hrClient, request), 200)).data.request;
    assert.equal(approved.status, 'APPROVED');
    assert.equal(approved.awaitingLevel, null);
    assert.deepEqual(stepsOf(approved), ['MANAGER:APPROVED', 'HR:APPROVED']);
    assert.deepEqual(await balanceOf(employee), { balanceDays: 7, heldDays: 0 });
  });

  it('frees the days when either step declines', async () => {
    const manager = await newEmployee();
    const employee = await newEmployee({ reportsTo: manager.profileId });

    const declinedByManager = await submitLeave(employee, 3);
    const first = (await expectStatus(reject(manager.client, declinedByManager), 200)).data.request;
    assert.equal(first.status, 'REJECTED');
    assert.deepEqual(stepsOf(first), ['MANAGER:REJECTED', 'HR:PENDING']);
    assert.equal(first.awaitingLevel, null);

    const declinedByHr = await submitLeave(employee, 3);
    await expectStatus(approve(manager.client, declinedByHr), 200);
    const second = (await expectStatus(reject(hrClient, declinedByHr), 200)).data.request;
    assert.equal(second.status, 'REJECTED');
    assert.deepEqual(stepsOf(second), ['MANAGER:APPROVED', 'HR:REJECTED']);
    assert.equal(second.decision.note, 'Team is short that week');
    assert.deepEqual(await balanceOf(employee), { balanceDays: 10, heldDays: 0 });
  });

  it('never lets one person approve both steps', async () => {
    // A manager who is also HR.
    const hrManager = await newEmployee({ role: 'hr' });
    const employee = await newEmployee({ reportsTo: hrManager.profileId });
    const request = await submitLeave(employee, 3);
    await expectStatus(approve(hrManager.client, request), 200);
    await expectStatus(approve(hrManager.client, request), 403, 'SAME_APPROVER_TWICE');
    await expectStatus(approve(hrClient, request), 200);

    // HR taking the manager's step leaves the HR step to someone else.
    const manager = await newEmployee();
    const other = await newEmployee({ reportsTo: manager.profileId });
    const second = await submitLeave(other, 3);
    await expectStatus(approve(hrClient, second), 200);
    await expectStatus(approve(hrClient, second), 403, 'SAME_APPROVER_TWICE');
    const approved = (await expectStatus(approve(secondHrClient, second), 200)).data.request;
    assert.equal(approved.status, 'APPROVED');
  });

  it('sends employees without a manager to HR alone, and keeps one step when the setting is off', async () => {
    const loner = await newEmployee();
    const request = await submitLeave(loner, 3);
    assert.deepEqual(stepsOf(request), ['HR:PENDING']);
    assert.equal((await expectStatus(approve(hrClient, request), 200)).data.request.status, 'APPROVED');

    await testServer.database
      .collection('leavetypes')
      .updateOne({ _id: objectId(longLeave.id) }, { $set: { 'usage.hrApprovalAfterDays': null } });
    const manager = await newEmployee();
    const employee = await newEmployee({ reportsTo: manager.profileId });
    const long = await submitLeave(employee, 5);
    assert.deepEqual(stepsOf(long), ['MANAGER:PENDING']);
    await testServer.database
      .collection('leavetypes')
      .updateOne({ _id: objectId(longLeave.id) }, { $set: { 'usage.hrApprovalAfterDays': HR_AFTER_DAYS } });
  });

  it('advances a step once when two people decide it at the same moment', async () => {
    const manager = await newEmployee();
    const employee = await newEmployee({ reportsTo: manager.profileId });
    const request = await submitLeave(employee, 3);
    // The first step: the manager and HR (who may take it) at once.
    const firstStep = await Promise.all([
      approve(manager.client, request, 'MANAGER'),
      approve(hrClient, request, 'MANAGER'),
    ]);
    assert.deepEqual(firstStep.map((attempt) => attempt.status).sort(), [200, 409]);
    assert.ok(
      ['STEP_ALREADY_DECIDED', 'REQUEST_BUSY'].includes(
        firstStep.find((attempt) => attempt.status === 409).body.error.code,
      ),
    );
    const afterFirst = (await expectStatus(hrClient.get(`/api/leave/requests/${request.id}`), 200)).data.request;
    assert.deepEqual(stepsOf(afterFirst), ['MANAGER:APPROVED', 'HR:PENDING'], 'one approval recorded');
    // The last step: two HR users at once (one of them may have taken the first step, so use two others).
    const attempts = await Promise.all([
      approve(secondHrClient, request, 'HR'),
      approve(operationsClient, request, 'HR'),
    ]);
    assert.deepEqual(attempts.map((attempt) => attempt.status).sort(), [200, 409]);
    assert.deepEqual(await balanceOf(employee), { balanceDays: 7, heldDays: 0 }, 'charged exactly once');
    const ledger = (await expectStatus(hrClient.get(`/api/leave/employees/${employee.profileId}/ledger`), 200)).data
      .entries;
    assert.equal(ledger.filter((entry) => entry.entryType === 'CONFIRM_DEBIT').length, 1);
  });

  it('decides a request from before approval steps existed in one step', async () => {
    const manager = await newEmployee();
    const employee = await newEmployee({ reportsTo: manager.profileId });
    const request = await submitLeave(employee, 3);
    await testServer.database
      .collection('leaverequests')
      .updateOne({ _id: objectId(request.id) }, { $set: { approvalSteps: [] }, $unset: { awaitingLevel: '' } });
    assert.ok((await queueIds(manager.client)).includes(request.id));
    const approved = (await expectStatus(approve(manager.client, request), 200)).data.request;
    assert.equal(approved.status, 'APPROVED');
    assert.deepEqual(approved.approvalSteps, []);
  });
});
