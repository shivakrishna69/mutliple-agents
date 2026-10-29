/**
 * Starts the real backend (backend/tests/integration/testServer.js) on a throwaway MongoDB
 * database, then creates the accounts and the department the tests use, and onboards one employee
 * (HR invites, the employee accepts) for the workplace and leave tests. Returns the teardown,
 * which stops the backend and drops the database.
 *
 * Needs the backend's dependencies installed (cd backend && npm ci) and MongoDB reachable at
 * TEST_MONGO_URL (default mongodb://127.0.0.1:27017).
 */

import { onboardEmployee } from '../../backend/tests/integration/fixtures.js';
import { startTestServer } from '../../backend/tests/integration/testServer.js';
import { ACCOUNTS, BACKEND_PORT, DEPARTMENT_NAME, EMPLOYEE, FRONTEND_ORIGIN, PASSWORD } from './environment.js';

async function signUp(testServer, { name, email }) {
  const client = testServer.createClient();
  const response = await client.signup(name, email, PASSWORD);
  if (response.status !== 201) {
    throw new Error(`Seeding ${email} failed: ${response.status} ${JSON.stringify(response.body)}`);
  }
}

export default async function globalSetup() {
  const testServer = await startTestServer({ port: BACKEND_PORT, appOrigin: FRONTEND_ORIGIN });
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
  } catch (seedingError) {
    await testServer.stop();
    throw seedingError;
  }
  return () => testServer.stop();
}
