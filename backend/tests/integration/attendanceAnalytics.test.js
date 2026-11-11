/**
 * Attendance analytics (routes/attendanceRoutes.js GET /analytics) against the real server: last
 * month judged day by day for each person (punches, approved full and half-day leave, a holiday, a
 * later joining date, no office), completion per person and department, arrival times bucketed over
 * the last days, and who may see it (a lead their reports, HR everyone or one department, nobody else).
 * Past punches and leave are written as the attendance and leave systems store them.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { insertDepartment, officeFields, onboardEmployee } from './fixtures.js';
import { createSignedInClient, mongoUnavailableReason, startTestServer } from './testServer.js';

const skipReason = await mongoUnavailableReason();

const OFFICE_CENTRE = Object.freeze({ lat: 12.97, lng: 77.59 });
const TIME_ZONE = 'Asia/Kolkata';
const todayInBengaluru = () => new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(new Date());

/** Last month (in Bengaluru), its length, and its "YYYY-MM-DD" days. */
function lastMonth() {
  const [year, month] = todayInBengaluru().split('-').map(Number);
  const first = new Date(Date.UTC(year, month - 2, 1));
  const label = first.toISOString().slice(0, 7);
  const length = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return { label, length, day: (number) => `${label}-${String(number).padStart(2, '0')}` };
}

/** The instant of a Bengaluru wall-clock time on a date (IST is UTC+05:30 all year). */
const istInstant = (date, clock) => new Date(`${date}T${clock}:00+05:30`);

