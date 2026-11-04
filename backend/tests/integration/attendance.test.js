/**
 * Attendance punches against the real server (routes/attendanceRoutes.js): the office's punch-in
 * radius and an employee's own radius, the work modes each work type may punch in with, punching
 * out, and the automatic punch-out of forgotten punches (services/attendancePunchOut.js).
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { insertDepartment, officeDocument, officeFields, onboardEmployee } from './fixtures.js';
import { createSignedInClient, mongoUnavailableReason, startTestServer } from './testServer.js';

const skipReason = await mongoUnavailableReason();

/** The test office's centre, and points about 150 m and 600 m north of it (1° latitude ≈ 111 km). */
const OFFICE_CENTRE = Object.freeze({ lat: 12.97, lng: 77.59 });
const NEAR_OFFICE = Object.freeze({ lat: OFFICE_CENTRE.lat + 0.00135, lng: OFFICE_CENTRE.lng });
const FAR_FROM_OFFICE = Object.freeze({ lat: OFFICE_CENTRE.lat + 0.0054, lng: OFFICE_CENTRE.lng });

/** A punch body as the browser sends it. */
const punchAt = (point, extra = {}) => ({
  ...point,
  accuracyMeters: 12,
  deviceFingerprint: 'test-device-fingerprint-0001',
  ...extra,
});

/**
 * A punch-in left open on a past Monday at 09:40 in Bengaluru (04:10 UTC). The office's shift ends at
 * 18:30 (13:00 UTC), so it is closed then: 530 minutes worked.
 */
const FORGOTTEN_DATE = '2026-01-05';
const FORGOTTEN_CHECK_IN = new Date('2026-01-05T04:10:00Z');
const FORGOTTEN_SHIFT_END = new Date('2026-01-05T13:00:00Z');

function openPunchDocument(database, { employeeId, officeLocationId, date, checkInTime }) {
  const { ObjectId } = database.base.Types;
  return {
    entrySource: 'device_punch',
    employeeId: new ObjectId(employeeId),
    officeLocationId: new ObjectId(officeLocationId),
    date,
    timeZone: 'Asia/Kolkata',
    checkInTime,
    checkOutTime: null,
    workMode: 'office',
    onDutyReason: null,
    checkInCoordinates: { ...OFFICE_CENTRE, accuracyMeters: 10 },
    geofence: { enforced: true, distanceMeters: 5, allowedRadiusMeters: 200 },
    deviceFingerprint: 'a'.repeat(64),
    checkInMacAddress: null,
    calculationStatus: 'Normal',
    lateByMinutes: 10,
    regularization: null,
    createdAt: checkInTime,
    updatedAt: checkInTime,
  };
}

