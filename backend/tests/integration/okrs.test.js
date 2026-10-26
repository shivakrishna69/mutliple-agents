import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { EMPLOYMENT_STATUSES, WORK_LOCATION_TYPES } from '../../models/EmployeeProfile.js';
import { KEY_RESULT_UNITS } from '../../models/KeyResult.js';
import { OBJECTIVE_LEVELS } from '../../models/Objective.js';
import { createSignedInClient, mongoUnavailableReason, startTestServer, STRONG_PASSWORD } from './testServer.js';

const skipReason = await mongoUnavailableReason();
const CURRENT_PERIOD = { year: 2026, quarter: 4 };

describe('OKR edits by several people at once', { skip: skipReason ?? false }, () => {
  let testServer;
  let hrClient;
  let secondHrClient;
  let employeeClient;
  let outsiderClient;
  let employeeProfileId;

  /** Onboards an employee through the invitation flow, so they get a real employee profile. */
  async function onboardEmployee(email) {
    const departmentInsert = await testServer.database.collection('departments').insertOne({
      name: 'Customer Success',
      code: 'CS',
      budgetCode: 'CC-200',
      departmentHeadId: null,
      parentDepartmentId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const invitationResponse = await hrClient.post('/api/people/invitations', {
      name: 'Esha Employee',
      email,
      role: 'customer',
      designation: 'Account Manager',
      departmentId: departmentInsert.insertedId.toString(),
      workLocationType: WORK_LOCATION_TYPES.HYBRID,
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

  async function createCompanyObjective(title) {
    const response = await hrClient.post('/api/okrs/objectives', {
      level: OBJECTIVE_LEVELS.COMPANY,
      period: CURRENT_PERIOD,
      title,
      ownerEmployeeId: employeeProfileId,
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body.data.objective;
  }

  before(async () => {
    testServer = await startTestServer();
    hrClient = await createSignedInClient(testServer, { name: 'Hema HR', email: 'hema.hr@example.com', role: 'hr' });
    secondHrClient = testServer.createClient();
    await secondHrClient.login('hema.hr@example.com');
    outsiderClient = await createSignedInClient(testServer, { name: 'Omar Outsider', email: 'omar@example.com' });
    ({ client: employeeClient, profileId: employeeProfileId } = await onboardEmployee('esha@example.com'));
  });

  after(async () => {
    await testServer?.stop();
  });

  it('rejects the second of two edits made from the same version', async () => {
    const objective = await createCompanyObjective('Grow renewals');

    const firstEdit = await hrClient.patch(`/api/okrs/objectives/${objective.id}`, {
      title: 'Grow renewals by 20%',
      version: objective.version,
    });
    assert.equal(firstEdit.status, 200, JSON.stringify(firstEdit.body));

    const staleEdit = await secondHrClient.patch(`/api/okrs/objectives/${objective.id}`, {
      title: 'Grow renewals by 30%',
      version: objective.version,
    });
    assert.equal(staleEdit.status, 409);
    assert.equal(staleEdit.body.error.code, 'STALE_VERSION');

    const storedObjective = await testServer.database
      .collection('objectives')
      .findOne({ _id: new testServer.database.base.Types.ObjectId(objective.id) });
    assert.equal(storedObjective.title, 'Grow renewals by 20%');
  });

  it('lets the key-result owner check in progress, and rejects a stale check-in', async () => {
    const objective = await createCompanyObjective('Delight customers');
    const keyResultResponse = await hrClient.post(`/api/okrs/objectives/${objective.id}/key-results`, {
      title: 'Raise CSAT to 90',
      ownerEmployeeId: employeeProfileId,
      unit: KEY_RESULT_UNITS.SCORE,
      startValue: 70,
      targetValue: 90,
    });
    assert.equal(keyResultResponse.status, 201, JSON.stringify(keyResultResponse.body));
    const keyResult = keyResultResponse.body.data.keyResult;

    const checkIn = await employeeClient.patch(`/api/okrs/key-results/${keyResult.id}/progress`, {
      currentValue: 80,
      version: keyResult.version,
    });
    assert.equal(checkIn.status, 200, JSON.stringify(checkIn.body));

    const staleCheckIn = await hrClient.patch(`/api/okrs/key-results/${keyResult.id}/progress`, {
      currentValue: 75,
      version: keyResult.version,
    });
    assert.equal(staleCheckIn.status, 409);
    assert.equal(staleCheckIn.body.error.code, 'STALE_VERSION');
  });

  it('keeps company objectives to HR and admins', async () => {
    const employeeAttempt = await employeeClient.post('/api/okrs/objectives', {
      level: OBJECTIVE_LEVELS.COMPANY,
      period: CURRENT_PERIOD,
      title: 'Self-approved objective',
      ownerEmployeeId: employeeProfileId,
    });
    assert.equal(employeeAttempt.status, 403);
    assert.equal(employeeAttempt.body.error.code, 'OKR_FORBIDDEN');
  });

  it('hides OKRs from accounts without an employee profile', async () => {
    const alignmentResponse = await outsiderClient.get(
      `/api/okrs/alignment?year=${CURRENT_PERIOD.year}&quarter=${CURRENT_PERIOD.quarter}`,
    );
    assert.equal(alignmentResponse.status, 403);
  });
});
