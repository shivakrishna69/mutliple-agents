/**
 * Test data shared by the integration suites: offices, departments, and employees onboarded the
 * way real ones are (HR invites, the employee accepts), so every suite exercises the same flow.
 */

import assert from 'node:assert/strict';

import { EMPLOYMENT_STATUSES, WORK_LOCATION_TYPES } from '../../models/EmployeeProfile.js';
import { STRONG_PASSWORD } from './testServer.js';

/** A valid office as the API accepts it; `overrides` replace top-level fields, `workday` fields merge. */
export function officeFields(code, { workday = {}, ...overrides } = {}) {
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
      ...workday,
    },
    ...overrides,
  };
}

/** An office document written straight to the database (for data that predates the API). */
export function officeDocument(code, options) {
  return { ...officeFields(code, options), createdAt: new Date(), updatedAt: new Date(), __v: 0 };
}

/** Inserts a department and returns its id. */
export async function insertDepartment(database, { name = 'Operations', code = 'OPS', budgetCode = 'CC-400' } = {}) {
  const { insertedId } = await database.collection('departments').insertOne({
    name,
    code,
    budgetCode,
    departmentHeadId: null,
    parentDepartmentId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return insertedId.toString();
}

/**
 * HR invites an employee, who accepts. Returns their signed-in client, user id and EmployeeProfile id.
 * @param {{ testServer: object, hrClient: object, email: string, departmentId: string, name?: string }} details
 */
export async function onboardEmployee({ testServer, hrClient, email, departmentId, name = 'Test Employee' }) {
  const invitationResponse = await hrClient.post('/api/people/invitations', {
    name,
    email,
    role: 'customer',
    designation: 'Analyst',
    departmentId,
    workLocationType: WORK_LOCATION_TYPES.ONSITE,
    dateOfJoining: new Date().toISOString().slice(0, 10),
    employmentStatus: EMPLOYMENT_STATUSES.ACTIVE,
  });
  assert.equal(invitationResponse.status, 201, JSON.stringify(invitationResponse.body));
  const token = new URL(invitationResponse.body.data.delivery.inviteUrl).pathname.split('/').pop();
  const client = testServer.createClient();
  const acceptResponse = await client.post(`/api/invitations/${token}/accept`, { password: STRONG_PASSWORD });
  assert.equal(acceptResponse.status, 201, JSON.stringify(acceptResponse.body));
  const userId = acceptResponse.body.data.user.id;
  const profile = await testServer.database
    .collection('employeeprofiles')
    .findOne({ userId: new testServer.database.base.Types.ObjectId(userId) });
  return { client, userId, profileId: profile._id.toString() };
}
