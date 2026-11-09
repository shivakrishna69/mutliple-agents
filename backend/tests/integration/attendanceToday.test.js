/**
 * Who is working today (routes/attendanceRoutes.js GET /today and /me/today) against the real server:
 * each status, who sees whom (a team lead their team, HR everyone or one department, anyone else
 * nobody), and an employee's own day for their punch screen.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { insertDepartment, officeFields, onboardEmployee } from './fixtures.js';
import { createSignedInClient, mongoUnavailableReason, startTestServer } from './testServer.js';

const skipReason = await mongoUnavailableReason();

const OFFICE_CENTRE = Object.freeze({ lat: 12.97, lng: 77.59 });
const AWAY_FROM_OFFICE = Object.freeze({ lat: 12.99, lng: 77.6 });
const punchAt = (point, extra = {}) => ({
  ...point,
  accuracyMeters: 12,
  deviceFingerprint: 'test-device-fingerprint-0001',
  ...extra,
});
const todayInBengaluru = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
const HOLIDAY_DATE = '2026-12-25';

describe('today’s attendance', { skip: skipReason ?? false }, () => {
  let testServer;
  let hrClient;
  let operationsId;
  let financeId;
  let manager;
  let team;
  let outsider;

  before(async () => {
    testServer = await startTestServer();
    hrClient = await createSignedInClient(testServer, { name: 'Hema HR', email: 'hema.hr@example.com', role: 'hr' });
    operationsId = await insertDepartment(testServer.database);
    financeId = await insertDepartment(testServer.database, { name: 'Finance', code: 'FIN', budgetCode: 'CC-500' });
    // No weekly offs, so every day the tests run on is a working day.
    const office = (
      await hrClient.post(
        '/api/offices',
        officeFields('BLR', { coordinates: OFFICE_CENTRE, workday: { weeklyOffRules: [] } }),
      )
    ).body.data.office;
    await hrClient.post('/api/work-calendar/holidays', {
      name: 'Christmas',
      date: HOLIDAY_DATE,
      officeLocationIds: [],
    });

    const onboard = async (email, name, options = {}) => {
      const person = await onboardEmployee({
        testServer,
        hrClient,
        email,
        name,
        departmentId: operationsId,
        ...options,
      });
      if (options.withoutOffice) return person;
      await hrClient.request('PUT', `/api/employees/${person.profileId}/office`, {
        body: { officeLocationId: office.id },
      });
      return person;
    };
    manager = await onboard('lead@example.com', 'Lata Lead');
    const reportsTo = { reportingManagerId: manager.profileId };
    team = {
      atOffice: await onboard('arun@example.com', 'Arun Office', reportsTo),
      onDuty: await onboard('bina@example.com', 'Bina Duty', reportsTo),
      onLeave: await onboard('chitra@example.com', 'Chitra Leave', reportsTo),
      notIn: await onboard('dev@example.com', 'Dev Notin', reportsTo),
      noOffice: await onboard('esha@example.com', 'Esha Nooffice', { ...reportsTo, withoutOffice: true }),
    };
    outsider = await onboard('farah@example.com', 'Farah Finance', { departmentId: financeId });
    // Invited, not joined yet: nobody's board shows them.
    await hrClient.post('/api/people/invitations', {
      name: 'Gopal Invited',
      email: 'gopal@example.com',
      role: 'employee',
      designation: 'Analyst',
      departmentId: operationsId,
      reportingManagerId: manager.profileId,
      workLocationType: 'Onsite',
      dateOfJoining: new Date().toISOString().slice(0, 10),
      employmentStatus: 'Active',
    });

    assert.equal((await team.atOffice.client.post('/api/attendance/punch-in', punchAt(OFFICE_CENTRE))).status, 201);
    const duty = await team.onDuty.client.post(
      '/api/attendance/punch-in',
      punchAt(AWAY_FROM_OFFICE, { workMode: 'on_duty', onDutyReason: 'Client site, Whitefield' }),
    );
    assert.equal(duty.status, 201, JSON.stringify(duty.body));
    assert.equal((await team.onDuty.client.post('/api/attendance/punch-out', punchAt(AWAY_FROM_OFFICE))).status, 200);

    // Chitra's approved leave today, written as the leave system stores it.
    const { ObjectId } = testServer.database.base.Types;
    const leaveRequestId = new ObjectId();
    await testServer.database.collection('leaverequests').insertOne({ _id: leaveRequestId, status: 'APPROVED' });
    await testServer.database.collection('leavedayclaims').insertMany(
      ['FIRST', 'SECOND'].map((half) => ({
        employeeId: new ObjectId(team.onLeave.profileId),
        date: todayInBengaluru(),
        half,
        leaveRequestId,
      })),
    );
  });

  after(async () => {
    await testServer?.stop();
  });

  const byName = (people) => Object.fromEntries(people.map((person) => [person.name, person]));

  it('shows a team lead their team’s day, and nobody else', async () => {
    const response = await manager.client.get('/api/attendance/today');
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const { scope, people, counts } = response.body.data;
    assert.equal(scope, 'direct_reports');
    const board = byName(people);
    assert.deepEqual(Object.keys(board).sort(), [
      'Arun Office',
      'Bina Duty',
      'Chitra Leave',
      'Dev Notin',
      'Esha Nooffice',
    ]);

    assert.equal(board['Arun Office'].status, 'in');
    assert.equal(board['Arun Office'].punch.workMode, 'office');
    assert.match(board['Arun Office'].employeeCode, /^NSK\d{4}$/);
    assert.equal(board['Arun Office'].department.name, 'Operations');
    assert.equal(board['Bina Duty'].status, 'out');
    assert.equal(board['Bina Duty'].punch.onDutyReason, 'Client site, Whitefield');
    assert.equal(board['Bina Duty'].punch.workedMinutes, 0);
    assert.equal(board['Chitra Leave'].status, 'on_leave');
    assert.deepEqual(board['Chitra Leave'].leave, { half: 'FULL' });
    assert.equal(board['Dev Notin'].status, 'not_in');
    assert.equal(board['Dev Notin'].punch, null);
    assert.equal(board['Esha Nooffice'].status, 'no_office');
    assert.equal(board['Arun Office'].date, todayInBengaluru());
    assert.equal('checkInCoordinates' in board['Arun Office'].punch, false, 'no coordinates on the board');

    assert.equal(counts.in, 1);
    assert.equal(counts.out, 1);
    assert.equal(counts.on_leave, 1);
    assert.equal(counts.onDuty, 1);
  });

  it('shows HR everyone, or one department', async () => {
    const everyone = byName((await hrClient.get('/api/attendance/today')).body.data.people);
    assert.ok(everyone['Farah Finance'] && everyone['Lata Lead'] && everyone['Arun Office']);
    assert.equal(everyone['Gopal Invited'], undefined, 'invited people who have not joined are left out');

    const finance = await hrClient.get(`/api/attendance/today?departmentId=${financeId}`);
    assert.equal(finance.body.data.scope, 'organisation');
    assert.deepEqual(
      finance.body.data.people.map((person) => person.name),
      ['Farah Finance'],
    );
  });

  it('shows a holiday on the date asked for', async () => {
    const response = await hrClient.get(`/api/attendance/today?date=${HOLIDAY_DATE}`);
    assert.equal(response.status, 200);
    const board = byName(response.body.data.people);
    assert.equal(response.body.data.date, HOLIDAY_DATE);
    assert.equal(board['Dev Notin'].status, 'holiday');
    assert.equal(board['Dev Notin'].holidayName, 'Christmas');
    assert.equal(board['Esha Nooffice'].status, 'no_office');
  });

  it('refuses the board to people without a team, and bad queries', async () => {
    const refused = await outsider.client.get('/api/attendance/today');
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error.code, 'TODAY_FORBIDDEN');
    assert.equal((await hrClient.get('/api/attendance/today?date=2026-02-30')).status, 400);
    assert.equal((await hrClient.get('/api/attendance/today?departmentId=finance')).status, 400);
  });

  it('gives an employee their own day for the punch screen', async () => {
    const response = await team.atOffice.client.get('/api/attendance/me/today');
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const { day } = response.body.data;
    assert.equal(day.status, 'in');
    assert.equal(day.date, todayInBengaluru());
    assert.deepEqual(day.allowedWorkModes, ['office', 'on_duty']);
    assert.equal(day.defaultWorkMode, 'office');
    assert.equal(day.office.geofenceRadiusMeters, 200);
    assert.equal(day.office.shiftEndLocalTime, '18:30');
    assert.ok(day.automaticPunchOutAt, 'an open punch says when it would close on its own');

    const closedDay = (await team.onDuty.client.get('/api/attendance/me/today')).body.data.day;
    assert.equal(closedDay.status, 'out');
    assert.equal(closedDay.automaticPunchOutAt, null);

    const noProfile = await hrClient.get('/api/attendance/me/today');
    assert.equal(noProfile.status, 404);
    assert.equal(noProfile.body.error.code, 'PROFILE_NOT_FOUND');
  });
});
