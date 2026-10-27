/**
 * Work calendar API (routes/workCalendarRoutes.js) against the real server: holidays and the
 * day-by-day calendar, and what employees can see. Offices are tested in offices.test.js.
 * Dates are October 2026: the 1st is a Thursday; Saturdays are the 3rd, 10th, 17th, 24th, 31st.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { insertDepartment, officeFields, onboardEmployee } from './fixtures.js';
import { createSignedInClient, mongoUnavailableReason, startTestServer } from './testServer.js';

const skipReason = await mongoUnavailableReason();

describe('work calendar', { skip: skipReason ?? false }, () => {
  let testServer;
  let hrClient;
  let employee;
  let unassignedEmployee;
  let noProfileClient;
  let bengaluruOfficeId;
  let puneOfficeId;

  before(async () => {
    testServer = await startTestServer();
    hrClient = await createSignedInClient(testServer, { name: 'Hema HR', email: 'hema.hr@example.com', role: 'hr' });
    noProfileClient = await createSignedInClient(testServer, { name: 'Nia Noprofile', email: 'nia@example.com' });
    for (const [code, assign] of [
      ['BLR', (officeId) => (bengaluruOfficeId = officeId)],
      ['PNQ', (officeId) => (puneOfficeId = officeId)],
    ]) {
      const response = await hrClient.post('/api/offices', officeFields(code));
      assert.equal(response.status, 201, JSON.stringify(response.body));
      assign(response.body.data.office.id);
    }
    const departmentId = await insertDepartment(testServer.database);
    employee = await onboardEmployee({ testServer, hrClient, email: 'esha@example.com', departmentId });
    unassignedEmployee = await onboardEmployee({ testServer, hrClient, email: 'uma@example.com', departmentId });
    const assignment = await hrClient.request('PUT', `/api/employees/${employee.profileId}/office`, {
      body: { officeLocationId: bengaluruOfficeId },
    });
    assert.equal(assignment.status, 200, JSON.stringify(assignment.body));
  });

  after(async () => {
    await testServer?.stop();
  });

  it('keeps holiday changes to HR and admins', async () => {
    const attempt = await employee.client.post('/api/work-calendar/holidays', {
      name: 'My day off',
      date: '2026-10-05',
    });
    assert.equal(attempt.status, 403);
  });

  it('manages company-wide and office holidays without clashes', async () => {
    const nationalHoliday = await hrClient.post('/api/work-calendar/holidays', {
      name: 'Gandhi Jayanti',
      date: '2026-10-02',
    });
    assert.equal(nationalHoliday.status, 201, JSON.stringify(nationalHoliday.body));
    assert.equal(nationalHoliday.body.data.holiday.appliesToAllOffices, true);

    const clash = await hrClient.post('/api/work-calendar/holidays', {
      name: 'Another name for the same day',
      date: '2026-10-02',
      officeLocationIds: [puneOfficeId],
    });
    assert.equal(clash.status, 409);
    assert.equal(clash.body.error.code, 'HOLIDAY_CLASHES');

    const puneOnly = await hrClient.post('/api/work-calendar/holidays', {
      name: 'Pune Festival',
      date: '2026-10-20',
      officeLocationIds: [puneOfficeId],
    });
    assert.equal(puneOnly.status, 201);

    const unknownOffice = await hrClient.post('/api/work-calendar/holidays', {
      name: 'Nowhere Day',
      date: '2026-10-21',
      officeLocationIds: ['64b000000000000000000099'],
    });
    assert.equal(unknownOffice.status, 404);

    const allHolidays = await hrClient.get('/api/work-calendar/holidays?year=2026');
    assert.deepEqual(
      allHolidays.body.data.holidays.map((holiday) => holiday.name),
      ['Gandhi Jayanti', 'Pune Festival'],
    );
  });

  it('shows employees only the holidays and calendar of their own office', async () => {
    const ownHolidays = await employee.client.get('/api/work-calendar/holidays?year=2026');
    assert.equal(ownHolidays.status, 200);
    assert.deepEqual(
      ownHolidays.body.data.holidays.map((holiday) => holiday.name),
      ['Gandhi Jayanti'],
    );
    const otherOffice = await employee.client.get(
      `/api/work-calendar/holidays?year=2026&officeLocationId=${puneOfficeId}`,
    );
    assert.equal(otherOffice.status, 403);

    const daysResponse = await employee.client.get('/api/work-calendar/days?from=2026-10-01&to=2026-10-04');
    assert.equal(daysResponse.status, 200);
    assert.deepEqual(
      daysResponse.body.data.days.map((day) => [day.date, day.kind, day.holidayName]),
      [
        ['2026-10-01', 'working', null],
        ['2026-10-02', 'holiday', 'Gandhi Jayanti'],
        ['2026-10-03', 'weekly_off', null],
        ['2026-10-04', 'weekly_off', null],
      ],
    );
  });

  it('tells an employee without a base office to ask HR, and refuses accounts without a profile', async () => {
    const unassigned = await unassignedEmployee.client.get('/api/work-calendar/days?from=2026-10-01&to=2026-10-04');
    assert.equal(unassigned.status, 409);
    assert.equal(unassigned.body.error.code, 'OFFICE_NOT_ASSIGNED');
    const noProfile = await noProfileClient.get('/api/work-calendar/days?from=2026-10-01&to=2026-10-04');
    assert.equal(noProfile.status, 403);
    assert.equal(noProfile.body.error.code, 'EMPLOYEES_ONLY');
  });

  it('validates calendar ranges', async () => {
    const backwards = await employee.client.get('/api/work-calendar/days?from=2026-10-10&to=2026-10-01');
    assert.equal(backwards.status, 400);
    const tooLong = await employee.client.get('/api/work-calendar/days?from=2026-01-01&to=2027-06-01');
    assert.equal(tooLong.status, 400);
  });

  it('edits and deletes holidays with version checks', async () => {
    const created = await hrClient.post('/api/work-calendar/holidays', { name: 'Diwali', date: '2026-11-08' });
    const holiday = created.body.data.holiday;

    const renamed = await hrClient.patch(`/api/work-calendar/holidays/${holiday.id}`, {
      name: 'Deepavali',
      version: holiday.version,
    });
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
    assert.equal(renamed.body.data.holiday.name, 'Deepavali');

    const stale = await hrClient.patch(`/api/work-calendar/holidays/${holiday.id}`, {
      name: 'Diwali again',
      version: holiday.version,
    });
    assert.equal(stale.status, 409);

    assert.equal((await hrClient.request('DELETE', `/api/work-calendar/holidays/${holiday.id}`)).status, 200);
    assert.equal((await hrClient.request('DELETE', `/api/work-calendar/holidays/${holiday.id}`)).status, 404);
  });
});
