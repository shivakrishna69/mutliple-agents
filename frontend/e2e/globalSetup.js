/**
 * Starts the real backend (backend/tests/integration/testServer.js) on a throwaway MongoDB
 * database, then creates the accounts and the department the tests use, and onboards employees
 * (HR invites, the employee accepts): one without an office for the workplace test, and a leave
 * scenario (an employee with an office, a manager and a Casual Leave balance) for the leave tests,
 * plus a second employee of that manager with Earned Leave that needs HR's approval too, and the
 * department's head, who manages its knowledge base; and for the Form 16 test a chartered accountant
 * and two employees, one above the annual CTC threshold and one exactly at it.
 * A stand-in AI service answers the leave assistant and NSK (e2e/standInAiService.js). Offboarding
 * documents are rendered with Playwright's own Chromium and stored in an S3 stand-in
 * (backend/tests/integration/s3StandIn.js), so an offboarding can run to its downloads. Returns the
 * teardown, which stops the backend and drops the database.
 *
 * Needs the backend's dependencies installed (cd backend && npm ci) and MongoDB reachable at
 * TEST_MONGO_URL (default mongodb://127.0.0.1:27017).
 */

import { chromium } from '@playwright/test';
import { onboardEmployee } from '../../backend/tests/integration/fixtures.js';
import { startS3StandIn } from '../../backend/tests/integration/s3StandIn.js';
import {
  endEmailCooldowns,
  insertConfirmedAccount,
  signUpAndConfirm,
  startTestServer,
} from '../../backend/tests/integration/testServer.js';
import { startStandInAiService } from './standInAiService.js';
import {
  ACCOUNTS,
  BACKEND_PORT,
  DEPARTMENT_NAME,
  EMPLOYEE,
  FORM16_ABOVE,
  FORM16_AT,
  FORM16_CA,
  FRONTEND_ORIGIN,
  KNOWLEDGE_ADMIN,
  KNOWLEDGE_HEAD,
  MAIL_INBOX_PORT,
  LEAVE_EMPLOYEE,
  LEAVE_EMPLOYEE_CASUAL_DAYS,
  LEAVE_MANAGER,
  OFFBOARD_EMPLOYEE,
  PASSWORD,
  RESET_ACCOUNT,
  TWO_STEP_EARNED_DAYS,
  TWO_STEP_EMPLOYEE,
  BRIEFING_EMPLOYEE,
  BRIEFING_EMPLOYEE_CASUAL_DAYS,
} from './environment.js';

/** Signs up and confirms the email from the emailed link, through the API. */
async function signUp(testServer, { name, email }) {
  await signUpAndConfirm(testServer, testServer.createClient(), { name, email, password: PASSWORD });
}

async function expectCreated(responsePromise, what) {
  const response = await responsePromise;
  if (response.status >= 300)
    throw new Error(`Seeding ${what} failed: ${response.status} ${JSON.stringify(response.body)}`);
  return response.body.data;
}

/**
 * The employees and manager for the leave tests, with an office open every day: a CL balance for
 * one, Earned Leave needing the manager's then HR's approval for another, and a CL balance for the
 * daily briefing test's employee.
 */
