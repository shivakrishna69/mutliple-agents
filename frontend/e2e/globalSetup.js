/**
 * Starts the real backend (backend/tests/integration/testServer.js) on a throwaway MongoDB
 * database, then creates the accounts and the department the tests use, and onboards employees
 * (HR invites, the employee accepts): one without an office for the workplace test, and a leave
 * scenario (an employee with an office, a manager and a Casual Leave balance) for the leave tests,
 * plus a second employee of that manager with Earned Leave that needs HR's approval too.
 * A stand-in AI service answers the leave assistant (e2e/standInAiService.js). Returns the teardown,
 * which stops the backend and drops the database.
 *
 * Needs the backend's dependencies installed (cd backend && npm ci) and MongoDB reachable at
 * TEST_MONGO_URL (default mongodb://127.0.0.1:27017).
 */

import { onboardEmployee } from '../../backend/tests/integration/fixtures.js';
import { startTestServer } from '../../backend/tests/integration/testServer.js';
import { startStandInAiService } from './standInAiService.js';
import {
  ACCOUNTS,
  BACKEND_PORT,
  DEPARTMENT_NAME,
  EMPLOYEE,
  FRONTEND_ORIGIN,
  LEAVE_EMPLOYEE,
  LEAVE_EMPLOYEE_CASUAL_DAYS,
  LEAVE_MANAGER,
  PASSWORD,
  TWO_STEP_EARNED_DAYS,
  TWO_STEP_EMPLOYEE,
} from './environment.js';

async function signUp(testServer, { name, email }) {
  const client = testServer.createClient();
  const response = await client.signup(name, email, PASSWORD);
  if (response.status !== 201) {
    throw new Error(`Seeding ${email} failed: ${response.status} ${JSON.stringify(response.body)}`);
  }
}

async function expectCreated(responsePromise, what) {
  const response = await responsePromise;
  if (response.status >= 300)
    throw new Error(`Seeding ${what} failed: ${response.status} ${JSON.stringify(response.body)}`);
  return response.body.data;
}

/**
 * The employees and manager for the leave tests, with an office open every day: a CL balance for
 * one, and Earned Leave needing the manager's then HR's approval for the other.
 */
async function seedLeaveScenario(testServer, adminClient, departmentId) {
  const employee = await onboardEmployee({ testServer, hrClient: adminClient, departmentId, ...LEAVE_EMPLOYEE });
  const twoStepEmployee = await onboardEmployee({
    testServer,
    hrClient: adminClient,
    departmentId,
    ...TWO_STEP_EMPLOYEE,
  });
  const manager = await onboardEmployee({ testServer, hrClient: adminClient, departmentId, ...LEAVE_MANAGER });
  const { office } = await expectCreated(
    adminClient.post('/api/offices', {
      name: 'E2E Office',
      code: 'E2E',
      coordinates: { lat: 12.97, lng: 77.59 },
      timeZone: 'Asia/Kolkata',
      // No weekly offs, so today is always a working day whatever day the tests run.
      workday: { shiftStartLocalTime: '09:30', shiftEndLocalTime: '18:30', weeklyOffRules: [] },
    }),
    'the leave office',
  );
  const objectId = (id) => new testServer.database.base.Types.ObjectId(id);
  for (const { profileId } of [employee, twoStepEmployee]) {
    await expectCreated(
      adminClient.request('PUT', `/api/employees/${profileId}/office`, { body: { officeLocationId: office.id } }),
      'the office assignment',
    );
    await testServer.database
      .collection('employeeprofiles')
      .updateOne(
        { _id: objectId(profileId) },
        { $set: { 'organizationData.reportingManagerId': objectId(manager.profileId) } },
      );
  }
  const { leaveTypes } = await expectCreated(adminClient.get('/api/leave/types'), 'the leave types');
  // Sick Leave needs a supporting document from the first day, so the test reaches the upload.
  const sickLeave = leaveTypes.find((type) => type.code === 'SL');
  await expectCreated(
    adminClient.patch(`/api/leave/types/${sickLeave.id}`, {
      usage: { attachmentRequiredAfterDays: 0 },
      version: sickLeave.version,
    }),
    'the Sick Leave document rule',
  );
  await expectCreated(
    adminClient.post('/api/leave/adjustments', {
      employeeId: employee.profileId,
      leaveTypeId: leaveTypes.find((type) => type.code === 'CL').id,
      reasonCode: 'ENTITLEMENT_GRANT',
      days: LEAVE_EMPLOYEE_CASUAL_DAYS,
      note: 'Balance for the browser tests',
    }),
    'the leave balance',
  );
  // Earned Leave of any length needs HR's approval after the manager's.
  const earnedLeave = leaveTypes.find((type) => type.code === 'EL');
  await expectCreated(
    adminClient.patch(`/api/leave/types/${earnedLeave.id}`, {
      usage: { hrApprovalAfterDays: 0 },
      version: earnedLeave.version,
    }),
    'the Earned Leave approval rule',
  );
  await expectCreated(
    adminClient.post('/api/leave/adjustments', {
      employeeId: twoStepEmployee.profileId,
      leaveTypeId: earnedLeave.id,
      reasonCode: 'ENTITLEMENT_GRANT',
      days: TWO_STEP_EARNED_DAYS,
      note: 'Balance for the two-step approval test',
    }),
    'the Earned Leave balance',
  );
}

export default async function globalSetup() {
  // The stand-in starts first: the backend needs its address; it reads the backend's when asked.
  let testServer;
  const standIn = await startStandInAiService({
    backendUrl: () => testServer.baseUrl,
    internalApiKey: () => testServer.internalApiKey,
  });
  try {
    testServer = await startTestServer({ port: BACKEND_PORT, appOrigin: FRONTEND_ORIGIN, aiServiceUrl: standIn.url });
  } catch (startupError) {
    await standIn.close();
    throw startupError;
  }
  try {
    for (const account of Object.values(ACCOUNTS)) await signUp(testServer, account);
    // The same change scripts/setUserRole.js makes; the API cannot create HR accounts directly.
    await testServer.database.collection('users').updateOne({ email: ACCOUNTS.hr.email }, { $set: { role: 'hr' } });
    const { insertedId: departmentId } = await testServer.database.collection('departments').insertOne({
      name: DEPARTMENT_NAME,
      code: 'ENG',
      budgetCode: 'CC-100',
      departmentHeadId: null,
      parentDepartmentId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    // Onboarded by the admin: HR's own logins are kept for the tests (5 per account per 15 minutes).
    const adminClient = testServer.createClient();
    await adminClient.login(ACCOUNTS.admin.email, PASSWORD);
    await onboardEmployee({ testServer, hrClient: adminClient, departmentId: departmentId.toString(), ...EMPLOYEE });
    await seedLeaveScenario(testServer, adminClient, departmentId.toString());
  } catch (seedingError) {
    await testServer.stop();
    await standIn.close();
    throw seedingError;
  }
  return async () => {
    await testServer.stop();
    await standIn.close();
  };
}
