/**
 * Organisation-wide HR access and "my own profile" resolution (services/workforceAccess.js), through
 * the endpoints that rely on them: payslip listing and attendance regularization reviews.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { EMPLOYMENT_STATUSES, WORK_LOCATION_TYPES } from '../../models/EmployeeProfile.js';
import { createSignedInClient, mongoUnavailableReason, startTestServer, STRONG_PASSWORD } from './testServer.js';

const skipReason = await mongoUnavailableReason();

describe('workforce access rules', { skip: skipReason ?? false }, () => {
  let testServer;
  let hrClient;
  let noProfileClient;
  let firstEmployee;
  let secondEmployee;

  /** Onboards an employee through the invitation flow and returns their client and profile id. */
  async function onboardEmployee(email, departmentId) {
    const invitationResponse = await hrClient.post('/api/people/invitations', {
      name: 'Test Employee',
      email,
      role: 'customer',
      designation: 'Analyst',
      departmentId,
      workLocationType: WORK_LOCATION_TYPES.REMOTE,
      dateOfJoining: new Date().toISOString().slice(0, 10),
      employmentStatus: EMPLOYMENT_STATUSES.ACTIVE,
    });
    assert.equal(invitationResponse.status, 201, JSON.stringify(invitationResponse.body));
    const token = new URL(invitationResponse.body.data.delivery.inviteUrl).pathname.split('/').pop();
    const client = testServer.createClient();
    const acceptResponse = await client.post(`/api/invitations/${token}/accept`, { password: STRONG_PASSWORD });
    assert.equal(acceptResponse.status, 201, JSON.stringify(acceptResponse.body));
    const profile = await testServer.database
      .collection('employeeprofiles')
      .findOne({ userId: new testServer.database.base.Types.ObjectId(acceptResponse.body.data.user.id) });
    return { client, profileId: profile._id.toString() };
  }

  before(async () => {
    testServer = await startTestServer();
    const { insertedId } = await testServer.database.collection('departments').insertOne({
      name: 'Finance',
      code: 'FIN',
      budgetCode: 'CC-300',
      departmentHeadId: null,
      parentDepartmentId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    hrClient = await createSignedInClient(testServer, { name: 'Hema HR', email: 'hema.hr@example.com', role: 'hr' });
    noProfileClient = await createSignedInClient(testServer, { name: 'Nia Noprofile', email: 'nia@example.com' });
    firstEmployee = await onboardEmployee('first@example.com', insertedId.toString());
    secondEmployee = await onboardEmployee('second@example.com', insertedId.toString());
  });

  after(async () => {
    await testServer?.stop();
  });

  it('lets an employee list their own payslips but not a colleague’s', async () => {
    assert.equal((await firstEmployee.client.get('/api/payroll/payslips')).status, 200);
    const colleagueResponse = await firstEmployee.client.get(
      `/api/payroll/payslips?employeeId=${secondEmployee.profileId}`,
    );
    assert.equal(colleagueResponse.status, 403);
  });

  it('lets HR list any employee’s payslips', async () => {
    const response = await hrClient.get(`/api/payroll/payslips?employeeId=${secondEmployee.profileId}`);
    assert.equal(response.status, 200);
  });

  it('tells an account without an employee profile that it has none', async () => {
    assert.equal((await noProfileClient.get('/api/payroll/payslips')).status, 404);
  });

  it('opens the regularization review queue to HR and managers, not to accounts without a profile', async () => {
    assert.equal((await hrClient.get('/api/attendance/regularization-reviews')).status, 200);
    assert.equal((await firstEmployee.client.get('/api/attendance/regularization-reviews')).status, 200);
    assert.equal((await noProfileClient.get('/api/attendance/regularization-reviews')).status, 403);
  });
});
