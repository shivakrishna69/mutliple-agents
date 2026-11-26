/**
 * The daily briefing (GET /api/insights/daily-briefing) against the real server, with the in-memory
 * cache:
 *   - a manager sees a direct report's pending leave with the balance left, the days taken this year
 *     and a teammate's overlapping leave as a compact range; approving it clears the card at once
 *     (the cache is invalidated, not left to run out);
 *   - an employee who submits a task sees what follows it as "up next", without waiting for the
 *     review; the board's lead sees the review, with what the employee moved on to;
 *   - asking for changes puts an urgent revision card first in the employee's briefing;
 *   - overdue and due-today tasks; tasks without dates are never overdue;
 *   - operations counts only for the roles that handle them; someone with nothing waiting is told so;
 *   - the people a change touches are told over Socket.IO (INSIGHTS_CHANGED) to fetch it again.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { io } from 'socket.io-client';

import { EMPLOYMENT_STATUSES } from '../../models/EmployeeProfile.js';
import { addDaysToCalendarDate, weekdayOfCalendarDate } from '../../utils/calendarDates.js';
import { insertDepartment, officeDocument, onboardEmployee } from './fixtures.js';
import { TEST_APP_ORIGIN, createSignedInClient, mongoUnavailableReason, startTestServer } from './testServer.js';

const mongoReason = await mongoUnavailableReason();
const OFFICE_TIME_ZONE_OFFSET_MS = 5.5 * 60 * 60 * 1000; // Asia/Kolkata, the company's time zone
const SATURDAY = 6;
const SUNDAY = 0;
const MONDAY = 1;
const officeToday = () => new Date(Date.now() + OFFICE_TIME_ZONE_OFFSET_MS).toISOString().slice(0, 10);
const weekdayOnOrAfter = (fromDate, weekday) =>
  addDaysToCalendarDate(fromDate, (weekday - weekdayOfCalendarDate(fromDate) + 7) % 7);
const DAY_MONTH = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const dayMonth = (calendarDate) => DAY_MONTH.format(new Date(`${calendarDate}T00:00:00Z`));

describe('daily briefing', { skip: mongoReason ?? false }, () => {
  let testServer;
  let hr;
  let admin;
  let departmentId;
  let officeId;
  let planned;
  let manager;
  let applicant;
  let teammate;
  let developer;
  let today;

  const asId = (id) => new testServer.database.base.Types.ObjectId(id);
  const briefingOf = async (client) => {
    const response = await client.get('/api/insights/daily-briefing');
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body.data.briefing;
  };
  const cardsOf = (briefing, kind) => briefing.cards.filter((card) => card.kind === kind);

  async function expectStatus(responsePromise, expectedStatus) {
    const response = await responsePromise;
    assert.equal(response.status, expectedStatus, JSON.stringify(response.body));
    return response.body;
  }

  async function newEmployee(email, name, { reportsTo = null } = {}) {
    const onboarded = await onboardEmployee({ testServer, hrClient: hr, email, name, departmentId });
    await testServer.database.collection('employeeprofiles').updateOne(
      { _id: asId(onboarded.profileId) },
      {
        $set: {
          'organizationData.dateOfJoining': new Date(`${addDaysToCalendarDate(today, -800)}T00:00:00Z`),
          'organizationData.employmentStatus': EMPLOYMENT_STATUSES.ACTIVE,
          'organizationData.officeLocationId': officeId,
          'organizationData.reportingManagerId': reportsTo ? asId(reportsTo) : null,
        },
      },
    );
    return onboarded;
  }

  const grant = (employee, days) =>
    expectStatus(
      admin.post('/api/leave/adjustments', {
        employeeId: employee.profileId,
        leaveTypeId: planned.id,
        reasonCode: 'ENTITLEMENT_GRANT',
        days,
        note: 'Test entitlement',
      }),
      201,
    );

  const submitLeave = async (employee, startDate, endDate) =>
    (
      await expectStatus(
        employee.client.post('/api/leave/requests', {
          leaveTypeId: planned.id,
          reason: 'Family visit',
          startDate,
          endDate,
        }),
        201,
      )
    ).data.request;

  before(async () => {
    testServer = await startTestServer({ mail: false, environment: { LOG_LEVEL: 'warn' } });
    hr = await createSignedInClient(testServer, { name: 'Hema HR', email: 'hema.hr@example.com', role: 'hr' });
    admin = await createSignedInClient(testServer, {
      name: 'Ada Admin',
      email: 'ada.admin@example.com',
      role: 'admin',
    });
    today = officeToday();

    // Today in the middle of the leave year.
    const settings = (await expectStatus(hr.get('/api/leave/settings'), 200)).data.settings;
    const startMonth = ((Number(today.slice(5, 7)) - 1 + 6) % 12) + 1;
    await expectStatus(
      hr.patch('/api/leave/settings', { leaveYearStartMonth: startMonth, version: settings.version }),
      200,
    );

    departmentId = await insertDepartment(testServer.database, {
      name: 'Engineering',
      code: 'ENG',
      budgetCode: 'CC-1',
    });
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
    planned = (
      await expectStatus(
        hr.post('/api/leave/types', {
          code: 'PL',
          name: 'Planned Leave',
          isPaid: true,
          usage: { maxConsecutiveDays: 10 },
        }),
        201,
      )
    ).data.leaveType;

    manager = await newEmployee('mira.manager@example.com', 'Mira Manager');
    applicant = await newEmployee('shiva.krishna@example.com', 'Shiva Krishna', { reportsTo: manager.profileId });
    teammate = await newEmployee('naren.team@example.com', 'Naren Team', { reportsTo: manager.profileId });
    developer = await newEmployee('dia.dev@example.com', 'Dia Developer', { reportsTo: manager.profileId });
    await grant(applicant, 12);
    await grant(teammate, 12);
    await testServer.database
      .collection('departments')
      .updateOne({ _id: asId(departmentId) }, { $set: { departmentHeadId: asId(manager.profileId) } });
  });

  after(async () => {
    await testServer?.stop();
  });

  it('tells someone with nothing waiting that all is clear', async () => {
    const briefing = await briefingOf(teammate.client);
    assert.equal(briefing.headline, 'Nothing needs you right now');
    assert.deepEqual(briefing.cards, []);
    assert.deepEqual([briefing.counts.total, briefing.counts.urgent], [0, 0]);
    assert.equal(briefing.today, today);
  });

  it("shows a manager a report's leave with the balance, leave taken and the team's overlap, and clears it once decided", async () => {
    const monday = weekdayOnOrAfter(addDaysToCalendarDate(today, 21), MONDAY);
    const wednesday = addDaysToCalendarDate(monday, 2);
    const thursday = addDaysToCalendarDate(monday, 3);
    // The teammate is already off Tuesday to Thursday that week.
    const teammateLeave = await submitLeave(teammate, addDaysToCalendarDate(monday, 1), thursday);
    await expectStatus(manager.client.post(`/api/leave/requests/${teammateLeave.id}/approve`, {}), 200);

    // Warm the manager's cache first, so the new request must invalidate it to show up.
    assert.equal(cardsOf(await briefingOf(manager.client), 'LEAVE_APPROVAL').length, 0);
    const request = await submitLeave(applicant, monday, wednesday);

    const briefing = await briefingOf(manager.client);
    const [card] = cardsOf(briefing, 'LEAVE_APPROVAL');
    assert.ok(card, JSON.stringify(briefing.cards));
    assert.equal(card.title, 'Leave request: Shiva Krishna');
    assert.equal(card.body, `${dayMonth(monday)} – ${dayMonth(wednesday)} (3 days) · Planned Leave`);
    assert.ok(card.facts.includes('Balance: 9 days left · 0 taken this year'), JSON.stringify(card.facts));
    assert.ok(
      card.facts.includes(
        `Team overlap: Naren Team: ${dayMonth(addDaysToCalendarDate(monday, 1))} – ${dayMonth(thursday)}`,
      ),
      JSON.stringify(card.facts),
    );
    assert.deepEqual(
      card.actions.map((action) => [action.kind, action.label]),
      [
        ['APPROVE_LEAVE', 'Approve'],
        ['DECLINE_LEAVE', 'Decline'],
        ['ASK_NSK', 'Ask NSK'],
      ],
    );
    assert.equal(card.actions[0].requestId, request.id);
    assert.equal(card.actions[0].step, 'MANAGER');
    assert.match(card.actions[2].prompt, /Shiva Krishna's Planned Leave/);
    assert.match(briefing.headline, /1 leave request to approve/);

    // HR sees it too; the applicant and the teammate do not.
    assert.equal(cardsOf(await briefingOf(hr), 'LEAVE_APPROVAL').length, 1);
    assert.equal(cardsOf(await briefingOf(applicant.client), 'LEAVE_APPROVAL').length, 0);

    await expectStatus(manager.client.post(`/api/leave/requests/${request.id}/approve`, {}), 200);
    assert.equal(cardsOf(await briefingOf(manager.client), 'LEAVE_APPROVAL').length, 0, 'gone at once');
  });

  let designId;
  let buildId;

  it('shows the next step at once when work is submitted, and the review to the lead', async () => {
    const tasks = `/api/departments/${departmentId}/tasks`;
    const yesterday = addDaysToCalendarDate(today, -1);
    designId = (
      await expectStatus(
        developer.client.post(tasks, {
          title: 'Design the HR portal',
          assigneeId: developer.userId,
          dueDate: yesterday,
        }),
        201,
      )
    ).data.task.id;
    buildId = (
      await expectStatus(
        developer.client.post(tasks, {
          title: 'Frontend development',
          assigneeId: developer.userId,
          dependsOnTaskId: designId,
          startDate: today,
          dueDate: addDaysToCalendarDate(today, 4),
        }),
        201,
      )
    ).data.task.id;
    await expectStatus(developer.client.post(tasks, { title: 'Old backlog task', assigneeId: developer.userId }), 201);
    await expectStatus(
      developer.client.post(tasks, {
        title: 'Fix the login bug',
        assigneeId: developer.userId,
        priority: 'URGENT',
        dueDate: today,
      }),
      201,
    );

    let briefing = await briefingOf(developer.client);
    assert.deepEqual(
      cardsOf(briefing, 'TASK_OVERDUE').map((card) => card.title),
      [`Overdue: ENG-1 Design the HR portal`],
      'the task without a date is never overdue',
    );
    assert.deepEqual(
      cardsOf(briefing, 'TASK_DUE_TODAY').map((card) => card.title),
      ['ENG-4 Fix the login bug'],
    );
    assert.equal(cardsOf(briefing, 'TASK_UP_NEXT').length, 0, 'not yet: the design is not submitted');

    const versionOf = async (taskId) => (await developer.client.get(`${tasks}/${taskId}`)).body.data.task.version;
    await expectStatus(
      developer.client.patch(`${tasks}/${designId}`, { status: 'IN_REVIEW', version: await versionOf(designId) }),
      200,
    );

    briefing = await briefingOf(developer.client);
    const [upNext] = cardsOf(briefing, 'TASK_UP_NEXT');
    assert.equal(upNext.title, 'Up next: Frontend development');
    assert.match(upNext.body, /ENG-1 "Design the HR portal" is with the reviewers/);
    assert.ok(upNext.facts.includes(`Due ${dayMonth(addDaysToCalendarDate(today, 4))}`));
    assert.deepEqual(upNext.actions[0], {
      kind: 'OPEN_TASK',
      label: 'View in Department Board',
      path: `/boards/${departmentId}?task=${buildId}`,
    });
    assert.equal(cardsOf(briefing, 'TASK_OVERDUE').length, 1, 'in review but still not done');

    // The lead (the department head) sees the review; the developer moved on to the next step.
    await expectStatus(
      developer.client.patch(`${tasks}/${buildId}`, { status: 'IN_PROGRESS', version: await versionOf(buildId) }),
      200,
    );
    const [review] = cardsOf(await briefingOf(manager.client), 'TASK_REVIEW');
    assert.equal(review.title, 'Dia Developer submitted "Design the HR portal" for review');
    assert.equal(review.body, 'and moved on to "Frontend development"');
    assert.deepEqual(
      review.actions.map((action) => action.kind),
      ['REVIEW_TASK'],
    );
    assert.equal(cardsOf(await briefingOf(developer.client), 'TASK_UP_NEXT').length, 0, 'started: no longer up next');
  });

  it('puts a requested revision first, urgent, and takes the review off the lead', async () => {
    const tasks = `/api/departments/${departmentId}/tasks`;
    const { version } = (await manager.client.get(`${tasks}/${designId}`)).body.data.task;
    await expectStatus(
      manager.client.post(`${tasks}/${designId}/review`, {
        decision: 'REQUEST_CHANGES',
        note: 'Use the brand colours on the header',
        version,
      }),
      200,
    );
    const briefing = await briefingOf(developer.client);
    const [first] = briefing.cards;
    assert.equal(first.kind, 'TASK_REVISION');
    assert.equal(first.severity, 'urgent');
    assert.equal(first.title, 'Revision requested: ENG-1 Design the HR portal');
    assert.equal(first.body, 'Use the brand colours on the header');
    assert.ok(first.facts.includes('Requested by Mira Manager'));
    assert.match(briefing.headline, /^1 revision needed/);
    assert.ok(briefing.counts.urgent >= 1);
    assert.equal(cardsOf(await briefingOf(manager.client), 'TASK_REVIEW').length, 0);
  });

  it('gives operations counts only to the roles that handle them', async () => {
    const now = new Date();
    await testServer.database.collection('conversations').insertOne({
      customerId: asId(teammate.userId),
      status: 'escalated-to-human',
      assignedAgentId: null,
      currentActiveWorker: 'human',
      createdAt: now,
      updatedAt: now,
    });
    // A fresh admin account, so no earlier briefing of theirs is cached.
    const otherAdmin = await createSignedInClient(testServer, {
      name: 'Omar Admin',
      email: 'omar.admin@example.com',
      role: 'admin',
    });
    const [support] = cardsOf(await briefingOf(otherAdmin), 'SUPPORT_WAITING');
    assert.equal(support.title, '1 support chat is waiting for an agent');
    assert.deepEqual(support.actions[0], { kind: 'OPEN_PAGE', label: 'Open', path: '/console' });
    assert.equal(cardsOf(await briefingOf(developer.client), 'SUPPORT_WAITING').length, 0);
  });

  it('tells the people a change touches to fetch their briefing again', async () => {
    const socket = io(testServer.baseUrl, {
      transports: ['websocket'],
      extraHeaders: { Origin: TEST_APP_ORIGIN, Cookie: manager.client.cookieHeader() },
    });
    try {
      await new Promise((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('connect_error', reject);
      });
      const changed = new Promise((resolve) => socket.once('INSIGHTS_CHANGED', resolve));
      const friday = weekdayOnOrAfter(addDaysToCalendarDate(today, 35), 5);
      await submitLeave(applicant, friday, friday);
      const event = await changed;
      assert.ok(Date.parse(event.at) > 0);
    } finally {
      socket.disconnect();
    }
  });

  it('is for signed-in people only, and never cached by the browser', async () => {
    const anonymous = testServer.createClient();
    assert.equal((await anonymous.get('/api/insights/daily-briefing')).status, 401);
    const response = await developer.client.send('GET', '/api/insights/daily-briefing');
    assert.equal(response.headers.get('cache-control'), 'no-store');
  });
});