describe('attendance analytics', { skip: skipReason ?? false }, () => {
  let testServer;
  let hrClient;
  let operationsId;
  let financeId;
  let manager;
  let regular;
  let outsider;
  const month = lastMonth();

  before(async () => {
    testServer = await startTestServer();
    hrClient = await createSignedInClient(testServer, { name: 'Hema HR', email: 'hema.hr@example.com', role: 'hr' });
    operationsId = await insertDepartment(testServer.database);
    financeId = await insertDepartment(testServer.database, { name: 'Finance', code: 'FIN', budgetCode: 'CC-500' });
    // No weekly offs: every day is a working day except the holiday.
    const office = (
      await hrClient.post(
        '/api/offices',
        officeFields('BLR', { coordinates: OFFICE_CENTRE, workday: { weeklyOffRules: [] } }),
      )
    ).body.data.office;
    await hrClient.post('/api/work-calendar/holidays', {
      name: 'Founders Day',
      date: month.day(20),
      officeLocationIds: [],
    });

    const { ObjectId } = testServer.database.base.Types;
    const profiles = testServer.database.collection('employeeprofiles');
    const onboard = async (email, name, { joinedOn = month.day(1), withOffice = true, ...options } = {}) => {
      const person = await onboardEmployee({
        testServer,
        hrClient,
        email,
        name,
        departmentId: operationsId,
        ...options,
      });
      if (withOffice) {
        await hrClient.request('PUT', `/api/employees/${person.profileId}/office`, {
          body: { officeLocationId: office.id },
        });
      }
      await profiles.updateOne(
        { _id: new ObjectId(person.profileId) },
        { $set: { 'organizationData.dateOfJoining': new Date(`${joinedOn}T00:00:00Z`) } },
      );
      return person;
    };
    manager = await onboard('lead@example.com', 'Lata Lead');
    const reportsTo = { reportingManagerId: manager.profileId };
    regular = await onboard('arun@example.com', 'Arun Regular', reportsTo);
    await onboard('bina@example.com', 'Bina Joiner', { ...reportsTo, joinedOn: month.day(15) });
    await onboard('chitra@example.com', 'Chitra Nooffice', { ...reportsTo, withOffice: false });
    outsider = await onboard('dev@example.com', 'Dev Finance', { departmentId: financeId });

    // Arun: in on days 1-10 (late on 3 and 7), full-day leave on 12, half-day leave on 13.
    const attendance = testServer.database.collection('attendances');
    await attendance.insertMany(
      Array.from({ length: 10 }, (_, index) => {
        const date = month.day(index + 1);
        const isLate = index + 1 === 3 || index + 1 === 7;
        return {
          employeeId: new ObjectId(regular.profileId),
          date,
          checkInTime: istInstant(date, isLate ? '10:15' : '09:05'),
          calculationStatus: isLate ? 'Late' : 'Normal',
        };
      }),
    );
    const leaveRequestId = new ObjectId();
    await testServer.database.collection('leaverequests').insertOne({ _id: leaveRequestId, status: 'APPROVED' });
    await testServer.database.collection('leavedayclaims').insertMany([
      ...['FIRST', 'SECOND'].map((half) => ({
        employeeId: new ObjectId(regular.profileId),
        date: month.day(12),
        half,
        leaveRequestId,
      })),
      { employeeId: new ObjectId(regular.profileId), date: month.day(13), half: 'FIRST', leaveRequestId },
    ]);
    // Dev arrives today at 09:10 and 09:40 on the day before (two people's worth of arrivals in a week).
    await attendance.insertMany([
      {
        employeeId: new ObjectId(outsider.profileId),
        date: todayInBengaluru(),
        checkInTime: istInstant(todayInBengaluru(), '09:10'),
        calculationStatus: 'Normal',
      },
      {
        employeeId: new ObjectId(manager.profileId),
        date: todayInBengaluru(),
        checkInTime: istInstant(todayInBengaluru(), '09:40'),
        calculationStatus: 'Late',
      },
    ]);
  });

  after(async () => {
    await testServer?.stop();
  });

  const analyticsOf = async (client, query = '') => {
    const response = await client.get(`/api/attendance/analytics${query}`);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body.data;
  };
  const byName = (people) => Object.fromEntries(people.map((person) => [person.name, person]));

  it("judges last month's days and counts completion per person", async () => {
    const data = await analyticsOf(hrClient, `?month=${month.label}&departmentId=${operationsId}`);
    assert.equal(data.month, month.label);
    const people = byName(data.people);
    assert.deepEqual(Object.keys(people).sort(), ['Arun Regular', 'Bina Joiner', 'Chitra Nooffice', 'Lata Lead']);

    const arun = people['Arun Regular'];
    const statusOn = (person, day) => person.days[day - 1].status;
    assert.equal(statusOn(arun, 1), 'on_time');
    assert.equal(statusOn(arun, 3), 'late');
    assert.equal(statusOn(arun, 11), 'absent');
    assert.equal(statusOn(arun, 12), 'leave');
    assert.equal(statusOn(arun, 13), 'absent', 'half-day leave without a punch: the other half was missed');
    assert.equal(statusOn(arun, 20), 'holiday');
    // Expected: every day but the holiday, less 1 (full leave) and 0.5 (half leave).
    assert.equal(arun.expectedDays, month.length - 1 - 1.5);
    assert.equal(arun.presentDays, 10);
    assert.equal(arun.lateDays, 2);
    assert.equal(arun.completion, Math.round((10 / (month.length - 2.5)) * 1000) / 1000);

    const bina = people['Bina Joiner'];
    assert.equal(statusOn(bina, 14), 'not_joined');
    assert.equal(statusOn(bina, 15), 'absent');
    assert.equal(bina.expectedDays, month.length - 14 - 1);
    assert.equal(bina.completion, 0);
    assert.equal(people['Chitra Nooffice'].completion, null, 'no office: no working days to judge');

    const [operations] = data.departments;
    assert.equal(operations.department.id, operationsId);
    assert.equal(operations.headcount, 4);
    assert.equal(operations.presentDays, 10);
    assert.equal(operations.expectedDays, arun.expectedDays + bina.expectedDays + people['Lata Lead'].expectedDays);
  });

  it('buckets arrival times over the last days, in office time', async () => {
    const { arrivals, departments } = await analyticsOf(hrClient);
    assert.equal(arrivals.slotMinutes, 30);
    assert.equal(arrivals.dates.length, 7);
    assert.equal(arrivals.dates.at(-1), todayInBengaluru());
    const today = arrivals.dates.length - 1;
    const slot = (start) => arrivals.slots.find((candidate) => candidate.start === start);
    assert.equal(slot('09:00').counts[today], 1);
    assert.equal(slot('09:30').counts[today], 1);
    assert.deepEqual(arrivals.medians.at(-1), { date: todayInBengaluru(), count: 2, median: '09:25' });
    assert.deepEqual(departments.map((entry) => entry.department.name).sort(), ['Finance', 'Operations']);
  });

  it('shows a lead their reports only, and refuses everyone else and bad queries', async () => {
    const leadView = await analyticsOf(manager.client, `?month=${month.label}`);
    assert.deepEqual(leadView.people.map((person) => person.name).sort(), [
      'Arun Regular',
      'Bina Joiner',
      'Chitra Nooffice',
    ]);
    const refused = await outsider.client.get('/api/attendance/analytics');
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error.code, 'ANALYTICS_FORBIDDEN');
    assert.equal((await hrClient.get('/api/attendance/analytics?month=2026-13')).status, 400);
    assert.equal((await hrClient.get('/api/attendance/analytics?departmentId=nope')).status, 400);
    const ahead = await hrClient.get('/api/attendance/analytics?month=2099-01');
    assert.equal(ahead.status, 422);
    assert.equal(ahead.body.error.code, 'ANALYTICS_MONTH_AHEAD');
  });
});
