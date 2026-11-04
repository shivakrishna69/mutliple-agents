/**
 * Attendance punches against the real server (routes/attendanceRoutes.js): the office's punch-in
 * radius and an employee's own radius.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { insertDepartment, officeFields, onboardEmployee } from './fixtures.js';
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

describe('attendance punches', { skip: skipReason ?? false }, () => {
  let testServer;
  let hrClient;
  let departmentId;
  let officeId;

  before(async () => {
    testServer = await startTestServer();
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
  });
});
