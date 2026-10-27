/**
 * Work calendar API (routes/workCalendarRoutes.js) against the real server: the weekly-off
 * migration, HR changes to weekly offs and holidays, and what employees can see.
 * Dates are October 2026: the 1st is a Thursday; Saturdays are the 3rd, 10th, 17th, 24th, 31st.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { EMPLOYMENT_STATUSES, WORK_LOCATION_TYPES } from '../../models/EmployeeProfile.js';
import { WEEKDAYS } from '../../models/OfficeLocation.js';
import { createSignedInClient, mongoUnavailableReason, startTestServer, STRONG_PASSWORD } from './testServer.js';

const skipReason = await mongoUnavailableReason();

function officeDocument(code, extraWorkday = {}) {
  return {
    name: `${code} Office`,
    code,
    coordinates: { lat: 12.97, lng: 77.59 },
    timeZone: 'Asia/Kolkata',
    workday: {
      shiftStartLocalTime: '09:30',
      shiftEndLocalTime: '18:30',
      lateGraceMinutes: 15,
      halfDayAfterMinutes: 240,
      ...extraWorkday,
    },
    createdAt: new Date(),
    updatedAt: new Date(),
    __v: 0,
  };
}

describe('work calendar', { skip: skipReason ?? false }, () => {
  let testServer;
  let hrClient;
  let employeeClient;
  let noProfileClient;
  let bengaluruOfficeId;
  let puneOfficeId;
  let customRulesOfficeId;

  before(async () => {
    testServer = await startTestServer({
      // Offices created before weekly offs existed (no rules) and one where HR already chose none.
      seedBeforeStart: async (database) => {
        const offices = database.collection('officelocations');
        bengaluruOfficeId = (await offices.insertOne(officeDocument('BLR'))).insertedId.toString();
        puneOfficeId = (await offices.insertOne(officeDocument('PNQ'))).insertedId.toString();
        customRulesOfficeId = (
          await offices.insertOne(officeDocument('SHIFT', { weeklyOffRules: [] }))
        ).insertedId.toString();
      },
    });
    const { insertedId: departmentId } = await testServer.database.collection('departments').insertOne({
      name: 'Operations',
      code: 'OPS',
      budgetCode: 'CC-400',
      departmentHeadId: null,
      parentDepartmentId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    hrClient = await createSignedInClient(testServer, { name: 'Hema HR', email: 'hema.hr@example.com', role: 'hr' });
    noProfileClient = await createSignedInClient(testServer, { name: 'Nia Noprofile', email: 'nia@example.com' });

    const invitationResponse = await hrClient.post('/api/people/invitations', {
      name: 'Esha Employee',
      email: 'esha@example.com',
      role: 'customer',
      designation: 'Analyst',
      departmentId: departmentId.toString(),
      workLocationType: WORK_LOCATION_TYPES.ONSITE,
      dateOfJoining: new Date().toISOString().slice(0, 10),
      employmentStatus: EMPLOYMENT_STATUSES.ACTIVE,
    });
    assert.equal(invitationResponse.status, 201, JSON.stringify(invitationResponse.body));
    const token = new URL(invitationResponse.body.data.delivery.inviteUrl).pathname.split('/').pop();
    employeeClient = testServer.createClient();
    const acceptResponse = await employeeClient.post(`/api/invitations/${token}/accept`, { password: STRONG_PASSWORD });
    assert.equal(acceptResponse.status, 201, JSON.stringify(acceptResponse.body));
    // Assign the employee's base office (HR does this in the profile; there is no endpoint yet).
    await testServer.database
      .collection('employeeprofiles')
      .updateOne(
        { userId: new testServer.database.base.Types.ObjectId(acceptResponse.body.data.user.id) },
        {
          $set: { 'organizationData.officeLocationId': new testServer.database.base.Types.ObjectId(bengaluruOfficeId) },
        },
      );
  });

  after(async () => {
    await testServer?.stop();
  });

  async function officeById(officeId) {
    const response = await hrClient.get('/api/work-calendar/offices');
    assert.equal(response.status, 200);
    return response.body.data.offices.find((office) => office.id === officeId);
  }

  it('gives existing offices Saturday and Sunday off at startup, keeping rules HR already set', async () => {
    const bengaluru = await officeById(bengaluruOfficeId);
    assert.deepEqual(
      bengaluru.weeklyOffRules.map((rule) => rule.weekday).sort(),
      [WEEKDAYS.SUNDAY, WEEKDAYS.SATURDAY].sort(),
    );
    assert.deepEqual((await officeById(customRulesOfficeId)).weeklyOffRules, []);
  });

  it('keeps calendar changes to HR and admins', async () => {
    assert.equal((await employeeClient.get('/api/work-calendar/offices')).status, 403);
    const attempt = await employeeClient.post('/api/work-calendar/holidays', {
      name: 'My day off',
      date: '2026-10-05',
    });
    assert.equal(attempt.status, 403);
  });

  it('lets HR switch an office to 2nd and 4th Saturdays, refusing stale edits', async () => {
    const pune = await officeById(puneOfficeId);
    const newRules = [
      { weekday: WEEKDAYS.SUNDAY, occurrencesInMonth: [] },
      { weekday: WEEKDAYS.SATURDAY, occurrencesInMonth: [4, 2] },
    ];
    const updateResponse = await hrClient.patch(`/api/work-calendar/offices/${puneOfficeId}/weekly-offs`, {
      weeklyOffRules: newRules,
      version: pune.version,
    });
    assert.equal(updateResponse.status, 200, JSON.stringify(updateResponse.body));
    assert.deepEqual(updateResponse.body.data.office.weeklyOffRules[1].occurrencesInMonth, [2, 4]);

    const staleResponse = await hrClient.patch(`/api/work-calendar/offices/${puneOfficeId}/weekly-offs`, {
      weeklyOffRules: [],
      version: pune.version,
    });
    assert.equal(staleResponse.status, 409);
    assert.equal(staleResponse.body.error.code, 'STALE_VERSION');

    const daysResponse = await hrClient.get(
      `/api/work-calendar/days?from=2026-10-10&to=2026-10-17&officeLocationId=${puneOfficeId}`,
    );
    const kindByDate = Object.fromEntries(daysResponse.body.data.days.map((day) => [day.date, day.kind]));
    assert.equal(kindByDate['2026-10-10'], 'weekly_off');
    assert.equal(kindByDate['2026-10-11'], 'weekly_off');
    assert.equal(kindByDate['2026-10-17'], 'working');
  });

  it('rejects invalid weekly-off rules', async () => {
    const pune = await officeById(puneOfficeId);
    const response = await hrClient.patch(`/api/work-calendar/offices/${puneOfficeId}/weekly-offs`, {
      weeklyOffRules: [
        { weekday: 7, occurrencesInMonth: [] },
        { weekday: WEEKDAYS.SATURDAY, occurrencesInMonth: [6] },
      ],
      version: pune.version,
    });
    assert.equal(response.status, 400);
    assert.deepEqual(
      response.body.error.details.map((detail) => detail.field),
      ['weeklyOffRules[0].weekday', 'weeklyOffRules[1].occurrencesInMonth'],
    );
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
    const ownHolidays = await employeeClient.get('/api/work-calendar/holidays?year=2026');
    assert.equal(ownHolidays.status, 200);
    assert.deepEqual(
      ownHolidays.body.data.holidays.map((holiday) => holiday.name),
      ['Gandhi Jayanti'],
    );
    assert.equal(
      (await employeeClient.get(`/api/work-calendar/holidays?year=2026&officeLocationId=${puneOfficeId}`)).status,
      403,
    );

    const daysResponse = await employeeClient.get('/api/work-calendar/days?from=2026-10-01&to=2026-10-04');
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

  it('refuses the calendar to accounts without an employee profile', async () => {
    assert.equal((await noProfileClient.get('/api/work-calendar/days?from=2026-10-01&to=2026-10-04')).status, 403);
  });

  it('validates calendar ranges', async () => {
    const backwards = await employeeClient.get('/api/work-calendar/days?from=2026-10-10&to=2026-10-01');
    assert.equal(backwards.status, 400);
    const tooLong = await employeeClient.get('/api/work-calendar/days?from=2026-01-01&to=2027-06-01');
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
