/**
 * Leave requests (routes/leaveRoutes.js) against the real server: pricing with the sandwich rule
 * across two requests, the submission checks, holds and overlap under concurrency, who may decide,
 * approval at today's price, rejection, withdrawal, cancellation with border credits for the
 * neighbouring leave, change requests once leave has started, the payroll export, and the repair
 * of operations a stopped server left part-way.
 *
 * Dates are relative to today. The leave year is set to start six months before the current month,
 * so today sits in the middle of it and the suite has room on both sides whenever it runs. Each
 * scenario uses its own employee, so balances never interfere.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { EMPLOYMENT_STATUSES } from '../../models/EmployeeProfile.js';
import { addDaysToCalendarDate, weekdayOfCalendarDate } from '../../utils/calendarDates.js';
import { insertDepartment, officeDocument, onboardEmployee } from './fixtures.js';
import { createSignedInClient, mongoUnavailableReason, startTestServer } from './testServer.js';

const skipReason = await mongoUnavailableReason();

const OFFICE_TIME_ZONE_OFFSET_MS = 5.5 * 60 * 60 * 1000; // Asia/Kolkata, no daylight saving
const SATURDAY = 6;
const SUNDAY = 0;
const FRIDAY = 5;
const MONDAY = 1;

/** Today in the office's time zone. */
const officeToday = () => new Date(Date.now() + OFFICE_TIME_ZONE_OFFSET_MS).toISOString().slice(0, 10);

/** The first `weekday` on or after `fromDate`. */
function weekdayOnOrAfter(fromDate, weekday) {
  return addDaysToCalendarDate(fromDate, (weekday - weekdayOfCalendarDate(fromDate) + 7) % 7);
}