describe('attendance punches', { skip: skipReason ?? false }, () => {
  let testServer;
  let hrClient;
  let departmentId;
  let officeId;
  let forgottenPunchId;

  before(async () => {
    testServer = await startTestServer({
      // A punch nobody closed, which the server's attendance job closes when it starts.
      seedBeforeStart: async (database) => {
        const { insertedId: seededOfficeId } = await database
          .collection('officelocations')
          .insertOne(officeDocument('SEEDED', { coordinates: OFFICE_CENTRE }));
        const { insertedId } = await database.collection('attendances').insertOne(
          openPunchDocument(database, {
            employeeId: '64b0000000000000000000aa',
            officeLocationId: seededOfficeId.toString(),
            date: FORGOTTEN_DATE,
            checkInTime: FORGOTTEN_CHECK_IN,
          }),
        );
        forgottenPunchId = insertedId;
      },
    });
    hrClient = await createSignedInClient(testServer, { name: 'Hema HR', email: 'hema.hr@example.com', role: 'hr' });
    departmentId = await insertDepartment(testServer.database);
    const created = await hrClient.post('/api/offices', officeFields('BLR', { coordinates: OFFICE_CENTRE }));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    officeId = created.body.data.office.id;
  });

  after(async () => {
    await testServer?.stop();
  });

  /** An employee of the test office, onboarded the way HR does it. */
  async function employeeAtOffice(email, options = {}) {
    const employee = await onboardEmployee({ testServer, hrClient, email, departmentId, ...options });
    const assignment = await hrClient.request('PUT', `/api/employees/${employee.profileId}/office`, {
      body: { officeLocationId: officeId },
    });
    assert.equal(assignment.status, 200, JSON.stringify(assignment.body));
    return employee;
  }

  it('lets an on-site employee punch in near the office with only the office’s radius set', async () => {
    const employee = await employeeAtOffice('near@example.com');
    const response = await employee.client.post('/api/attendance/punch-in', punchAt(NEAR_OFFICE));
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const { geofence } = response.body.data.attendance;
    assert.equal(geofence.enforced, true);
    assert.equal(geofence.allowedRadiusMeters, 200);
    assert.ok(geofence.distanceMeters > 100 && geofence.distanceMeters < 200, `distance ${geofence.distanceMeters}`);
  });

  it('refuses a punch-in outside the office’s radius, and accepts it within the employee’s own', async () => {
    const employee = await employeeAtOffice('far@example.com');
    const refused = await employee.client.post('/api/attendance/punch-in', punchAt(FAR_FROM_OFFICE));
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error.code, 'UNAUTHORIZED_SPATIAL_LOCATION');
    assert.equal(refused.body.error.context.allowedRadiusMeters, 200);

    await hrClient.request('PUT', `/api/employees/${employee.profileId}/geofence-radius`, {
      body: { geofenceRadiusMeters: 1000 },
    });
    const accepted = await employee.client.post('/api/attendance/punch-in', punchAt(FAR_FROM_OFFICE));
    assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
    assert.equal(accepted.body.data.attendance.geofence.allowedRadiusMeters, 1000);
    assert.equal(accepted.body.data.attendance.workMode, 'office', 'an on-site employee’s usual mode');
  });

  it('keeps on-site staff from working from home, but lets them punch in on duty with a reason', async () => {
    const employee = await employeeAtOffice('onsite.duty@example.com');
    const fromHome = await employee.client.post(
      '/api/attendance/punch-in',
      punchAt(FAR_FROM_OFFICE, { workMode: 'home' }),
    );
    assert.equal(fromHome.status, 403);
    assert.equal(fromHome.body.error.code, 'WORK_MODE_NOT_ALLOWED');
    assert.deepEqual(fromHome.body.error.context.allowedWorkModes, ['office', 'on_duty']);

    const noReason = await employee.client.post(
      '/api/attendance/punch-in',
      punchAt(FAR_FROM_OFFICE, { workMode: 'on_duty' }),
    );
    assert.equal(noReason.status, 400);
    assert.equal(noReason.body.error.details[0].field, 'onDutyReason');

    const onDuty = await employee.client.post(
      '/api/attendance/punch-in',
      punchAt(FAR_FROM_OFFICE, {
        workMode: 'on_duty',
        onDutyReason: '  Client visit, Infosys Pune  ',
        accuracyMeters: 900,
      }),
    );
    assert.equal(onDuty.status, 201, JSON.stringify(onDuty.body));
    const { attendance } = onDuty.body.data;
    assert.equal(attendance.workMode, 'on_duty');
    assert.equal(attendance.onDutyReason, 'Client visit, Infosys Pune');
    assert.equal(attendance.geofence.enforced, false, 'no radius away from the office');
    assert.equal(attendance.geofence.allowedRadiusMeters, null);
    assert.ok(attendance.geofence.distanceMeters > 500, 'the distance is still recorded');
  });

  it('lets hybrid staff work from home with an imprecise location, but checks precision at the office', async () => {
    const employee = await employeeAtOffice('hybrid@example.com', { workLocationType: 'Hybrid' });
    const imprecise = await employee.client.post(
      '/api/attendance/punch-in',
      punchAt(NEAR_OFFICE, { workMode: 'office', accuracyMeters: 1500 }),
    );
    assert.equal(imprecise.status, 422);
    assert.equal(imprecise.body.error.code, 'LOCATION_TOO_IMPRECISE');

    const fromHome = await employee.client.post(
      '/api/attendance/punch-in',
      punchAt(FAR_FROM_OFFICE, { workMode: 'home', accuracyMeters: 1500 }),
    );
    assert.equal(fromHome.status, 201, JSON.stringify(fromHome.body));
    assert.equal(fromHome.body.data.attendance.workMode, 'home');
    assert.equal(fromHome.body.data.attendance.geofence.enforced, false);
  });

  it('defaults remote staff to working from home, and checks the radius when they come to the office', async () => {
    const remote = await employeeAtOffice('remote@example.com', { workLocationType: 'Remote' });
    const atOffice = await remote.client.post(
      '/api/attendance/punch-in',
      punchAt(FAR_FROM_OFFICE, { workMode: 'office' }),
    );
    assert.equal(atOffice.status, 403);
    assert.equal(atOffice.body.error.code, 'UNAUTHORIZED_SPATIAL_LOCATION');

    const usual = await remote.client.post('/api/attendance/punch-in', punchAt(FAR_FROM_OFFICE));
    assert.equal(usual.status, 201, JSON.stringify(usual.body));
    assert.equal(usual.body.data.attendance.workMode, 'home');
  });

  it('refuses unknown work modes and a reason without being on duty', async () => {
    const employee = await employeeAtOffice('shape@example.com');
    const unknown = await employee.client.post('/api/attendance/punch-in', punchAt(NEAR_OFFICE, { workMode: 'beach' }));
    assert.equal(unknown.status, 400);
    assert.equal(unknown.body.error.details[0].field, 'workMode');
    const strayReason = await employee.client.post(
      '/api/attendance/punch-in',
      punchAt(NEAR_OFFICE, { workMode: 'office', onDutyReason: 'not needed' }),
    );
    assert.equal(strayReason.status, 400);
    assert.equal(strayReason.body.error.details[0].field, 'onDutyReason');
  });

  it('punches out once, recording where and for how long, wherever the employee is', async () => {
    const employee = await employeeAtOffice('out@example.com');
    const beforePunchIn = await employee.client.post('/api/attendance/punch-out', punchAt(NEAR_OFFICE));
    assert.equal(beforePunchIn.status, 409);
    assert.equal(beforePunchIn.body.error.code, 'NOT_PUNCHED_IN');

    const punchIn = await employee.client.post('/api/attendance/punch-in', punchAt(NEAR_OFFICE));
    assert.equal(punchIn.status, 201, JSON.stringify(punchIn.body));
    const punchOut = await employee.client.post('/api/attendance/punch-out', punchAt(FAR_FROM_OFFICE));
    assert.equal(punchOut.status, 200, JSON.stringify(punchOut.body));
    const { attendance } = punchOut.body.data;
    assert.equal(attendance.id, punchIn.body.data.attendance.id);
    assert.equal(attendance.checkOutSource, 'device');
    assert.equal(attendance.workedMinutes, 0);
    assert.ok(new Date(attendance.checkOutTime) > new Date(attendance.checkInTime));

    const stored = await testServer.database
      .collection('attendances')
      .findOne({ _id: new testServer.database.base.Types.ObjectId(attendance.id) });
    assert.ok(stored.checkOutDistanceMeters > 500, 'the distance at punch-out is recorded, not refused');
    assert.equal(stored.checkOutCoordinates.lat, FAR_FROM_OFFICE.lat);

    const again = await employee.client.post('/api/attendance/punch-out', punchAt(NEAR_OFFICE));
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'ALREADY_PUNCHED_OUT');
  });

  it('closes a forgotten punch-out at the shift end when the server starts', async () => {
    const attendances = testServer.database.collection('attendances');
    let closed = null;
    for (let attempt = 0; attempt < 50 && !closed?.checkOutTime; attempt += 1) {
      closed = await attendances.findOne({ _id: forgottenPunchId });
      if (!closed.checkOutTime) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(closed.checkOutSource, 'auto_closed');
    assert.equal(closed.checkOutTime.toISOString(), FORGOTTEN_SHIFT_END.toISOString());
    assert.equal(closed.workedMinutes, 530);
  });

  it('refuses a punch-out after the automatic one’s deadline, closing the punch at the shift end', async () => {
    const employee = await employeeAtOffice('late.out@example.com');
    const { insertedId } = await testServer.database.collection('attendances').insertOne(
      openPunchDocument(testServer.database, {
        employeeId: employee.profileId,
        officeLocationId: officeId,
        date: FORGOTTEN_DATE,
        checkInTime: FORGOTTEN_CHECK_IN,
      }),
    );
    const tooLate = await employee.client.post('/api/attendance/punch-out', punchAt(NEAR_OFFICE));
    assert.equal(tooLate.status, 409);
    assert.equal(tooLate.body.error.code, 'PUNCH_OUT_TOO_LATE');
    const stored = await testServer.database.collection('attendances').findOne({ _id: insertedId });
    assert.equal(stored.checkOutSource, 'auto_closed');
    assert.equal(stored.checkOutTime.toISOString(), FORGOTTEN_SHIFT_END.toISOString());
  });
});