async function seedLeaveScenario(testServer, adminClient, departmentId) {
  const employee = await onboardEmployee({ testServer, hrClient: adminClient, departmentId, ...LEAVE_EMPLOYEE });
  const twoStepEmployee = await onboardEmployee({
    testServer,
    hrClient: adminClient,
    departmentId,
    ...TWO_STEP_EMPLOYEE,
  });
  const briefingEmployee = await onboardEmployee({
    testServer,
    hrClient: adminClient,
    departmentId,
    ...BRIEFING_EMPLOYEE,
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
  for (const { profileId } of [employee, twoStepEmployee, briefingEmployee]) {
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
  await expectCreated(
    adminClient.post('/api/leave/adjustments', {
      employeeId: briefingEmployee.profileId,
      leaveTypeId: leaveTypes.find((type) => type.code === 'CL').id,
      reasonCode: 'ENTITLEMENT_GRANT',
      days: BRIEFING_EMPLOYEE_CASUAL_DAYS,
      note: 'Balance for the daily briefing test',
    }),
    'the briefing leave balance',
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
  // The backend may call it while starting (its external knowledge cleanup), before testServer is set.
  let testServer;
  const s3 = await startS3StandIn();
  const standIn = await startStandInAiService({
    backendUrl: () => testServer?.baseUrl,
    internalApiKey: () => testServer?.internalApiKey,
  });
  try {
    testServer = await startTestServer({
      port: BACKEND_PORT,
      appOrigin: FRONTEND_ORIGIN,
      aiServiceUrl: standIn.url,
      // Email goes to a test inbox the specs read over HTTP, like a person reading their mail.
      mailHttpPort: MAIL_INBOX_PORT,
      environment: {
        ...s3.environmentFor('OFFBOARDING'),
        ...s3.environmentFor('TAX_DOCS'),
        PDF_BROWSER_EXECUTABLE_PATH: chromium.executablePath(),
        COMPANY_LEGAL_NAME: 'NSK Software Technologies Private Limited',
        COMPANY_REGISTERED_ADDRESS: '1 Test Road, Bengaluru 560001',
        // The Vite dev server is the one proxy in front of the backend, as nginx is when deployed: a
        // spec may then send its own X-Forwarded-For to keep its sign-ins out of the shared per-IP budget.
        TRUST_PROXY_HOPS: '1',
      },
    });
  } catch (startupError) {
    await standIn.close();
    await s3.close();
    throw startupError;
  }
  try {
    // Accounts with a role are written straight to the database with it (as scripts/setUserRole.js
    // would set it): signing up always creates an employee, and sign-ups are limited per network,
    // which the sign-up tests need for themselves.
    const roleAccounts = Object.values(ACCOUNTS).filter((listed) => listed.role);
    for (const account of [...roleAccounts, FORM16_CA]) await insertConfirmedAccount(testServer, account);
    for (const account of [
      ...Object.values(ACCOUNTS).filter((listed) => !roleAccounts.includes(listed)),
      RESET_ACCOUNT,
      KNOWLEDGE_ADMIN,
    ])
      await signUp(testServer, account);
    await testServer.database
      .collection('users')
      .updateOne({ email: KNOWLEDGE_ADMIN.email }, { $set: { role: 'admin' } });
    // Set up by the admin: HR's own logins are kept for the tests (5 per account per 15 minutes).
    const adminClient = testServer.createClient();
    await adminClient.login(ACCOUNTS.admin.email, PASSWORD);
    const { department } = await expectCreated(
      adminClient.post('/api/departments', { name: DEPARTMENT_NAME, code: 'ENG', budgetCode: 'CC-100' }),
      'the department',
    );
    await onboardEmployee({ testServer, hrClient: adminClient, departmentId: department.id, ...EMPLOYEE });
    await onboardEmployee({ testServer, hrClient: adminClient, departmentId: department.id, ...OFFBOARD_EMPLOYEE });
    await seedLeaveScenario(testServer, adminClient, department.id);
    // The Form 16 test's employees, either side of the threshold.
    for (const { annualCtc, ...person } of [FORM16_ABOVE, FORM16_AT]) {
      const { profileId } = await onboardEmployee({
        testServer,
        hrClient: adminClient,
        departmentId: department.id,
        ...person,
      });
      await expectCreated(
        adminClient.put(`/api/employees/${profileId}/compensation`, { annualCtc, effectiveFrom: null }),
        `the annual CTC of ${person.name}`,
      );
    }
    // The department's head, who manages its knowledge base from self-service.
    const head = await onboardEmployee({
      testServer,
      hrClient: adminClient,
      departmentId: department.id,
      ...KNOWLEDGE_HEAD,
    });
    await expectCreated(
      adminClient.patch(`/api/departments/${department.id}`, {
        departmentHeadId: head.profileId,
        version: department.version,
      }),
      'the department head',
    );
    // The tests read their own emails right away; a person would have waited the minute.
    await endEmailCooldowns(testServer);
  } catch (seedingError) {
    await testServer.stop();
    await standIn.close();
    await s3.close();
    throw seedingError;
  }
  return async () => {
    await testServer.stop();
    await standIn.close();
    await s3.close();
  };
}
