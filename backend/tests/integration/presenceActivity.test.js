/**
 * Presence as people see it (routes/presenceRoutes.js /now, /daily, /me/daily) against the real
 * server, from a day of intervals and attendance written as the app stores them; and the nightly
 * totals and retention (services/presenceActivity.js), run against the same database.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import { deleteExpiredPresence, writeDailySummaries } from '../../services/presenceActivity.js';
import { addDaysToCalendarDate } from '../../utils/calendarDates.js';
import { insertDepartment, officeFields, onboardEmployee } from './fixtures.js';
import { createSignedInClient, mongoUnavailableReason, startTestServer } from './testServer.js';

const skipReason = await mongoUnavailableReason();

const todayInBengaluru = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
/** An instant given as a Bengaluru wall-clock time. */
const ist = (date, time) => new Date(`${date}T${time}:00+05:30`);

describe('presence activity', { skip: skipReason ?? false }, () => {
  let testServer;
  let hrClient;
  let manager;
  let steady;
  let unpunched;
  let onLeave;
  // Yesterday in Bengaluru: a finished day, and the one the nightly job totals.
  const day = addDaysToCalendarDate(todayInBengaluru(), -1);

  before(async () => {
    testServer = await startTestServer();
    hrClient = await createSignedInClient(testServer, { name: 'Hema HR', email: 'hema.hr@example.com', role: 'hr' });
    const departmentId = await insertDepartment(testServer.database);
    // No weekly offs, so the day the tests look at is a working day whatever the date.
    const office = (await hrClient.post('/api/offices', officeFields('BLR', { workday: { weeklyOffRules: [] } }))).body
      .data.office;
    const onboard = async (email, name, options = {}) => {
      const person = await onboardEmployee({ testServer, hrClient, email, name, departmentId, ...options });
      await hrClient.request('PUT', `/api/employees/${person.profileId}/office`, {
        body: { officeLocationId: office.id },
      });
      return person;
    };
    manager = await onboard('lead@example.com', 'Lata Lead');
    const reportsTo = { reportingManagerId: manager.profileId };
    steady = await onboard('arun@example.com', 'Arun Steady', reportsTo);
    unpunched = await onboard('bina@example.com', 'Bina Unpunched', reportsTo);
    onLeave = await onboard('chitra@example.com', 'Chitra Leave', reportsTo);

    const { ObjectId } = testServer.database.base.Types;
    const interval = (person, state, from, to) => ({
      userId: new ObjectId(person.userId),
      state,
      startedAt: ist(day, from),
      lastSeenAt: ist(day, to),
      endedAt: ist(day, to),
      isOpen: false,
    });
    await testServer.database
      .collection('presenceintervals')
      .insertMany([
        interval(steady, 'available', '09:30', '12:30'),
        interval(steady, 'away', '12:30', '13:00'),
        interval(steady, 'available', '14:00', '18:30'),
        interval(unpunched, 'available', '10:00', '11:00'),
      ]);
    await testServer.database.collection('attendances').insertOne({
      entrySource: 'device_punch',
      employeeId: new ObjectId(steady.profileId),
      officeLocationId: new ObjectId(office.id),
      date: day,
      timeZone: 'Asia/Kolkata',
      checkInTime: ist(day, '09:30'),
      checkOutTime: ist(day, '18:30'),
      checkOutSource: 'device',
      workedMinutes: 540,
      workMode: 'office',
      calculationStatus: 'Normal',
      lateByMinutes: 0,
    });
    const leaveRequestId = new ObjectId();
    await testServer.database.collection('leaverequests').insertOne({ _id: leaveRequestId, status: 'APPROVED' });
    await testServer.database.collection('leavedayclaims').insertMany(
      ['FIRST', 'SECOND'].map((half) => ({
        employeeId: new ObjectId(onLeave.profileId),
        date: day,
        half,
        leaveRequestId,
      })),
    );
    // The nightly job's code runs in this process, against the same database.
    await mongoose.connect(testServer.mongoUri);
  });

  after(async () => {
    await mongoose.disconnect();
    await testServer?.stop();
  });

  const byName = (people) => Object.fromEntries(people.map((person) => [person.name, person]));

  it('gives a manager each report’s day: online, away, offline in the shift, and punched time', async () => {
    const response = await manager.client.get(`/api/presence/daily?date=${day}`);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.data.source, 'detail');
    const board = byName(response.body.data.people);
    assert.deepEqual(Object.keys(board).sort(), ['Arun Steady', 'Bina Unpunched', 'Chitra Leave']);

    const steadyDay = board['Arun Steady'];
    assert.deepEqual(
      {
        available: steadyDay.presence.availableMinutes,
        away: steadyDay.presence.awayMinutes,
        online: steadyDay.presence.onlineMinutes,
        offlineInShift: steadyDay.presence.offlineDuringShiftMinutes,
      },
      { available: 450, away: 30, online: 480, offlineInShift: 60 },
    );
    assert.equal(steadyDay.presence.firstSeenAt, ist(day, '09:30').toISOString());
    assert.equal(steadyDay.attendance.status, 'out');
    assert.equal(steadyDay.attendance.workedMinutes, 540);
    assert.equal(steadyDay.activeWithoutPunchIn, false);

    assert.equal(board['Bina Unpunched'].presence.availableMinutes, 60);
    assert.equal(board['Bina Unpunched'].activeWithoutPunchIn, true, 'online without punching in');
    assert.equal(board['Bina Unpunched'].presence.offlineDuringShiftMinutes, 480);

    assert.equal(board['Chitra Leave'].attendance.status, 'on_leave');
    assert.equal(board['Chitra Leave'].presence.offlineDuringShiftMinutes, null, 'no shift to miss on leave');
  });

  it('shows everyone their own days, and nobody else’s', async () => {
    const own = await steady.client.get(`/api/presence/me/daily?from=${day}&to=${day}`);
    assert.equal(own.status, 200, JSON.stringify(own.body));
    assert.equal(own.body.data.days.length, 1);
    assert.equal(own.body.data.days[0].presence.availableMinutes, 450);

    const week = await steady.client.get('/api/presence/me/daily');
    assert.equal(week.body.data.days.length, 7);
    assert.equal(week.body.data.days[0].date, week.body.data.to, 'newest first');

    assert.equal((await steady.client.get('/api/presence/daily')).status, 403);
    assert.equal((await steady.client.get('/api/presence/now')).status, 403);
    assert.equal((await steady.client.get('/api/presence/me/daily?from=2026-01-01&to=2026-03-01')).status, 400);
    assert.equal((await hrClient.get('/api/presence/me/daily')).status, 404, 'HR without a profile has no days');
  });

  it('shows who is offline, on leave or off work now', async () => {
    const response = await hrClient.get('/api/presence/now');
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const board = byName(response.body.data.people);
    for (const person of Object.values(board)) {
      assert.ok(['offline', 'off_work', 'on_leave'].includes(person.status), `${person.name}: ${person.status}`);
    }
    assert.ok(board['Arun Steady'].lastSeenAt, 'when they were last online');
    const { counts } = response.body.data;
    assert.equal(counts.available + counts.away, 0);
  });

  it('writes yesterday’s totals each night, and reads days whose detail is gone from them', async () => {
    // The day is yesterday, the day the job totals. (People who joined after a moment are not on
    // the roster for it, so the job runs as of now, as it does on the server.)
    const now = new Date();
    const { summariesWritten } = await writeDailySummaries({ now });
    assert.ok(summariesWritten >= 4);
    assert.equal((await writeDailySummaries({ now })).summariesWritten, summariesWritten, 'running again is harmless');
    const summaries = testServer.database.collection('presencedaysummaries');
    const steadySummary = await summaries.findOne({
      employeeId: new testServer.database.base.Types.ObjectId(steady.profileId),
      date: day,
    });
    assert.equal(steadySummary.availableMinutes, 450);
    assert.equal(steadySummary.workedMinutes, 540);
    assert.equal(await summaries.countDocuments({ date: day }), summariesWritten);

    // A day older than the detail is kept: read from its summary.
    const oldDay = addDaysToCalendarDate(todayInBengaluru(), -200);
    await summaries.updateOne({ _id: steadySummary._id }, { $set: { date: oldDay } });
    const old = await hrClient.get(`/api/presence/daily?date=${oldDay}`);
    assert.equal(old.body.data.source, 'summary');
    assert.equal(byName(old.body.data.people)['Arun Steady'].presence.availableMinutes, 450);
  });

  it('deletes detail and totals older than the company keeps them', async () => {
    const farFuture = new Date(Date.now() + 800 * 24 * 60 * 60 * 1000);
    const { intervalsDeleted, summariesDeleted } = await deleteExpiredPresence({ now: farFuture });
    assert.equal(intervalsDeleted, 4);
    assert.ok(summariesDeleted >= 1);
    assert.equal(await testServer.database.collection('presenceintervals').countDocuments(), 0);
  });
});