describe('leave requests', { skip: skipReason ?? false }, () => {
  let testServer;
  let hrClient;
  // Grants balances, so HR's per-user limit on leave changes is never reached.
  let operationsClient;
  let departmentId;
  let officeId;
  let manager;
  let planned;
  let lossOfPay;
  let today;
  let employeeCount = 0;

  before(async () => {
    testServer = await startTestServer();
    hrClient = await createSignedInClient(testServer, { name: 'Hema HR', email: 'hema.hr@example.com', role: 'hr' });
    operationsClient = await createSignedInClient(testServer, {
      name: 'Omar Admin',
      email: 'omar.admin@example.com',
      role: 'admin',
    });
    today = officeToday();

    // Today in the middle of the leave year (allowed until leave is first recorded).
    const settings = (await expectStatus(hrClient.get('/api/leave/settings'), 200)).data.settings;
    const startMonth = ((Number(today.slice(5, 7)) - 1 + 6) % 12) + 1;
    await expectStatus(
      hrClient.patch('/api/leave/settings', { leaveYearStartMonth: startMonth, version: settings.version }),
      200,
    );

    departmentId = await insertDepartment(testServer.database);
    const { insertedId } = await testServer.database.collection('officelocations').insertOne(
      officeDocument('BLR', {
        workday: {
          weeklyOffRules: [
            { weekday: SATURDAY, occurrencesInMonth: [] },
            { weekday: SUNDAY, occurrencesInMonth: [] },
          ],
        },
      }),
    );
    officeId = insertedId;

    const typeResponse = await expectStatus(
      hrClient.post('/api/leave/types', {
        code: 'PL',
        name: 'Planned Leave',
        isPaid: true,
        usage: {
          sandwichRule: true,
          maxBackdatedDays: 60,
          maxConsecutiveDays: 10,
          attachmentRequiredAfterDays: 5,
        },
      }),
      201,
    );
    planned = typeResponse.data.leaveType;
    const types = (await expectStatus(hrClient.get('/api/leave/types'), 200)).data.leaveTypes;
    lossOfPay = types.find((type) => type.code === 'LOP');
    manager = await newEmployee();
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

  /** An employee at the office, joined long ago, reporting to `reportsTo` (a profile id) if given. */
  async function newEmployee({ reportsTo = null, hasOffice = true } = {}) {
    employeeCount += 1;
    const onboarded = await onboardEmployee({
      testServer,
      hrClient,
      email: `person${employeeCount}@example.com`,
      name: `Person ${employeeCount}`,
      departmentId,
    });
    await testServer.database.collection('employeeprofiles').updateOne(
      { _id: objectId(onboarded.profileId) },
      {
        $set: {
          'organizationData.dateOfJoining': new Date(`${addDaysToCalendarDate(today, -800)}T00:00:00Z`),
          'organizationData.employmentStatus': EMPLOYMENT_STATUSES.ACTIVE,
          'organizationData.officeLocationId': hasOffice ? officeId : null,
          'organizationData.reportingManagerId': reportsTo ? objectId(reportsTo) : null,
        },
      },
    );
    return onboarded;
  }

  async function grant(employee, days, leaveType = planned) {
    await expectStatus(
      operationsClient.post('/api/leave/adjustments', {
        employeeId: employee.profileId,
        leaveTypeId: leaveType.id,
        reasonCode: 'ENTITLEMENT_GRANT',
        days,
        note: 'Test entitlement',
      }),
      201,
    );
  }

  async function plannedBalanceOf(employee) {
    const body = await expectStatus(hrClient.get(`/api/leave/employees/${employee.profileId}/balances`), 200);
    const { balanceDays, heldDays, availableDays, movements } = body.data.balances.find(
      (balance) => balance.leaveType.code === 'PL',
    );
    return { balanceDays, heldDays, availableDays, used: movements.used };
  }

  const requestBody = (fields) => ({ leaveTypeId: planned.id, reason: 'Family visit', ...fields });

  async function submit(employee, fields, expected = 201, code) {
    const body = await expectStatus(employee.client.post('/api/leave/requests', requestBody(fields)), expected, code);
    return body.data?.request;
  }

  const approve = (client, request, note) =>
    client.post(`/api/leave/requests/${request.id}/approve`, note ? { note } : {});

  /** A future Friday and the Monday after it, at least `weeksAhead` weeks away. */
  function futureWeekend(weeksAhead) {
    const friday = weekdayOnOrAfter(addDaysToCalendarDate(today, 7 * weeksAhead), FRIDAY);
    return { friday, monday: addDaysToCalendarDate(friday, 3) };
  }

  // ----------------------------------------------------------------------------------------------
  // Pricing and submission checks
  // ----------------------------------------------------------------------------------------------

  it('prices a leave under the office calendar, with half days and the sandwich rule', async () => {
    const employee = await newEmployee();
    const { friday, monday } = futureWeekend(2);
    const preview = async (fields, expected = 200, code) =>
      (
        await expectStatus(
          employee.client.post('/api/leave/requests/preview', { leaveTypeId: planned.id, ...fields }),
          expected,
          code,
        )
      ).data?.preview;

    const sandwiched = await preview({ startDate: friday, endDate: monday });
    assert.equal(sandwiched.totalDays, 4);
    assert.deepEqual(
      sandwiched.days.map((day) => [day.kind, day.chargedDays]),
      [
        ['working', 1],
        ['weekly_off', 1],
        ['weekly_off', 1],
        ['working', 1],
      ],
    );
    assert.equal(sandwiched.availableDays, 0);
    assert.equal(sandwiched.isCoveredByBalance, false);
    assert.equal(sandwiched.attachmentRequired, false, 'four days is within the five-day limit');

    const halfDayEdge = await preview({ startDate: friday, startDayPortion: 'second_half', endDate: monday });
    assert.equal(halfDayEdge.totalDays, 1.5, 'a half day counts as worked, so the weekend is free');

    const lossOfPayPreview = await preview({ leaveTypeId: lossOfPay.id, startDate: monday, endDate: monday });
    assert.equal(lossOfPayPreview.tracksBalance, false);
    assert.equal(lossOfPayPreview.isCoveredByBalance, true);

    const saturday = addDaysToCalendarDate(friday, 1);
    await preview({ startDate: saturday, endDate: addDaysToCalendarDate(saturday, 1) }, 422, 'NOTHING_TO_TAKE');
    await preview({ startDate: monday, endDate: friday }, 400);
    await preview({ startDate: friday, endDate: friday, startDayPortion: 'first_half' }, 400);
  });

  it('applies the policy of the type and the employee before accepting a request', async () => {
    const employee = await newEmployee();
    await grant(employee, 20);
    const { monday } = futureWeekend(3);
    const longAgo = weekdayOnOrAfter(addDaysToCalendarDate(today, -75), MONDAY);
    await submit(employee, { startDate: longAgo, endDate: longAgo }, 422, 'TOO_FAR_BACK');
    await submit(employee, { startDate: '2099-06-01', endDate: '2099-06-01' }, 422, 'OUTSIDE_LEAVE_YEAR');
    await submit(
      employee,
      { startDate: monday, endDate: addDaysToCalendarDate(monday, 14) },
      422,
      'TOO_MANY_CONSECUTIVE_DAYS',
    );
    const nextMonday = addDaysToCalendarDate(monday, 7);
    await submit(employee, { startDate: monday, endDate: nextMonday }, 422, 'ATTACHMENT_REQUIRED');
    await submit(
      employee,
      { startDate: monday, endDate: nextMonday, attachmentDocumentId: '0123456789abcdef01234567' },
      422,
      'ATTACHMENT_NOT_FOUND',
    );
    // Only the employee's own leave document counts (the check reads only these fields; the key is unique).
    const vault = testServer.database.collection('documentvaults');
    const { insertedId: ownIdDocument } = await vault.insertOne({
      employeeId: objectId(employee.profileId),
      documentType: 'Gov_ID',
      s3KeyPath: 'test/gov-id',
    });
    const { insertedId: ownLeaveDocument } = await vault.insertOne({
      employeeId: objectId(employee.profileId),
      documentType: 'Leave_Document',
      s3KeyPath: 'test/leave-document',
    });
    await submit(
      employee,
      { startDate: monday, endDate: nextMonday, attachmentDocumentId: ownIdDocument.toString() },
      422,
      'ATTACHMENT_NOT_FOUND',
    );
    const withCertificate = await submit(employee, {
      startDate: monday,
      endDate: nextMonday,
      attachmentDocumentId: ownLeaveDocument.toString(),
    });
    assert.equal(withCertificate.attachmentDocumentId, ownLeaveDocument.toString());
    await expectStatus(employee.client.post(`/api/leave/requests/${withCertificate.id}/cancel`), 200);
    await submit(employee, { startDate: monday, endDate: monday, reason: 'no' }, 400);

    const homeless = await newEmployee({ hasOffice: false });
    await submit(homeless, { startDate: monday, endDate: monday }, 422, 'OFFICE_NOT_ASSIGNED');

    const joiner = await newEmployee();
    await testServer.database
      .collection('employeeprofiles')
      .updateOne(
        { _id: objectId(joiner.profileId) },
        { $set: { 'organizationData.dateOfJoining': new Date(`${today}T00:00:00Z`) } },
      );
    const beforeJoining = addDaysToCalendarDate(today, -1);
    await submit(joiner, { startDate: beforeJoining, endDate: beforeJoining }, 422, 'BEFORE_JOINING');

    await hrClient.patch(`/api/leave/types/${lossOfPay.id}`, {
      usage: { eligibleEmploymentStatuses: ['Active'] },
      version: lossOfPay.version,
    });
    await testServer.database
      .collection('employeeprofiles')
      .updateOne(
        { _id: objectId(employee.profileId) },
        { $set: { 'organizationData.employmentStatus': EMPLOYMENT_STATUSES.NOTICE } },
      );
    await submit(employee, { leaveTypeId: lossOfPay.id, startDate: monday, endDate: monday }, 422, 'NOT_ELIGIBLE');
    const restored = (await expectStatus(hrClient.get('/api/leave/types'), 200)).data.leaveTypes.find(
      (type) => type.code === 'LOP',
    );
    await expectStatus(
      hrClient.patch(`/api/leave/types/${lossOfPay.id}`, {
        usage: { eligibleEmploymentStatuses: ['Probation', 'Active', 'Notice'] },
        version: restored.version,
      }),
      200,
    );
  });

  it('holds the days on submission and refuses overlap and overdrafts, even at the same moment', async () => {
    const employee = await newEmployee();
    await grant(employee, 3);
    const { monday } = futureWeekend(4);
    const tuesday = addDaysToCalendarDate(monday, 1);

    const attempts = await Promise.all(
      [0, 1, 2].map(() =>
        employee.client.post('/api/leave/requests', requestBody({ startDate: monday, endDate: tuesday })),
      ),
    );
    assert.deepEqual(attempts.map((attempt) => attempt.status).sort(), [201, 409, 409]);
    assert.ok(
      attempts
        .filter((attempt) => attempt.status === 409)
        .every((attempt) => attempt.body.error.code === 'OVERLAPPING_REQUEST'),
    );
    assert.deepEqual(await plannedBalanceOf(employee), { balanceDays: 3, heldDays: 2, availableDays: 1, used: 0 });

    // Two different one-day requests for the last day available: only one gets it.
    const wednesday = addDaysToCalendarDate(monday, 2);
    const thursday = addDaysToCalendarDate(monday, 3);
    const racing = await Promise.all(
      [wednesday, thursday].map((date) =>
        employee.client.post('/api/leave/requests', requestBody({ startDate: date, endDate: date })),
      ),
    );
    assert.deepEqual(racing.map((attempt) => attempt.status).sort(), [201, 422]);
    assert.equal(racing.find((attempt) => attempt.status === 422).body.error.code, 'INSUFFICIENT_BALANCE');
    assert.deepEqual(await plannedBalanceOf(employee), { balanceDays: 3, heldDays: 3, availableDays: 0, used: 0 });

    // A half day next to a half day of another request is not an overlap.
    await grant(employee, 1);
    const friday = addDaysToCalendarDate(monday, 4);
    await submit(employee, { startDate: friday, endDate: friday, endDayPortion: 'first_half' });
    await submit(employee, { startDate: friday, endDate: friday, startDayPortion: 'second_half' });
    const claims = await testServer.database
      .collection('leavedayclaims')
      .countDocuments({ employeeId: objectId(employee.profileId) });
    assert.equal(claims, 2 * 2 + 2 + 1 + 1, 'Mon-Tue full, one full day, then two halves');
  });

  // ----------------------------------------------------------------------------------------------
  // Deciding
  // ----------------------------------------------------------------------------------------------

  it('routes a request to the reporting manager, or to HR without one, and never to the employee', async () => {
    const reportee = await newEmployee({ reportsTo: manager.profileId });
    const loner = await newEmployee();
    const stranger = await newEmployee();
    await grant(reportee, 5);
    await grant(loner, 5);
    const { monday } = futureWeekend(5);

    const routed = await submit(reportee, { startDate: monday, endDate: monday });
    assert.equal(routed.approverEmployeeId, manager.profileId);
    const toHr = await submit(loner, { startDate: monday, endDate: monday });
    assert.equal(toHr.approverEmployeeId, null);

    const managerQueue = (await expectStatus(manager.client.get('/api/leave/approvals'), 200)).data.requests;
    assert.deepEqual(
      managerQueue.map((request) => request.id),
      [routed.id],
    );
    assert.equal(managerQueue[0].employee.name, `Person ${employeeCount - 2}`);
    const hrQueue = (await expectStatus(hrClient.get('/api/leave/approvals'), 200)).data.requests.map((r) => r.id);
    assert.ok(hrQueue.includes(routed.id) && hrQueue.includes(toHr.id));
    assert.deepEqual((await expectStatus(stranger.client.get('/api/leave/approvals'), 200)).data.requests, []);

    await expectStatus(stranger.client.get(`/api/leave/requests/${routed.id}`), 404, 'REQUEST_NOT_FOUND');
    await expectStatus(approve(stranger.client, routed), 403, 'NOT_APPROVER');
    await expectStatus(approve(reportee.client, routed), 403, 'SELF_DECISION');
    await expectStatus(approve(manager.client, toHr), 403, 'NOT_APPROVER');
    await expectStatus(manager.client.get(`/api/leave/requests/${routed.id}`), 200);

    const approved = (await expectStatus(approve(manager.client, routed, 'Enjoy'), 200)).data.request;
    assert.equal(approved.status, 'APPROVED');
    assert.equal(approved.decision.note, 'Enjoy');
    await expectStatus(approve(hrClient, routed), 409, 'REQUEST_NOT_PENDING');
    assert.deepEqual(await plannedBalanceOf(reportee), { balanceDays: 4, heldDays: 0, availableDays: 4, used: -1 });

    await expectStatus(hrClient.post(`/api/leave/requests/${toHr.id}/reject`, {}), 400);
    const rejected = (
      await expectStatus(hrClient.post(`/api/leave/requests/${toHr.id}/reject`, { note: 'Team offsite' }), 200)
    ).data.request;
    assert.equal(rejected.status, 'REJECTED');
    assert.deepEqual(await plannedBalanceOf(loner), { balanceDays: 5, heldDays: 0, availableDays: 5, used: 0 });
    // Rejected days are free again.
    await submit(loner, { startDate: monday, endDate: monday });
  });

  it('charges the weekend between two approved leaves at the second approval, and gives it back on cancellation', async () => {
    const employee = await newEmployee();
    await grant(employee, 2);
    const { friday, monday } = futureWeekend(6);
    const fridayLeave = await submit(employee, { startDate: friday, endDate: friday });
    const mondayLeave = await submit(employee, { startDate: monday, endDate: monday });
    assert.equal(mondayLeave.totalDays, 1, 'pending leave is not a neighbour yet');

    await expectStatus(approve(hrClient, fridayLeave), 200);
    // Approved at today's price: 1 day plus the weekend, which the balance cannot cover.
    await expectStatus(approve(hrClient, mondayLeave), 422, 'INSUFFICIENT_BALANCE');
    const stillPending = (await expectStatus(employee.client.get(`/api/leave/requests/${mondayLeave.id}`), 200)).data
      .request;
    assert.equal(stillPending.status, 'PENDING');

    await grant(employee, 2);
    const approved = (await expectStatus(approve(hrClient, mondayLeave), 200)).data.request;
    assert.equal(approved.totalDays, 3);
    assert.deepEqual(
      approved.borderCharges.map((charge) => [charge.date, charge.chargedDays, charge.neighbourRequestId]),
      [
        [addDaysToCalendarDate(friday, 1), 1, fridayLeave.id],
        [addDaysToCalendarDate(friday, 2), 1, fridayLeave.id],
      ],
    );
    assert.deepEqual(await plannedBalanceOf(employee), { balanceDays: 0, heldDays: 0, availableDays: 0, used: -4 });

    // Cancelling Friday gives back its day and Monday's border charge.
    const cancelled = (await expectStatus(employee.client.post(`/api/leave/requests/${fridayLeave.id}/cancel`), 200))
      .data.request;
    assert.equal(cancelled.status, 'CANCELLED');
    const monday2 = (await expectStatus(employee.client.get(`/api/leave/requests/${mondayLeave.id}`), 200)).data
      .request;
    assert.equal(monday2.totalDays, 1);
    assert.deepEqual(monday2.borderCharges, []);
    assert.deepEqual(await plannedBalanceOf(employee), { balanceDays: 3, heldDays: 0, availableDays: 3, used: -1 });

    const ledger = (
      await expectStatus(hrClient.get(`/api/leave/employees/${employee.profileId}/ledger`), 200)
    ).data.entries.filter((entry) => entry.reasonCode === 'CANCELLATION_CREDIT');
    assert.deepEqual(ledger.map((entry) => entry.days).sort(), [1, 2]);
  });

  it('lets the employee withdraw a pending request or cancel leave before it starts, but not after', async () => {
    const employee = await newEmployee({ reportsTo: manager.profileId });
    await grant(employee, 5);
    const { monday } = futureWeekend(7);
    const pending = await submit(employee, { startDate: monday, endDate: monday });
    await expectStatus(manager.client.post(`/api/leave/requests/${pending.id}/cancel`), 403, 'NOT_REQUESTER');
    const withdrawn = await expectStatus(employee.client.post(`/api/leave/requests/${pending.id}/cancel`), 200);
    assert.equal(withdrawn.message, 'Leave request withdrawn');
    await expectStatus(employee.client.post(`/api/leave/requests/${pending.id}/cancel`), 409, 'REQUEST_NOT_APPROVED');
    await expectStatus(approve(manager.client, pending), 409, 'REQUEST_NOT_PENDING');
    assert.deepEqual(await plannedBalanceOf(employee), { balanceDays: 5, heldDays: 0, availableDays: 5, used: 0 });

    const started = await submit(employee, { startDate: today, endDate: today });
    await expectStatus(approve(manager.client, started), 200);
    await expectStatus(employee.client.post(`/api/leave/requests/${started.id}/cancel`), 422, 'ALREADY_STARTED');

    const own = (await expectStatus(employee.client.get('/api/leave/requests?status=CANCELLED'), 200)).data.requests;
    assert.deepEqual(
      own.map((request) => request.id),
      [pending.id],
    );
    const hrView = (await expectStatus(hrClient.get(`/api/leave/employees/${employee.profileId}/requests`), 200)).data
      .requests;
    assert.equal(hrView.length, 2);
  });

  it('ends started leave early or cancels it through a change request the approver decides', async () => {
    const employee = await newEmployee({ reportsTo: manager.profileId });
    await grant(employee, 10);
    // Monday to Wednesday, two to three weeks ago: started (and over).
    const monday = weekdayOnOrAfter(addDaysToCalendarDate(today, -20), MONDAY);
    const tuesday = addDaysToCalendarDate(monday, 1);
    const wednesday = addDaysToCalendarDate(monday, 2);
    const leave = await submit(employee, { startDate: monday, endDate: wednesday });
    await expectStatus(approve(manager.client, leave), 200);
    const changePath = `/api/leave/requests/${leave.id}/change`;

    const upcomingDay = futureWeekend(8).monday;
    const upcoming = await submit(employee, { startDate: upcomingDay, endDate: upcomingDay });
    await expectStatus(approve(manager.client, upcoming), 200);
    await expectStatus(
      employee.client.post(`/api/leave/requests/${upcoming.id}/change`, { kind: 'CANCEL', reason: 'Plans changed' }),
      422,
      'NOT_STARTED',
    );

    await expectStatus(employee.client.post(changePath, { kind: 'SHORTEN', reason: 'Back early' }), 400);
    await expectStatus(
      employee.client.post(changePath, { kind: 'SHORTEN', newEndDate: wednesday, reason: 'Back early' }),
      422,
      'INVALID_SHORTEN',
    );
    const asked = (
      await expectStatus(
        employee.client.post(changePath, {
          kind: 'SHORTEN',
          newEndDate: tuesday,
          newEndDayPortion: 'first_half',
          reason: 'Back early',
        }),
        200,
      )
    ).data.request;
    assert.equal(asked.pendingChange.kind, 'SHORTEN');
    await expectStatus(
      employee.client.post(changePath, { kind: 'CANCEL', reason: 'Never went' }),
      409,
      'CHANGE_ALREADY_OPEN',
    );
    const changeQueue = (await expectStatus(manager.client.get('/api/leave/approvals?queue=changes'), 200)).data
      .requests;
    assert.deepEqual(
      changeQueue.map((request) => request.id),
      [leave.id],
    );

    const decisionPath = `${changePath}/decision`;
    await expectStatus(employee.client.post(decisionPath, { approve: true }), 403, 'SELF_DECISION');
    await expectStatus(manager.client.post(decisionPath, { approve: false }), 400);
    const shortened = (await expectStatus(manager.client.post(decisionPath, { approve: true }), 200)).data.request;
    assert.equal(shortened.endDate, tuesday);
    assert.equal(shortened.endDayPortion, 'first_half');
    assert.equal(shortened.totalDays, 1.5);
    assert.equal(shortened.pendingChange, null);
    assert.deepEqual(
      shortened.changeHistory.map((change) => [change.kind, change.isApproved, change.creditedDays]),
      [['SHORTEN', true, 1.5]],
    );
    assert.deepEqual(await plannedBalanceOf(employee), {
      balanceDays: 7.5,
      heldDays: 0,
      availableDays: 7.5,
      used: -2.5,
    });
    // The days given back are free again.
    await submit(employee, { startDate: tuesday, startDayPortion: 'second_half', endDate: wednesday });

    await expectStatus(employee.client.post(changePath, { kind: 'CANCEL', reason: 'Never went' }), 200);
    await expectStatus(hrClient.post(decisionPath, { approve: false, note: 'You were away' }), 200);
    await expectStatus(employee.client.post(changePath, { kind: 'CANCEL', reason: 'Never went, really' }), 200);
    const cancelled = (await expectStatus(hrClient.post(decisionPath, { approve: true }), 200)).data.request;
    assert.equal(cancelled.status, 'CANCELLED');
    assert.deepEqual(
      cancelled.changeHistory.map((change) => [change.kind, change.isApproved, change.creditedDays]),
      [
        ['SHORTEN', true, 1.5],
        ['CANCEL', false, 0],
        ['CANCEL', true, 1.5],
      ],
    );
    await expectStatus(hrClient.post(decisionPath, { approve: true }), 409, 'NO_CHANGE_OPEN');
    const balance = await plannedBalanceOf(employee);
    assert.equal(balance.used, -1, 'only the upcoming day remains used');
    assert.equal(balance.heldDays, 1.5, 'the new request for Tuesday afternoon and Wednesday is held');
  });

  // ----------------------------------------------------------------------------------------------
  // Payroll and repair
  // ----------------------------------------------------------------------------------------------

  it('exports unpaid and encashed days for a payroll month to HR only', async () => {
    const employee = await newEmployee();
    const { friday, monday } = futureWeekend(9);
    const unpaid = await submit(employee, { leaveTypeId: lossOfPay.id, startDate: friday, endDate: monday });
    assert.equal(unpaid.totalDays, 4, 'Loss of Pay applies the sandwich rule');
    const postedForUnpaid = await testServer.database
      .collection('leaveledgerentries')
      .countDocuments({ leaveRequestId: objectId(unpaid.id) });
    assert.equal(postedForUnpaid, 0, 'a type without a balance posts nothing');
    const beforeApproval = new Date().toISOString();
    await expectStatus(approve(hrClient, unpaid), 200);

    const monthOf = (date) => date.slice(0, 7);
    const exportOf = async (month, changedSince) => {
      const query = changedSince ? `&changedSince=${encodeURIComponent(changedSince)}` : '';
      return (await expectStatus(hrClient.get(`/api/leave/payroll-export?month=${month}${query}`), 200)).data.employees;
    };
    let exportedDays = 0;
    for (const month of new Set([monthOf(friday), monthOf(monday)])) {
      const row = (await exportOf(month)).find((candidate) => candidate.employeeId === employee.profileId);
      exportedDays += row.unpaidDays;
      assert.equal(row.encashedDays, 0);
    }
    assert.equal(exportedDays, 4, 'every charged day is counted in its own month');

    const changed = await exportOf(monthOf(monday), beforeApproval);
    assert.deepEqual(
      changed.map((row) => row.employeeId),
      [employee.profileId],
    );
    assert.deepEqual(await exportOf(monthOf(monday), new Date(Date.now() + 60_000).toISOString()), []);

    await expectStatus(employee.client.get(`/api/leave/payroll-export?month=${monthOf(monday)}`), 403);
    await expectStatus(hrClient.get('/api/leave/payroll-export?month=2026-13'), 400);
  });

  it('finishes an operation a stopped server left part-way, and cleans up after an unsaved submission', async () => {
    const employee = await newEmployee();
    await grant(employee, 5);
    const { monday } = futureWeekend(10);
    const tuesday = addDaysToCalendarDate(monday, 1);
    const pending = await submit(employee, { startDate: monday, endDate: monday });
    const longAgo = new Date(Date.now() - 60 * 60 * 1000);

    // A rejection locked and described, but never posted or committed.
    await testServer.database.collection('leaverequests').updateOne(
      { _id: objectId(pending.id) },
      {
        $set: {
          processing: {
            lockId: 'stopped-server',
            operation: 'REJECT',
            startedAt: longAgo,
            posting: {
              isDebit: false,
              fields: {
                employeeId: objectId(employee.profileId),
                leaveTypeId: objectId(planned.id),
                leaveYear: pending.leaveYear,
                leaveRequestId: objectId(pending.id),
                entryType: 'RELEASE_HOLD',
                balanceDeltaCentidays: 0,
                heldDeltaCentidays: -100,
                effectiveDate: today,
                idempotencyKey: `${pending.id}:RELEASE`,
                createdByUserId: null,
              },
            },
            result: { set: { status: 'REJECTED', hasClaimsToRelease: true }, releasesClaims: true },
          },
        },
      },
    );
    await expectStatus(approve(hrClient, pending), 409, 'REQUEST_BUSY');

    // A submission that claimed Tuesday and held it, then stopped before saving its request.
    const lostRequestId = new testServer.database.base.Types.ObjectId();
    await testServer.database.collection('leavedayclaims').insertMany(
      ['FIRST', 'SECOND'].map((half) => ({
        employeeId: objectId(employee.profileId),
        date: tuesday,
        half,
        leaveRequestId: lostRequestId,
        createdAt: longAgo,
      })),
    );
    await testServer.database.collection('leaveledgerentries').insertOne({
      employeeId: objectId(employee.profileId),
      leaveTypeId: objectId(planned.id),
      leaveYear: pending.leaveYear,
      entryType: 'HOLD',
      reasonCode: null,
      balanceDeltaCentidays: 0,
      heldDeltaCentidays: 100,
      effectiveDate: today,
      accrualPeriod: null,
      payrollReference: null,
      payrollMonth: null,
      yearEndKind: null,
      note: null,
      createdByUserId: null,
      leaveRequestId: lostRequestId,
      idempotencyKey: `${lostRequestId}:HOLD`,
      createdAt: longAgo,
    });
    await submit(employee, { startDate: tuesday, endDate: tuesday }, 409, 'OVERLAPPING_REQUEST');

    const summary = (await expectStatus(operationsClient.post('/api/leave/jobs/reconcile', {}), 200)).data.summary;
    assert.equal(summary.requests.operationsCompleted, 1);
    assert.equal(summary.requests.orphanClaimsDeleted, 2);
    assert.equal(summary.requests.orphanHoldsReleased, 1);
    const repaired = (await expectStatus(employee.client.get(`/api/leave/requests/${pending.id}`), 200)).data.request;
    assert.equal(repaired.status, 'REJECTED');
    assert.equal(repaired.isBeingUpdated, false);
    assert.deepEqual(await plannedBalanceOf(employee), { balanceDays: 5, heldDays: 0, availableDays: 5, used: 0 });
    await submit(employee, { startDate: monday, endDate: tuesday });

    const again = (await expectStatus(operationsClient.post('/api/leave/jobs/reconcile', {}), 200)).data.summary;
    assert.ok(
      Object.values(again.requests).every((count) => count === 0),
      JSON.stringify(again.requests),
    );
    assert.deepEqual([again.balances.abandonedReversed, again.balances.totalsCorrected], [0, 0]);
  });
});
